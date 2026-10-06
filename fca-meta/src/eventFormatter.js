"use strict";

const { parseMessageIDTimestamp } = require("./utils");

function normalizeReactionKey(emoji) {
  return String(emoji == null ? "" : emoji).replace(/\uFE0F/g, "");
}

// Meta MessageRenderingType / admin message kinds. These are the values the
// Messenger backend puts in the message_rendering_type column for system
// ("admin") messages. They are mapped onto the fb-chat-api log:xxx event names.
const RENDERING_TYPE = {
  1: "log:subscribe",
  2: "log:unsubscribe",
  3: "log:thread-name",
  4: "log:thread-image",
  5: "log:thread-color",
  6: "log:thread-icon",
  7: "log:user-nickname",
  8: "log:thread-admins",
  9: "log:thread-call",
  10: "log:group-poll",
  20: "log:thread-approval-mode",
  21: "log:thread-join-requests",
};

class EventFormatter {
  constructor(client, options = {}) {
    this.client = client;
    this.selfListen = options.selfListen !== false;
    this.selfListenEvent = Boolean(options.selfListenEvent);
    this.listenEvents = options.listenEvents !== false;
    this.listenTyping = options.listenTyping !== false;
    this.updatePresence = Boolean(options.updatePresence);
    this.threads = new Map();
    this.contacts = new Map();
    this.userNames = new Map();
    this.messageAttachments = new Map();
    this.messageThreads = new Map();
    this.messageSenders = new Map();
    this.messageMentions = new Map();
    this.lastSeqId = null;
    this.syncToken = null;
    this._adminSnapshot = new Map();
    this._addedSnapshot = new Map();
    this.pendingAdminOps = new Map();
    this._seenMessages = new Map();
    this._seenReactions = new Map();
  }

  _isDuplicateMessage(messageID, kind) {
    if (!messageID) return false;
    const key = (kind || "message") + ":" + String(messageID);
    const now = Date.now();
    const last = this._seenMessages.get(key);
    if (last !== undefined && now - last < 60000) return true;
    this._seenMessages.set(key, now);
    if (this._seenMessages.size > 5000) {
      for (const [k, t] of this._seenMessages) {
        if (now - t > 600000) this._seenMessages.delete(k);
      }
    }
    return false;
  }

  _isDuplicateReaction(key) {
    if (!key) return false;
    const now = Date.now();
    const last = this._seenReactions.get(key);
    if (last !== undefined && now - last < 3000) return true;
    this._seenReactions.set(key, now);
    if (this._seenReactions.size > 2000) {
      for (const [k, t] of this._seenReactions) {
        if (now - t > 60000) this._seenReactions.delete(k);
      }
    }
    return false;
  }

  setUserName(userID, name) {
    if (userID === undefined || userID === null || !name) return;
    this.userNames.set(String(userID), String(name));
    const id = String(userID);
    const contact = this.contacts.get(id) || {};
    if (!contact.name) this.updateContact(id, Object.assign({}, contact, { userID: id, name: String(name) }));
  }

  queueAdminOp(threadID, type, extra = {}) {
    if (!threadID || !type) return;
    const key = String(threadID);
    if (!this.pendingAdminOps.has(key)) this.pendingAdminOps.set(key, []);
    const list = this.pendingAdminOps.get(key);
    list.push(Object.assign({ type, at: Date.now() }, extra));
    if (list.length > 20) list.splice(0, list.length - 20);
  }

  get selfUserID() {
    if (this.client && this.client.getCurrentUserID) {
      const id = this.client.getCurrentUserID();
      if (id) return id;
    }
    return "0";
  }

  updateThreadMeta(threadKey, patch) {
    const existing = this.threads.get(String(threadKey)) || { threadID: String(threadKey) };
    Object.assign(existing, patch);
    this.threads.set(String(threadKey), existing);
  }

  updateContact(contactID, patch) {
    const existing = this.contacts.get(String(contactID)) || {};
    Object.assign(existing, patch);
    this.contacts.set(String(contactID), existing);
  }

  getThreadMeta(threadKey) {
    return this.threads.get(String(threadKey)) || {};
  }

  getContact(contactID) {
    return this.contacts.get(String(contactID)) || {};
  }

  _threadForMessage(messageID) {
    if (!messageID) return "";
    return this.messageThreads.get(String(messageID)) || "";
  }

