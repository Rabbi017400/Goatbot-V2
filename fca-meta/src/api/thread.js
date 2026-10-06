"use strict";

const { getType, toBigOrNumber } = require("../utils");
const {
  fetchThreadsTask,
  markReadTask,
  muteThreadTask,
  renameThreadTask,
  setThreadImageTask,
  updateAdminTask,
  addParticipantsTask,
  removeParticipantTask,
  deleteThreadTask,
  createThreadTask,
  acceptMessageRequestTask,
  fetchAdditionalThreadDataTask,
  typingTask,
  nicknameTask,
  threadColorTask,
  threadEmojiTask,
} = require("../tasks");
const { parsePublishResponse } = require("./decode");

function folderNameToFolder(folderName) {
  const map = { inbox: "INBOX", pending: "PENDING", archived: "ARCHIVED", spam: "SPAM", other: "OTHER" };
  return map[String(folderName || "").toLowerCase()] || String(folderName || "").toUpperCase() || "INBOX";
}

function normalizeFolders(tags) {
  if (tags === undefined || tags === null) return null;
  const list = getType(tags) === "Array" ? tags : [tags];
  const folders = new Set();
  for (const tag of list) {
    const raw = String(tag || "").trim();
    if (raw === "") return null;
    folders.add(folderNameToFolder(raw.toLowerCase()));
  }
  return folders.size ? folders : null;
}

function noteAdminOp(client, threadID, type, extra) {
  if (client && client.formatter && typeof client.formatter.queueAdminOp === "function") {
    client.formatter.queueAdminOp(threadID, type, extra || {});
  }
}

function resolveCreatedThreadID(response, optimisticID) {
  let table;
  try { table = parsePublishResponse(response); } catch (_) { return ""; }
  const replaced = table.LSReplaceOptimisticThread || [];
  for (const entry of replaced) {
    const keys = [entry.ThreadKey1, entry.ThreadKey2, entry.ThreadKey];
    if (keys.some((key) => key !== undefined && key !== null && String(key) === String(optimisticID))) {
      const other = keys.find((key) => key !== undefined && key !== null && String(key) !== String(optimisticID));
      if (other !== undefined && other !== null) return String(other);
    }
  }
  const updates = table.LSUpdateTaskValue || [];
  for (const entry of updates) {
    if (String(entry.TaskValue1) === String(optimisticID) && entry.TaskValue2) return String(entry.TaskValue2);
    if (String(entry.TaskValue2) === String(optimisticID) && entry.TaskValue1) return String(entry.TaskValue1);
  }
  const threads = [...(table.LSDeleteThenInsertThread || []), ...(table.LSUpdateOrInsertThread || [])];
  const found = threads.find((thread) => thread && thread.ThreadKey);
  return found ? String(found.ThreadKey) : "";
}