  // --- Main dispatch ------------------------------------------------------

  processTable(table) {
    if (!table) return [];
    const events = [];
    this._snapshotThreadState(table);
    this.absorb(table);

    for (const msg of [...(table.LSUpsertMessage || []), ...(table.LSInsertMessage || []), ...(table.LSDeleteThenInsertMessage || [])]) {
      if (msg.IsUnsent) continue;
      if (this._isDuplicateMessage(msg.MessageId, "message")) continue;
      const evt = this.formatMessage(msg);
      if (evt) events.push(evt);
    }
    for (const del of table.LSDeleteMessage || []) {
      if (this._isDuplicateMessage(del.MessageId, "unsend")) continue;
      events.push({
        type: "message_unsend",
        threadID: String(del.ThreadKey),
        messageID: del.MessageId,
        senderID: String(this.messageSenders.get(String(del.MessageId)) || this.selfUserID),
        deletionTimestamp: Date.now(),
        timestamp: Date.now(),
      });
    }
    for (const del of table.LSDeleteThenInsertMessage || []) {
      if (del.IsUnsent) {
        events.push({
          type: "message_unsend",
          threadID: String(del.ThreadKey),
          messageID: del.MessageId,
          senderID: String(del.SenderId),
          deletionTimestamp: del.UnsentTimestampMs || Date.now(),
          timestamp: del.TimestampMs || del.UnsentTimestampMs || Date.now(),
        });
      }
    }
    for (const edit of table.LSEditMessage || []) {
      const threadID = this._threadForMessage(edit.MessageID);
      events.push({
        type: "message_edit",
        threadID,
        messageID: edit.MessageID,
        body: edit.Text,
        timestamp: Date.now(),
      });
    }
    for (const typ of table.LSUpdateTypingIndicator || []) {
      events.push({
        type: "typ",
        isTyping: Boolean(typ.IsTyping),
        from: String(typ.SenderId),
        userID: String(typ.SenderId),
        threadID: String(typ.ThreadKey),
        fromMobile: false,
      });
    }
    for (const rcpt of table.LSUpdateReadReceipt || []) {
      events.push({
        type: "read_receipt",
        reader: String(rcpt.ContactId),
        time: rcpt.ReadActionTimestampMs || rcpt.ReadWatermarkTimestampMs,
        threadID: String(rcpt.ThreadKey),
      });
    }
    for (const dr of table.LSUpdateDeliveryReceipt || []) {
      events.push({
        type: "delivery_receipt",
        recipient: String(dr.ContactId),
        time: dr.DeliveredWatermarkTimestampMs,
        threadID: String(dr.ThreadKey),
      });
    }
    for (const presence of table.LSDeleteThenInsertContactPresence || []) {
      if (!this.updatePresence) continue;
      events.push({
        type: "presence",
        userID: String(presence.ContactId),
        statuses: presence.Status,
        timestamp: presence.LastActiveTimestampMs || Date.now(),
      });
    }
    for (const reaction of table.LSUpsertReaction || []) {
      if (this._isDuplicateReaction(`${reaction.ThreadKey}|${reaction.MessageId}|${reaction.ActorId}|${normalizeReactionKey(reaction.Reaction)}`)) continue;
      events.push({
        type: "message_reaction",
        threadID: String(reaction.ThreadKey),
        messageID: reaction.MessageId,
        reaction: reaction.Reaction,
        senderID: String(reaction.ActorId),
        userID: String(reaction.ActorId),
        offlineThreadingID: "",
        timestamp: reaction.TimestampMs || Date.now(),
      });
    }
    for (const reaction of table.LSDeleteReaction || []) {
      if (this._isDuplicateReaction(`${reaction.ThreadKey}|${reaction.MessageId}|${reaction.ActorId}|del`)) continue;
      events.push({
        type: "message_reaction",
        threadID: String(reaction.ThreadKey),
        messageID: reaction.MessageId,
        reaction: "",
        senderID: String(reaction.ActorId),
        userID: String(reaction.ActorId),
        timestamp: Date.now(),
      });
    }
    for (const reaction of table.LSUpdateOrInsertReactionV2 || []) {
      if (!reaction.ViewerIsReactor) continue;
      if (this._isDuplicateReaction(`${reaction.ThreadKey}|${reaction.MessageID}|${this.selfUserID}|${normalizeReactionKey(reaction.ReactionLiteral)}`)) continue;
      events.push({
        type: "message_reaction",
        threadID: String(reaction.ThreadKey),
        messageID: reaction.MessageID,
        reaction: reaction.ReactionLiteral,
        senderID: this.selfUserID,
        userID: this.selfUserID,
        timestamp: reaction.LastUpdatedTimestampMS || Date.now(),
      });
    }
    for (const reaction of table.LSDeleteReactionV2 || []) {
      if (this._isDuplicateReaction(`${reaction.ThreadKey}|${reaction.MessageID}|${this.selfUserID}|del`)) continue;
      events.push({
        type: "message_reaction",
        threadID: String(reaction.ThreadKey),
        messageID: reaction.MessageID,
        reaction: "",
        senderID: this.selfUserID,
        userID: this.selfUserID,
        timestamp: reaction.LastUpdatedTimestampMS || Date.now(),
      });
    }
    for (const event of this._formatThreadEvents(table)) events.push(event);
    return events;
  }