function threadToInfo(client, thread, formatter) {
  const meta = formatter ? formatter.getThreadMeta(thread.ThreadKey) : {};
  const participantIDs = meta.participantIDs || [];
  const userInfo = meta.userInfo || participantIDs.map((id) => {
    const c = formatter ? formatter.getContact(id) : {};
    return {
      id: String(id),
      name: c.name || "",
      firstName: c.firstName || "",
      vanity: c.vanity || "",
      url: c.profileUrl || `https://www.facebook.com/profile.php?id=${id}`,
      thumbSrc: c.thumbSrc || "",
      profileUrl: c.profileUrl || `https://www.facebook.com/profile.php?id=${id}`,
      gender: c.gender || 0,
      type: "user",
      isFriend: false,
      isBirthday: false,
    };
  });
  const nicknames = Object.assign({}, meta.nicknames || {});
  const adminIDs = (meta.adminIDs || []).map((id) => ({ id: String(id) }));
  const isGroup = (thread.ThreadType || 1) === 2 || String(thread.ThreadKey).length > 15;
  const info = {
    threadID: String(thread.ThreadKey),
    threadName: thread.ThreadName || "",
    participantIDs,
    userInfo,
    unreadCount: thread.UnreadMessageCount || 0,
    messageCount: thread.MessageCount || 0,
    timestamp: thread.LastActivityTimestampMs || 0,
    muteUntil: thread.MuteExpireTimeMs || 0,
    isGroup,
    threadType: isGroup ? 2 : 1,
    isSubscribed: true,
    folder: folderNameToFolder(thread.FolderName),
    isArchived: String(thread.FolderName || "").toLowerCase() === "archived",
    snippet: thread.Snippet || "",
    snippetHasAttachment: false,
    snippetSender: String(thread.SnippetSenderContactId || ""),
    lastMessageTimestamp: thread.LastActivityTimestampMs || 0,
    lastReadTimestamp: thread.LastReadWatermarkTimestampMs || 0,
    lastMessageType: "message",
    imageSrc: thread.ThreadPictureUrl || "",
    emoji: thread.CustomEmoji || "",
    color: thread.OutgoingBubbleColor || "",
    threadTheme: { id: thread.ThemeFbid || thread.ThreadThemeId || null },
    nicknames,
    adminIDs,
    approvalMode: Boolean(thread.NeedsAdminApprovalForNewParticipant),
    approvalQueue: [],
    cannotReplyReason: thread.CannotReplyReason !== undefined ? thread.CannotReplyReason : null,
    eventReminders: [],
    reactionsMuteMode: String(thread.ReactionsMuteMode || "reactions_mute_mode").toLowerCase(),
    mentionsMuteMode: String(thread.MentionsMuteMode || "mentions_mute_mode").toLowerCase(),
    isPinProtected: Boolean(thread.IsPinProtected),
    relatedPageThread: thread.RelatedPageThread || null,
    name: thread.ThreadName || "",
    snippetAttachments: [],
    serverTimestamp: thread.LastActivityTimestampMs || 0,
    isCanonicalUser: !isGroup,
    isCanonical: !isGroup,
    recipientsLoadable: true,
    hasEmailParticipant: false,
    readOnly: false,
    canReply: thread.CannotReplyReason === undefined || thread.CannotReplyReason === null,
    inviteLink: { enable: false, link: null },
  };
  if (!isGroup && participantIDs.length === 1) info.name = "";
  return info;
}

function collectThreads(table, formatter) {
  const threads = [];
  for (const thread of [...(table.LSDeleteThenInsertThread || []), ...(table.LSUpdateOrInsertThread || []), ...(table.LSVerifyThreadExists || [])]) {
    if (!thread || thread.ThreadKey === undefined) continue;
    if (formatter) {
      formatter.updateThreadMeta(thread.ThreadKey, {
        threadID: String(thread.ThreadKey),
        name: thread.ThreadName,
        snippet: thread.Snippet,
        imageSrc: thread.ThreadPictureUrl,
        isGroup: (thread.ThreadType || 1) === 2,
        participantIDs: formatter.getThreadMeta(thread.ThreadKey).participantIDs || [],
      });
    }
    threads.push(threadToInfo(null, thread, formatter));
  }
  return threads;
}

async function getThreadList(client, formatter, limit, timestamp, tags) {
  const threads = [];
  const seen = new Set();
  const folders = normalizeFolders(tags);
  const collect = (table) => {
    for (const info of collectThreads(table, formatter)) {
      if (seen.has(info.threadID)) continue;
      if (folders && !folders.has(String(info.folder || "").toUpperCase())) continue;
      seen.add(info.threadID);
      threads.push(info);
    }
  };
  const ptks = client.configs.parentThreadKeys && client.configs.parentThreadKeys.length ? client.configs.parentThreadKeys.slice() : [-1];
  if (!ptks.includes(-1)) ptks.push(-1);
  for (const tk of ptks) {
    const response = await client.sendTasks([fetchThreadsTask({
      parentThreadKey: tk,
      referenceThreadKey: 0,
      referenceActivityTimestamp: timestamp || 9999999999999,
      syncGroup: 1,
      cursor: client.syncManager.getCursor(1),
    })]);
    collect(parsePublishResponse(response));
    if (limit && threads.length >= limit) break;
  }
  if (limit && threads.length < limit && !timestamp) {
    let prevMinThreadKey = null;
    for (let i = 0; i < 50 && threads.length < limit; i++) {
      const { keyStore, table } = await client.fetchMoreThreads(1, { dispatch: false });
      if (!table) break;
      collect(table);
      if (!keyStore || !keyStore.hasMoreBefore) break;
      if (keyStore.minThreadKey === prevMinThreadKey) break;
      prevMinThreadKey = keyStore.minThreadKey;
    }
  }
  return limit ? threads.slice(0, limit) : threads;
}