  absorb(table) {
    this._absorbAttachments(table);
    this._absorbThreads(table);
    this._absorbContacts(table);
  }

  _snapshotThreadState(table) {
    const threadKeys = new Set();
    const noteThread = (key) => {
      if (key !== undefined && key !== null) threadKeys.add(String(key));
    };
    for (const list of [table.LSDeleteThenInsertThread, table.LSUpdateOrInsertThread, table.LSVerifyThreadExists]) {
      for (const thread of list || []) noteThread(thread && thread.ThreadKey);
    }
    for (const list of [table.LSAddParticipantIdToGroupThread, table.LSUpdateThreadParticipantAdminStatus, table.LSRemoveParticipantFromThread]) {
      for (const p of list || []) noteThread(p && p.ThreadKey);
    }
    for (const msg of [...(table.LSUpsertMessage || []), ...(table.LSInsertMessage || []), ...(table.LSDeleteThenInsertMessage || [])]) {
      noteThread(msg && msg.ThreadKey);
    }
    this._adminSnapshot = new Map();
    this._addedSnapshot = new Map();
    for (const key of threadKeys) {
      const meta = this.threads.get(key);
      this._adminSnapshot.set(key, meta && meta.adminIDs ? meta.adminIDs.slice() : []);
    }
    for (const p of table.LSAddParticipantIdToGroupThread || []) {
      if (!p || p.ThreadKey === undefined) continue;
      const key = String(p.ThreadKey);
      if (!this._addedSnapshot.has(key)) this._addedSnapshot.set(key, []);
      this._addedSnapshot.get(key).push(String(p.ContactId));
    }
  }

  _absorbAttachments(table) {
    const groups = [
      [table.LSInsertAttachment, "media"],
      [table.LSInsertBlobAttachment, "blob"],
      [table.LSInsertXmaAttachment, "xma"],
      [table.LSInsertStickerAttachment, "sticker"],
    ];
    const large = new Map();
    for (const extra of table.LSUpdateExtraAttachmentColumns || []) {
      if (extra.AttachmentFBID) large.set(String(extra.AttachmentFBID), extra);
    }
    for (const [list, kind] of groups) {
      for (const att of list || []) {
        if (!att.MessageId) continue;
        const key = String(att.MessageId);
        if (!this.messageAttachments.has(key)) this.messageAttachments.set(key, []);
        const formatted = this._formatAttachment(att, kind);
        const extra = att.AttachmentFbid ? large.get(String(att.AttachmentFbid)) : null;
        if (extra) {
          if (extra.PreviewURLLarge) formatted.largePreviewUrl = extra.PreviewURLLarge;
          if (extra.PreviewWidthLarge) formatted.largePreviewWidth = extra.PreviewWidthLarge;
          if (extra.PreviewHeightLarge) formatted.largePreviewHeight = extra.PreviewHeightLarge;
        }
        this.messageAttachments.get(key).push(formatted);
      }
    }
  }

  _attachmentType(att, kind) {
    const code = att.AttachmentType || 0;
    if (code === 1) return "sticker";
    if (code === 2 || code === 8) return "photo";
    if (code === 3) return "animated_image";
    if (code === 4 || code === 9) return "video";
    if (code === 5 || code === 12) return "audio";
    if (code === 6) return "file";
    if (code === 7 || code === 13) return "share";
    if (code === 10 || code === 14 || code === 15) return "sticker";
    if (kind === "sticker") return "sticker";
    if (kind === "xma") return "share";
    const mime = String(att.AttachmentMimeType || att.PlayableUrlMimeType || "");
    if (mime.startsWith("image/gif")) return "animated_image";
    if (mime.startsWith("image/")) return "photo";
    if (mime.startsWith("video/")) return "video";
    if (mime.startsWith("audio/")) return "audio";
    return "file";
  }