async function getThreadInfo(client, formatter, threadID) {
  if (getType(threadID) === "Array") {
    const result = {};
    for (const id of threadID) result[String(id)] = await getThreadInfo(client, formatter, id);
    return result;
  }
  try {
    const response = await client.sendTasks([fetchAdditionalThreadDataTask(toBigOrNumber(threadID))]);
    const table = parsePublishResponse(response);
    if (formatter) formatter.absorb(table);
    const threads = [...(table.LSDeleteThenInsertThread || []), ...(table.LSUpdateOrInsertThread || []), ...(table.LSVerifyThreadExists || [])];
    for (const thread of threads) {
      if (String(thread.ThreadKey) !== String(threadID)) continue;
      if (formatter) formatter.updateThreadMeta(thread.ThreadKey, { threadID: String(thread.ThreadKey), isGroup: (thread.ThreadType || 1) === 2 });
      return threadToInfo(client, thread, formatter);
    }
  } catch (_) { /* fall through */ }
  const cached = formatter ? formatter.getThreadMeta(threadID) : {};
  return threadToInfo(client, {
    ThreadKey: toBigOrNumber(threadID),
    ThreadName: cached.name,
    ThreadPictureUrl: cached.imageSrc,
    Snippet: cached.snippet,
    LastActivityTimestampMs: cached.lastActivityTimestamp,
    LastReadWatermarkTimestampMs: cached.lastReadTimestamp,
    ThreadType: cached.isGroup ? 2 : 1,
    FolderName: "inbox",
  }, formatter);
}

async function getThreadHistory(client, formatter, threadID, amount, timestamp) {
  const { getThreadHistoryGraphql } = require("./messageGraphql");
  const limit = amount === undefined || amount === null ? 20 : amount;
  const messages = await getThreadHistoryGraphql(client, String(threadID), limit, timestamp);
  for (const msg of messages) {
    if (msg && msg.messageID && client._trackMessageThread) client._trackMessageThread(msg.messageID, msg.threadID || String(threadID), msg.timestamp);
  }
  messages.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
  return amount ? messages.slice(-amount) : messages;
}

async function getThreadPictures(client, threadID, offset, limit) {
  const { httpPost } = require("./http");
  const res = await httpPost(client, "https://www.facebook.com/ajax/messaging/attachments/sharedphotos.php", {
    thread_id: threadID,
    offset: offset === undefined ? 0 : offset,
    limit: limit === undefined ? 0 : limit,
  });
  if (!res || !res.payload || !Array.isArray(res.payload.imagesData)) return [];
  return res.payload.imagesData;
}

async function markAsRead(client, threadID, timestamp) {
  let watermark;
  if (typeof timestamp === "number" && timestamp > 0) {
    watermark = timestamp;
  } else {
    const meta = client.formatter ? client.formatter.getThreadMeta(threadID) : {};
    watermark = (meta && (meta.lastActivityTimestamp || meta.lastMessageTimestamp)) || Date.now();
  }
  await client.sendTasks([markReadTask(toBigOrNumber(threadID), watermark)]);
  return {};
}

async function markAsDelivered(client, threadID, messageID) {
  const { httpPost } = require("./http");
  if (!threadID || !messageID) throw { error: "markAsDelivered: need threadID and messageID" };
  const form = {};
  form["message_ids[0]"] = messageID;
  form["thread_ids[" + threadID + "][0]"] = messageID;
  await httpPost(client, "https://www.facebook.com/ajax/mercury/delivery_receipts.php", form);
  return {};
}

async function markAsSeen(client, seenTimestamp) {
  const { httpPost } = require("./http");
  await httpPost(client, "https://www.facebook.com/ajax/mercury/mark_seen.php", {
    seen_timestamp: seenTimestamp || Date.now(),
  });
  return {};
}

async function sendTypingIndicator(client, threadID, isTyping, isGroup) {
  await client.sendStatelessTask(typingTask(toBigOrNumber(threadID), isTyping, isGroup));
  return {};
}

async function muteThread(client, threadID, muteSeconds) {
  const expire = muteSeconds === -1 ? -1 : Date.now() + muteSeconds * 1000;
  await client.sendTasks([muteThreadTask(toBigOrNumber(threadID), expire)]);
  return {};
}

async function changeArchivedStatus(client, threadIDs, archive) {
  const { httpPost } = require("./http");
  const { getType: gt } = require("../utils");
  const list = gt(threadIDs) === "Array" ? threadIDs : [threadIDs];
  const form = {};
  for (const id of list) form["ids[" + id + "]"] = archive ? 1 : 0;
  await httpPost(client, "https://www.facebook.com/ajax/mercury/change_archived_status.php", form);
  return {};
}

async function setTitle(client, threadID, title) {
  noteAdminOp(client, threadID, "log:thread-name", { title });
  await client.sendTasks([renameThreadTask(toBigOrNumber(threadID), title)]);
  return {};
}

async function changeNickname(client, nickname, threadID, participantID) {
  noteAdminOp(client, threadID, "log:user-nickname", { participantID, nickname });
  await client.sendTasks([nicknameTask(toBigOrNumber(threadID), toBigOrNumber(participantID), nickname)]);
  return {};
}

async function changeThreadColor(client, color, threadID) {
  const { THREAD_COLORS } = require("../threadColors");
  let themeId = color;
  if (typeof color === "string" && THREAD_COLORS[color]) themeId = THREAD_COLORS[color];
  if (typeof themeId === "string" && !/^\d+$/.test(themeId)) {
    throw { error: "Invalid color; pass a theme id or a known threadColors name." };
  }
  noteAdminOp(client, threadID, "log:thread-color", { themeId: String(themeId) });
  await client.sendTasks([threadColorTask(toBigOrNumber(threadID), String(themeId))]);
  return {};
}

async function changeThreadEmoji(client, emoji, threadID) {
  const { httpPost } = require("./http");
  noteAdminOp(client, threadID, "log:thread-icon", { emoji });
  try {
    await client.sendTasks([threadEmojiTask(toBigOrNumber(threadID), emoji)]);
    return {};
  } catch (_) {
    const res = await httpPost(client, "https://www.facebook.com/messaging/save_thread_emoji/?source=thread_settings&__pc=EXP1%3Amessengerdotcom_pkg", {
      emoji_choice: emoji,
      thread_or_other_fbid: threadID,
    });
    if (res && res.error === 1357031) {
      throw { error: "Trying to change emoji of a chat that doesn't exist. Have at least one message in the thread before trying to change the emoji." };
    }
    return {};
  }
}

async function changeGroupImage(client, image, threadID) {
  const { uploadAttachment } = require("./upload");
  const metadata = await uploadAttachment(client, image, threadID);
  const imageID = metadata.image_id;
  if (imageID) {
    noteAdminOp(client, threadID, "log:thread-image", { imageID: String(imageID), url: metadata.src || metadata.uri || "" });
    await client.sendTasks([setThreadImageTask(toBigOrNumber(threadID), toBigOrNumber(imageID))]);
  }
  return {};
}

async function changeAdminStatus(client, threadID, adminIDs, adminStatus) {
  const ids = getType(adminIDs) === "Array" ? adminIDs : [adminIDs];
  const isAdmin = adminStatus !== false;
  for (const id of ids) noteAdminOp(client, threadID, "log:thread-admins", { targetID: String(id), isAdmin });
  const tasks = ids.map((id) => updateAdminTask(toBigOrNumber(threadID), toBigOrNumber(id), isAdmin));
  await client.sendTasks(tasks);
  return {};
}

async function addUserToGroup(client, userIDs, threadID) {
  const ids = getType(userIDs) === "Array" ? userIDs : [userIDs];
  const numeric = ids.map(toBigOrNumber);
  noteAdminOp(client, threadID, "log:subscribe", {
    participantIDs: numeric.map(String),
    participantNames: numeric.map((id) => (client.formatter && client.formatter._nameOf ? client.formatter._nameOf(id) : "")),
  });
  await client.sendTasks([addParticipantsTask(toBigOrNumber(threadID), numeric)]);
  return {};
}

async function removeUserFromGroup(client, userID, threadID) {
  noteAdminOp(client, threadID, "log:unsubscribe", { participantID: String(userID) });
  await client.sendTasks([removeParticipantTask(toBigOrNumber(threadID), toBigOrNumber(userID))]);
  return {};
}

async function deleteThread(client, threadID) {
  await client.sendTasks([deleteThreadTask(toBigOrNumber(threadID), 0)]);
  return {};
}