  _formatAttachment(att, kind) {
    const type = this._attachmentType(att, kind);
    if (type === "sticker") {
      return {
        type: "sticker",
        ID: att.AttachmentFbid,
        url: att.PlayableUrl || att.ImageUrl,
        previewUrl: att.PreviewUrl,
        largePreviewUrl: att.ImageUrl,
        width: att.PreviewWidth,
        height: att.PreviewHeight,
        stickerID: att.AttachmentFbid,
        packID: att.PackId || null,
        spriteUrl: att.SpriteImage || att.ImageUrl,
        spriteUrl2x: att.SpriteImage2x || att.ImageUrl,
      };
    }
    if (type === "share") {
      return {
        type: "share",
        ID: att.AttachmentFbid,
        url: att.ActionUrl || att.PlayableUrl,
        title: att.TitleText,
        description: att.DescriptionText || att.SubtitleText,
        source: att.SourceText,
        image: att.ImageUrl || att.PreviewUrl,
        width: att.PreviewWidth,
        height: att.PreviewHeight,
        playable: Boolean(att.PlayableUrl),
        playableUrl: att.PlayableUrl,
        duration: att.PlayableDurationMs,
        subattachments: [],
        properties: {},
      };
    }
    return {
      type,
      ID: att.AttachmentFbid,
      filename: att.Filename,
      fullFileName: att.Filename,
      name: att.Filename,
      size: att.Filesize,
      fileSize: att.Filesize,
      url: att.PlayableUrl || att.PreviewUrl || att.ImageUrl,
      previewUrl: att.PreviewUrl || att.ImageUrl,
      largePreviewUrl: att.PreviewUrlLarge || att.ImageUrl,
      thumbnailUrl: att.PreviewUrl || att.ImageUrl,
      width: att.PreviewWidth,
      height: att.PreviewHeight,
      previewWidth: att.PreviewWidth,
      previewHeight: att.PreviewHeight,
      mimeType: att.AttachmentMimeType || att.PlayableUrlMimeType,
      duration: att.PlayableDurationMs,
    };
  }

  _replyAttachments(msg) {
    const cached = this.messageAttachments.get(String(msg.ReplySourceId));
    if (cached && cached.length) return cached.slice();
    const type = Number(msg.ReplyAttachmentType || 0);
    const url = msg.ReplyMediaUrl || msg.ReplyMediaUrlFallback || "";
    const previewUrl = msg.ReplyMediaUrlFallback || msg.ReplyMediaUrl || "";
    if (type === 1) {
      return [{
        type: "sticker",
        ID: msg.ReplyAttachmentId,
        url,
        previewUrl,
        stickerID: msg.ReplyAttachmentId,
        packID: null,
      }];
    }
    if (!type && !url) return [];
    const kind = this._attachmentType({ AttachmentType: type, AttachmentMimeType: msg.ReplyMediaUrlMimeType }, "");
    const attachment = {
      type: kind,
      ID: msg.ReplyAttachmentId,
      url,
      previewUrl,
      width: msg.ReplyMediaPreviewWidth,
      height: msg.ReplyMediaPreviewHeight,
    };
    if (kind === "audio" || kind === "video") attachment.duration = msg.ReplyMediaUnknownTimestampS;
    if (kind === "share") attachment.title = msg.ReplySnippet;
    return [attachment];
  }