async function createNewGroup(client, participantIDs, groupTitle) {
  const { generateOfflineThreadingID } = require("../utils");
  const { createGroupTask } = require("../tasks");
  const selfID = client.getCurrentUserID();
  const threadFBID = Date.now();
  const participants = [toBigOrNumber(selfID), ...participantIDs.map(toBigOrNumber)];
  const task = createGroupTask({ threadID: threadFBID, otid: generateOfflineThreadingID(), participants });
  const response = await client.sendTasks([task]);
  const realThreadID = resolveCreatedThreadID(response, threadFBID);
  let newThreadID = realThreadID || String(threadFBID);
  if (groupTitle) {
    await setTitle(client, newThreadID, groupTitle);
  }
  return newThreadID;
}

async function changeBlockedStatus(client, userID, block) {
  const { httpPost } = require("./http");
  const url = `https://www.facebook.com/messaging/${block ? "" : "un"}block_messages/`;
  await httpPost(client, url, { fbid: userID });
  return {};
}

async function markAsReadAll(client) {
  const { httpPost } = require("./http");
  await httpPost(client, "https://www.facebook.com/ajax/mercury/mark_folder_as_read.php", { folder: "inbox" });
  return {};
}

async function unfriend(client, userID) {
  const { httpPost } = require("./http");
  await httpPost(client, "https://www.facebook.com/ajax/profile/removefriendconfirm.php", {
    uid: userID,
    unref: "bd_friends_tab",
    floc: "friends_tab",
    "nctr[_mod]": "pagelet_timeline_app_collection_" + client.getCurrentUserID() + ":2356318349:2",
  });
  return {};
}

async function handleFriendRequest(client, userID, accept) {
  const { httpPost } = require("./http");
  if (typeof accept !== "boolean") throw { error: "Please pass a boolean as a second argument." };
  const docID = accept ? "7303313029748461" : "7303313029748461";
  const form = {
    fb_api_caller_class: "RelayModern",
    fb_api_req_friendly_name: accept
      ? "FriendingCometFriendRequestConfirmMutation"
      : "FriendingCometFriendRequestDeleteMutation",
    doc_id: docID,
    variables: JSON.stringify({
      input: {
        friend_requester_id: String(userID),
        source: "friends_tab",
        actor_id: client.getCurrentUserID(),
        client_mutation_id: Math.round(Math.random() * 1024).toString(),
      },
      scale: 1,
      refresh_num: 0,
    }),
    av: client.getCurrentUserID(),
  };
  await httpPost(client, "https://www.facebook.com/api/graphql/", form);
  return {};
}

async function handleMessageRequest(client, threadID, accept) {
  if (typeof accept !== "boolean") throw { error: "Please pass a boolean as a second argument." };
  if (accept) {
    await client.sendTasks([acceptMessageRequestTask(toBigOrNumber(threadID))]);
    return {};
  }
  const { httpPost } = require("./http");
  const threadIDs = getType(threadID) === "Array" ? threadID : [threadID];
  const form = { client: "mercury" };
  threadIDs.forEach((value, index) => { form["other[" + index + "]"] = value; });
  await httpPost(client, "https://www.facebook.com/ajax/mercury/move_thread.php", form);
  return {};
}

async function searchForThread(client, formatter, query) {
  const { searchUserTask } = require("../tasks");
  const response = await client.sendTasks([searchUserTask(query)]);
  const table = parsePublishResponse(response);
  const results = [];
  for (const item of table.LSInsertSearchResult || []) {
    results.push({
      threadID: item.ResultId,
      threadName: item.DisplayName,
      imageSrc: item.ProfilePicUrl,
      isGroup: item.ThreadType === 2,
    });
  }
  return results;
}

module.exports = {
  getThreadList,
  getThreadInfo,
  getThreadHistory,
  getThreadPictures,
  markAsRead,
  markAsDelivered,
  markAsSeen,
  sendTypingIndicator,
  muteThread,
  changeArchivedStatus,
  setTitle,
  changeNickname,
  changeThreadColor,
  changeThreadEmoji,
  changeGroupImage,
  changeAdminStatus,
  addUserToGroup,
  removeUserFromGroup,
  deleteThread,
  createNewGroup,
  changeBlockedStatus,
  markAsReadAll,
  unfriend,
  handleFriendRequest,
  handleMessageRequest,
  searchForThread,
  resolveCreatedThreadID,
  threadToInfo,
};