  _absorbThreads(table) {
    const lists = [
      table.LSDeleteThenInsertThread,
      table.LSUpdateOrInsertThread,
      table.LSVerifyThreadExists,
    ];
    for (const list of lists) {
      for (const thread of list || []) {
        if (!thread || thread.ThreadKey === undefined) continue;
        this.updateThreadMeta(thread.ThreadKey, {
          threadID: String(thread.ThreadKey),
          name: thread.ThreadName,
          snippet: thread.Snippet,
          imageSrc: thread.ThreadPictureUrl,
          isGroup: (thread.ThreadType || 1) === 2,
          lastActivityTimestamp: thread.LastActivityTimestampMs,
          lastReadTimestamp: thread.LastReadWatermarkTimestampMs,
          memberCount: thread.MemberCount,
        });
      }
    }
    for (const p of table.LSAddParticipantIdToGroupThread || []) {
      const meta = this.getThreadMeta(p.ThreadKey);
      const participants = meta.participantIDs ? meta.participantIDs.slice() : [];
      if (!participants.includes(String(p.ContactId))) participants.push(String(p.ContactId));
      const nicknames = Object.assign({}, meta.nicknames || {});
      if (p.Nickname) nicknames[String(p.ContactId)] = p.Nickname;
      const adminIDs = meta.adminIDs ? meta.adminIDs.slice() : [];
      if ((p.IsAdmin || p.IsSuperAdmin) && !adminIDs.includes(String(p.ContactId))) {
        adminIDs.push(String(p.ContactId));
      }
      this.updateThreadMeta(p.ThreadKey, { participantIDs: participants, nicknames, adminIDs });
    }
    for (const p of table.LSUpdateThreadParticipantAdminStatus || []) {
      const meta = this.getThreadMeta(p.ThreadKey);
      const adminIDs = meta.adminIDs ? meta.adminIDs.slice() : [];
      const id = String(p.ContactId);
      const idx = adminIDs.indexOf(id);
      if (p.IsAdmin && idx === -1) adminIDs.push(id);
      else if (!p.IsAdmin && idx !== -1) adminIDs.splice(idx, 1);
      this.updateThreadMeta(p.ThreadKey, { adminIDs });
    }
    for (const p of table.LSRemoveParticipantFromThread || []) {
      const meta = this.getThreadMeta(p.ThreadKey);
      const participants = (meta.participantIDs || []).filter((id) => String(id) !== String(p.ParticipantId));
      const adminIDs = (meta.adminIDs || []).filter((id) => String(id) !== String(p.ParticipantId));
      this.updateThreadMeta(p.ThreadKey, { participantIDs: participants, adminIDs });
    }
  }

  _absorbContacts(table) {
    for (const list of [table.LSVerifyContactRowExists, table.LSDeleteThenInsertContact]) {
      for (const contact of list || []) {
        const id = contact.ContactId !== undefined ? contact.ContactId : contact.Id;
        if (id === undefined) continue;
        this.updateContact(id, {
          userID: String(id),
          name: contact.Name,
          firstName: contact.FirstName,
          vanity: contact.SecondaryName || contact.Username,
          thumbSrc: contact.ProfilePictureUrl || contact.ProfilePictureLargeUrl,
          profileUrl: `https://www.facebook.com/profile.php?id=${id}`,
          gender: contact.Gender,
        });
      }
    }
    for (const p of table.LSAddParticipantIdToGroupThread || []) {
      if (!p.Nickname) continue;
      const contact = this.contacts.get(String(p.ContactId)) || {};
      this.updateContact(p.ContactId, Object.assign({}, contact, { userID: String(p.ContactId), nickname: p.Nickname }));
    }
  }

  _formatThreadEvents(table) {
    const events = [];
    for (const thread of table.LSDeleteThenInsertThread || []) {
      if (!thread || !thread.IsAdminSnippet) continue;
      // Admin snippets are handled through messages; skip to avoid duplicates.
    }
    return events;
  }

  // --- Message formatting -------------------------------------------------

  formatMessage(msg) {
    if (!msg) return null;
    const threadID = String(msg.ThreadKey);
    const senderID = String(msg.SenderId || 0);
    const selfID = this.selfUserID;
    if (!msg.IsAdminMessage && !this.selfListen && senderID === selfID) return null;

    const meta = this.getThreadMeta(threadID);
    const participantIDs = meta.participantIDs || [];
    const isGroup = meta.isGroup !== undefined ? meta.isGroup : threadID.length > 15;
    const attachments = this.messageAttachments.get(String(msg.MessageId)) || [];
    if (msg.MessageId) {
      this.messageThreads.set(String(msg.MessageId), threadID);
      this.messageSenders.set(String(msg.MessageId), senderID);
    }

    if (msg.IsAdminMessage) {
      if (!this.listenEvents) return null;
      if (!this.selfListenEvent && senderID === selfID) return null;
      return this.formatAdminMessage(msg, threadID, attachments);
    }

    const body = msg.Text || "";
    const event = {
      type: "message",
      senderID,
      body,
      threadID,
      messageID: msg.MessageId,
      attachments,
      mentions: this._parseMentions(msg),
      timestamp: msg.TimestampMs || parseMessageIDTimestamp(msg.MessageId) || Date.now(),
      isGroup,
      participantIDs,
      reactions: [],
      offlineThreadingID: msg.OfflineThreadingId,
    };

    if (msg.ReplySourceId) {
      event.type = "message_reply";
      event.messageReply = {
        senderID: String(msg.ReplyToUserId || ""),
        body: msg.ReplyMessageText || msg.ReplySnippet || "",
        threadID,
        messageID: msg.ReplySourceId,
        isGroup,
        attachments: this._replyAttachments(msg),
        mentions: {},
        timestamp: msg.ReplySourceTimestampMs || 0,
      };
    }
    return event;
  }

  _parseMentions(msg) {
    const mentions = {};
    if (!msg.MentionIds) return mentions;
    const ids = String(msg.MentionIds).split(",");
    const offsets = String(msg.MentionOffsets || "").split(",");
    const lengths = String(msg.MentionLengths || "").split(",");
    for (let i = 0; i < ids.length; i++) {
      const id = ids[i];
      if (!id) continue;
      const offset = parseInt(offsets[i], 10) || 0;
      const length = parseInt(lengths[i], 10) || 0;
      mentions[id] = (msg.Text || "").substring(offset, offset + length);
    }
    return mentions;
  }

  formatAdminMessage(msg, threadID, attachments) {
    const meta = this.getThreadMeta(threadID);
    const participantIDs = meta.participantIDs || [];
    const isGroup = meta.isGroup !== undefined ? meta.isGroup : threadID.length > 15;
    const rendering = msg.MessageRenderingType || 0;
    let logMessageType = RENDERING_TYPE[rendering] || this._classifyAdminText(msg.Text);
    let pending = null;
    if (logMessageType) {
      pending = this._takeAdminOp(threadID, logMessageType);
    } else {
      pending = this._takeAdminOp(threadID, null);
      if (pending) logMessageType = pending.type;
    }
    logMessageType = logMessageType || "log:unknown";
    const logMessageData = {};
    const textIDs = this._extractIDs(msg.Text);
    const mentionIDs = msg.MentionIds ? String(msg.MentionIds).split(",").map((v) => v.trim()).filter(Boolean) : [];
    const knownAdmins = this._adminSnapshot.get(threadID) || meta.adminIDs || [];

    switch (logMessageType) {
      case "log:thread-name":
        logMessageData.name = (pending && pending.title) || this._grab(msg.Text, /named the group (.+?)\.?$/i) || msg.Text;
        break;
      case "log:thread-image":
        logMessageData.url = (attachments[0] && attachments[0].url) || (pending && pending.url) || meta.imageSrc || "";
        break;
      case "log:thread-icon": {
        const trailing = String(msg.Text || "").trim().replace(/[.!]+$/, "").split(/\s+/).pop() || "";
        const emoji = (pending && pending.emoji) || trailing;
        logMessageData.thread_icon = emoji;
        logMessageData.thread_icon_url = this._emojiUrl(emoji);
        logMessageData.thread_icon_id = emoji ? emoji.codePointAt(0) : null;
        break;
      }
      case "log:thread-color":
        logMessageData.theme_id = pending && pending.themeId ? pending.themeId : null;
        logMessageData.theme_color = pending && pending.themeColor ? pending.themeColor : null;
        logMessageData.theme_emoji = (pending && pending.themeEmoji) || null;
        logMessageData.theme_name_with_subtitle = (pending && pending.themeName) || null;
        if (pending && pending.themeColor !== undefined) logMessageData.color = pending.themeColor;
        break;
      case "log:user-nickname": {
        const targetName = this._extractParticipantName(msg.Text, ["set the nickname for", "changed the nickname for", "set the nickname of", "changed the nickname of", "removed the nickname for"]);
        const resolved = this._resolveName(threadID, targetName, pending && pending.participantID);
        logMessageData.nickname = (pending && pending.nickname) || this._grab(msg.Text, /nickname (?:for|of) .+? to (.+?)\.?$/i) || "";
        logMessageData.participant_id = resolved.id || mentionIDs[0] || textIDs[0] || "";
        logMessageData.participant_name = resolved.name;
        break;
      }
      case "log:thread-admins": {
        const targetName = this._extractParticipantName(msg.Text, ["added", "removed", "made"]);
        const resolved = this._resolveName(threadID, targetName, pending && pending.targetID);
        const targetID = resolved.id || mentionIDs[0] || textIDs[0] || String(msg.SenderId || "");
        logMessageData.TARGET_ID = targetID;
        logMessageData.THREAD_CATEGORY = isGroup ? "GROUP" : "ONE_TO_ONE";
        if (pending && pending.isAdmin !== undefined) {
          logMessageData.ADMIN_EVENT = pending.isAdmin ? "add_admin" : "remove_admin";
        } else if (/remov|no longer|dismiss|revok/i.test(msg.Text)) {
          logMessageData.ADMIN_EVENT = "remove_admin";
        } else {
          logMessageData.ADMIN_EVENT = knownAdmins.includes(String(targetID)) ? "remove_admin" : "add_admin";
        }
        logMessageData.participant_name = resolved.name;
        break;
      }
      case "log:subscribe":
        logMessageData.addedParticipants = this._addedParticipants(threadID, textIDs, msg, pending);
        break;
      case "log:unsubscribe": {
        const targetName = this._extractParticipantName(msg.Text, ["removed", "left"]);
        const resolved = this._resolveName(threadID, targetName, pending && pending.participantID);
        logMessageData.leftParticipantFbId = resolved.id || mentionIDs[0] || textIDs[0] || "";
        logMessageData.participant_name = resolved.name;
        break;
      }
      default:
        logMessageData.text = msg.Text;
        break;
    }

    return {
      type: "event",
      threadID,
      messageID: msg.MessageId,
      senderID: String(msg.SenderId || ""),
      body: msg.Text || "",
      logMessageType,
      logMessageData,
      logMessageBody: msg.Text,
      timestamp: msg.TimestampMs || Date.now(),
      author: String(msg.SenderId || ""),
      isGroup,
      participantIDs,
      isAdminSnippet: true,
      isAdminMessage: true,
      messageRenderingType: rendering,
      adminMsgCtaId: msg.AdminMsgCtaId,
      adminMsgCtaTitle: msg.AdminMsgCtaTitle,
      adminMsgCtaType: msg.AdminMsgCtaType,
    };
  }

  _pendingType(pending) {
    if (!pending) return "";
    if (pending.type && pending.type.startsWith("log:")) return pending.type;
    return "";
  }

  _takeAdminOp(threadID, type) {
    const list = this.pendingAdminOps.get(String(threadID));
    if (!list || !list.length) return null;
    const now = Date.now();
    while (list.length && now - list[0].at > 60000) list.shift();
    if (!list.length) return null;
    let idx = 0;
    if (type) {
      idx = list.findIndex((entry) => entry.type === type);
      if (idx === -1) return null;
    }
    return list.splice(idx, 1)[0];
  }

  _classifyAdminText(text) {
    const t = String(text || "").toLowerCase();
    if (/(named the group|named this group|named the chat|renamed the group|changed the group name|changed the name of the group|changed the subject|set the group name|changed the group's name)/.test(t)) return "log:thread-name";
    if (/(group photo|group picture|thread photo|thread picture|group image|changed the photo|changed the picture|removed the group photo|removed the group picture)/.test(t)) return "log:thread-image";
    if (/(quick reaction|emoji for the group|emoji for this group|thread emoji|group emoji set|set the emoji|changed the emoji|group's emoji|emoji in this|emoji for this chat)/.test(t)) return "log:thread-icon";
    if (/(changed the theme|set the theme|theme to|changed the chat theme|changed this conversation's theme|changed the color|color of the chat|changed the conversation color)/.test(t)) return "log:thread-color";
    if (/(as a group admin|as an admin|as group admin|from admin|made .* an admin|no longer an admin|removed as admin|added as an admin)/.test(t)) return "log:thread-admins";
    if (/(set the nickname|changed the nickname|nickname for|nickname of|removed the nickname)/.test(t)) return "log:user-nickname";
    if (/(added .* to the group|added .* to the chat|added .* to this group|added .* to the conversation|added you to the group|joined the group|joined the chat)/.test(t)) return "log:subscribe";
    if (/(removed .* from the group|removed .* from the chat|removed .* from this group|removed .* from the conversation|left the group|left the chat|left this group)/.test(t)) return "log:unsubscribe";
    if (/(created a poll|changed the poll|group poll)/.test(t)) return "log:thread-poll";
    if (/(approval mode|changed the approval)/.test(t)) return "log:thread-approval-mode";
    if (/(joinable|group link|invite link|link mode)/.test(t)) return "log:link-status";
    if (/(started a call|video call|voice call|call ended|missed call|started the call)/.test(t)) return "log:thread-call";
    if (/unpinned a message/.test(t)) return "log:unpin-message";
    if (/pinned a message/.test(t)) return "log:thread-pinned";
    return "";
  }

  _grab(text, re) {
    const m = re.exec(String(text || ""));
    return m ? String(m[1]).trim() : "";
  }

  _extractParticipantName(text, verbs) {
    const v = verbs.map((x) => x.replace(/ /g, "\\s+")).join("|");
    const m = new RegExp("(?:" + v + ")\\s+(.+?)(?:\\s+(?:to|from|into|as)\\s|$)", "i").exec(String(text || ""));
    return m ? m[1].replace(/[.,!]+$/, "").trim() : "";
  }

  _nameOf(userID) {
    if (userID === undefined || userID === null || userID === "") return "";
    const id = String(userID);
    if (this.userNames.has(id)) return this.userNames.get(id);
    const contact = this.contacts.get(id);
    return (contact && contact.name) || "";
  }

  _nameMatches(candidate, key) {
    const c = String(candidate).trim().toLowerCase();
    const k = String(key).trim().toLowerCase();
    if (!c || !k) return false;
    if (c === k) return true;
    if (k.length >= 4 && c.startsWith(k)) return true;
    if (c.length >= 4 && k.startsWith(c)) return true;
    return false;
  }

  _resolveName(threadID, name, hintID) {
    if (hintID) {
      const id = String(hintID);
      return { id, name: this._nameOf(id) || String(name || "") };
    }
    if (!name) return { id: "", name: "" };
    const key = String(name).trim();
    const meta = this.getThreadMeta(threadID);
    for (const id of meta.participantIDs || []) {
      const candidate = this._nameOf(id);
      if (candidate && this._nameMatches(candidate, key)) return { id: String(id), name: candidate };
    }
    for (const [id, candidate] of this.userNames) if (this._nameMatches(candidate, key)) return { id: String(id), name: candidate };
    for (const [id, contact] of this.contacts) if (contact.name && this._nameMatches(contact.name, key)) return { id: String(id), name: contact.name };
    return { id: "", name: key };
  }

  _emojiUrl(emoji) {
    const cp = emoji && emoji.codePointAt(0);
    return cp ? "https://static.xx.fbcdn.net/images/emoji.php/v9/t3c/1/16/" + cp.toString(16) + ".png" : null;
  }

  _extractIDs(text) {
    if (!text) return [];
    const matches = String(text).match(/\d{5,}/g);
    return matches ? [...new Set(matches)] : [];
  }

  _addedParticipants(threadID, textIDs, msg, pending) {
    const selfID = this.selfUserID;
    let ids = [];
    let names = [];
    if (pending && Array.isArray(pending.participantIDs) && pending.participantIDs.length) {
      ids = pending.participantIDs.map(String);
      names = (pending.participantNames || []).map(String);
    } else if (msg && msg.MentionIds) {
      ids = String(msg.MentionIds).split(",").map((v) => v.trim()).filter(Boolean);
    } else {
      const targetName = this._extractParticipantName(msg && msg.Text, ["added"]);
      if (targetName) {
        const resolved = this._resolveName(threadID, targetName, null);
        if (resolved.id) ids = [resolved.id];
      }
    }
    if (!ids.length) ids = textIDs && textIDs.length ? textIDs : [];
    if (!ids.length) ids = this._addedSnapshot.get(String(threadID)) || [];
    if (!ids.length) {
      const meta = this.getThreadMeta(threadID);
      ids = (meta.participantIDs || []).filter((id) => String(id) !== selfID);
    }
    ids = [...new Set(ids)];
    return ids.map((id, index) => {
      const contact = this.getContact(id);
      const fullName = contact.name || this._nameOf(id) || names[index] || "";
      return {
        userFbId: String(id),
        fullName,
      };
    });
  }
}

module.exports = { EventFormatter, RENDERING_TYPE };
