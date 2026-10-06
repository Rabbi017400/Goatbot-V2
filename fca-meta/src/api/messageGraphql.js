"use strict";

const { postGraphqlBatch } = require("./http");
const { getType } = require("../utils");

const GET_MESSAGE_DOC_ID = "1768656253222505";
const GET_HISTORY_DOC_ID = "1498317363570230";

function graphqlEndpoint(client) {
  const base = client.getEndpoint ? client.getEndpoint("base_url") : "https://www.facebook.com";
  return base + "/api/graphqlbatch/";
}

function getExtension(originalExtension, filename) {
  if (originalExtension) {
    return getType(originalExtension) === "Array" ? originalExtension[0] : originalExtension;
  }
  const name = String(filename || "");
  const dot = name.lastIndexOf(".");
  return dot > -1 ? name.slice(dot + 1) : "";
}

function formatAttachment(attachment) {
  if (!attachment) return { error: "No attachment data" };
  switch (attachment.__typename) {
    case "MessageImage":
      return {
        type: "photo",
        ID: attachment.legacy_attachment_id,
        filename: attachment.filename,
        original_extension: getExtension(attachment.original_extension, attachment.filename),
        thumbnailUrl: attachment.thumbnail && attachment.thumbnail.uri,
        previewUrl: attachment.preview && attachment.preview.uri,
        previewWidth: attachment.preview && attachment.preview.width,
        previewHeight: attachment.preview && attachment.preview.height,
        largePreviewUrl: attachment.large_preview && attachment.large_preview.uri,
        largePreviewWidth: attachment.large_preview && attachment.large_preview.width,
        largePreviewHeight: attachment.large_preview && attachment.large_preview.height,
        url: attachment.large_preview && attachment.large_preview.uri,
        width: attachment.large_preview && attachment.large_preview.width,
        height: attachment.large_preview && attachment.large_preview.height,
        name: attachment.filename,
      };
    case "MessageAnimatedImage":
      return {
        type: "animated_image",
        ID: attachment.legacy_attachment_id,
        filename: attachment.filename,
        original_extension: getExtension(attachment.original_extension, attachment.filename),
        previewUrl: attachment.preview_image && attachment.preview_image.uri,
        previewWidth: attachment.preview_image && attachment.preview_image.width,
        previewHeight: attachment.preview_image && attachment.preview_image.height,
        url: attachment.animated_image && attachment.animated_image.uri,
        width: attachment.animated_image && attachment.animated_image.width,
        height: attachment.animated_image && attachment.animated_image.height,
        thumbnailUrl: attachment.preview_image && attachment.preview_image.uri,
        name: attachment.filename,
        facebookUrl: attachment.animated_image && attachment.animated_image.uri,
        animatedGifUrl: attachment.animated_image && attachment.animated_image.uri,
        animatedGifPreviewUrl: attachment.preview_image && attachment.preview_image.uri,
        animatedWebpUrl: attachment.animated_image && attachment.animated_image.uri,
        animatedWebpPreviewUrl: attachment.preview_image && attachment.preview_image.uri,
      };
    case "MessageVideo":
      return {
        type: "video",
        ID: attachment.legacy_attachment_id,
        filename: attachment.filename,
        original_extension: getExtension(attachment.original_extension, attachment.filename),
        duration: attachment.playable_duration_in_ms,
        thumbnailUrl: attachment.large_image && attachment.large_image.uri,
        previewUrl: attachment.large_image && attachment.large_image.uri,
        previewWidth: attachment.large_image && attachment.large_image.width,
        previewHeight: attachment.large_image && attachment.large_image.height,
        url: attachment.playable_url,
        width: attachment.original_dimensions && attachment.original_dimensions.x,
        height: attachment.original_dimensions && attachment.original_dimensions.y,
        videoType: attachment.video_type ? String(attachment.video_type).toLowerCase() : "",
      };
    case "MessageFile":
      return {
        type: "file",
        ID: attachment.message_file_fbid,
        filename: attachment.filename,
        original_extension: getExtension(attachment.original_extension, attachment.filename),
        url: attachment.url,
        isMalicious: attachment.is_malicious,
        contentType: attachment.content_type,
        name: attachment.filename,
        mimeType: "",
        fileSize: -1,
      };
    case "MessageAudio":
      return {
        type: "audio",
        ID: attachment.url_shimhash,
        filename: attachment.filename,
        original_extension: getExtension(attachment.original_extension, attachment.filename),
        duration: attachment.playable_duration_in_ms,
        audioType: attachment.audio_type,
        url: attachment.playable_url,
        isVoiceMail: attachment.is_voicemail,
      };
    default:
      return { error: "Don't know about attachment type " + (attachment.__typename || "unknown") };
  }
}

function formatExtensibleAttachment(attachment) {
  if (!attachment || !attachment.story_attachment) {
    return { error: "Don't know what to do with extensible_attachment." };
  }
  const story = attachment.story_attachment;
  const media = story.media || {};
  const image = media.animated_image || media.image;
  return {
    type: "share",
    ID: attachment.legacy_attachment_id,
    url: story.url,
    title: story.title_with_entities && story.title_with_entities.text,
    description: story.description && story.description.text,
    source: story.source == null ? null : (story.source.text == null ? story.source : story.source.text),
    image: image ? image.uri : null,
    width: image ? image.width : null,
    height: image ? image.height : null,
    playable: media.is_playable,
    duration: media.playable_duration_in_ms,
    playableUrl: media.playable_url,
    subattachments: story.subattachments,
    properties: Array.isArray(story.properties)
      ? story.properties.reduce((obj, current) => {
        obj[current.key] = current.value && current.value.text;
        return obj;
      }, {})
      : {},
    thumbnailUrl: image ? image.uri : null,
    thumbnailWidth: image ? image.width : null,
    thumbnailHeight: image ? image.height : null,
  };
}

function formatBlobAttachments(list) {
  if (!Array.isArray(list)) return [];
  return list.map((attachment) => {
    try {
      return formatAttachment(attachment);
    } catch (err) {
      return Object.assign({}, attachment, { type: "unknown", error: err });
    }
  });
}

function formatReactions(reactions) {
  const list = Array.isArray(reactions) ? reactions : [];
  return list.map((reaction) => ({
    reaction: reaction.reaction,
    userID: reaction.user && reaction.user.id,
  }));
}

function formatMentions(message) {
  const text = String((message && message.text) || "");
  const ranges = message && Array.isArray(message.ranges) ? message.ranges : [];
  const mentions = {};
  for (const entry of ranges) {
    if (entry && entry.entity) mentions[entry.entity.id] = text.substring(entry.offset, entry.offset + entry.length);
  }
  return mentions;
}

const ADMIN_TEXT_TYPE = {
  joinable_group_link_mode_change: "log:link-status",
  magic_words: "log:magic-words",
  change_thread_theme: "log:thread-color",
  change_thread_icon: "log:thread-icon",
  change_thread_quick_reaction: "log:thread-icon",
  change_thread_nickname: "log:user-nickname",
  change_thread_admins: "log:thread-admins",
  group_poll: "log:thread-poll",
  change_thread_approval_mode: "log:thread-approval-mode",
  messenger_call_log: "log:thread-call",
  participant_joined_group_call: "log:thread-call",
  pin_messages_v2: "log:thread-pinned",
  unpin_messages_v2: "log:unpin-message",
};

function getAdminTextMessageType(type) {
  const raw = type && (type.type || type);
  return ADMIN_TEXT_TYPE[raw] || raw || "other";
}

function formatEventData(event) {
  if (!event) return {};
  switch (event.__typename) {
    case "ThemeColorExtensibleMessageAdminText":
      return { color: event.theme_color };
    case "ThreadNicknameExtensibleMessageAdminText":
      return { nickname: event.nickname, participantID: event.participant_id };
    case "ThreadIconExtensibleMessageAdminText":
      return { threadIcon: event.thread_icon };
    case "RtcCallLogExtensibleMessageAdminText":
      return { event: event.event, is_video_call: event.is_video_call, server_info_data: event.server_info_data };
    case "GroupPollExtensibleMessageAdminText":
      return { event_type: event.event_type, total_count: event.total_count, question: event.question };
    default:
      return {};
  }
}

function threadIDFromKey(threadKey) {
  if (!threadKey) return "";
  if (threadKey.thread_fbid) return String(threadKey.thread_fbid);
  return String(threadKey.other_user_id || "");
}

function messageToAttachmentList(message) {
  if (message.sticker) {
    const sticker = message.sticker;
    return [{
      type: "sticker",
      ID: sticker.id,
      url: sticker.url,
      packID: sticker.pack ? sticker.pack.id : null,
      spriteUrl: sticker.sprite_image,
      spriteUrl2x: sticker.sprite_image_2x,
      width: sticker.width,
      height: sticker.height,
      caption: message.snippet,
      description: sticker.label,
      frameCount: sticker.frame_count,
      frameRate: sticker.frame_rate,
      framesPerRow: sticker.frames_per_row,
      framesPerCol: sticker.frames_per_col,
      stickerID: sticker.id,
    }];
  }
  if (Array.isArray(message.blob_attachments) && message.blob_attachments.length) {
    return message.blob_attachments.map(formatAttachment);
  }
  if (message.extensible_attachment && Object.keys(message.extensible_attachment).length) {
    return [formatExtensibleAttachment(message.extensible_attachment)];
  }
  return [];
}

function formatGraphqlMessage(threadID, isGroup, message) {
  switch (message.__typename) {
    case "UserMessage":
      return {
        type: "message",
        attachments: messageToAttachmentList(message),
        body: message.message !== null && message.message !== undefined ? message.message.text : "",
        isGroup,
        messageID: message.message_id,
        senderID: message.message_sender && message.message_sender.id,
        threadID,
        timestamp: message.timestamp_precise,
        mentions: formatMentions(message.message),
        isUnread: message.unread,
        messageReactions: message.message_reactions ? message.message_reactions.map(formatReactions) : null,
        isSponsored: message.is_sponsored,
        snippet: message.snippet,
      };
    case "ThreadNameMessage":
      return {
        type: "event",
        messageID: message.message_id,
        threadID,
        isGroup,
        senderID: message.message_sender && message.message_sender.id,
        timestamp: message.timestamp_precise,
        eventType: "change_thread_name",
        snippet: message.snippet,
        eventData: { threadName: message.thread_name },
        author: message.message_sender && message.message_sender.id,
        logMessageType: "log:thread-name",
        logMessageData: { name: message.thread_name },
      };
    case "ThreadImageMessage":
      return {
        type: "event",
        messageID: message.message_id,
        threadID,
        isGroup,
        senderID: message.message_sender && message.message_sender.id,
        timestamp: message.timestamp_precise,
        eventType: "change_thread_image",
        snippet: message.snippet,
        author: message.message_sender && message.message_sender.id,
        logMessageType: "log:thread-image",
        logMessageData: {
          attachmentID: message.image_with_metadata ? message.image_with_metadata.legacy_attachment_id : null,
          width: message.image_with_metadata && message.image_with_metadata.original_dimensions ? message.image_with_metadata.original_dimensions.x : null,
          height: message.image_with_metadata && message.image_with_metadata.original_dimensions ? message.image_with_metadata.original_dimensions.y : null,
          url: message.image_with_metadata && message.image_with_metadata.preview ? message.image_with_metadata.preview.uri : null,
        },
      };
    case "ParticipantLeftMessage":
      return {
        type: "event",
        messageID: message.message_id,
        threadID,
        isGroup,
        senderID: message.message_sender && message.message_sender.id,
        timestamp: message.timestamp_precise,
        eventType: "remove_participants",
        snippet: message.snippet,
        author: message.message_sender && message.message_sender.id,
        eventData: { participantsRemoved: (message.participants_removed || []).map((p) => p.id) },
        logMessageType: "log:unsubscribe",
        logMessageData: { leftParticipantFbId: (message.participants_removed || []).length ? (message.participants_removed[0] || {}).id : null },
      };
    case "ParticipantsAddedMessage":
      return {
        type: "event",
        messageID: message.message_id,
        threadID,
        isGroup,
        senderID: message.message_sender && message.message_sender.id,
        timestamp: message.timestamp_precise,
        eventType: "add_participants",
        snippet: message.snippet,
        author: message.message_sender && message.message_sender.id,
        eventData: { participantsAdded: (message.participants_added || []).map((p) => p.id) },
        logMessageType: "log:subscribe",
        logMessageData: {
          addedParticipants: (message.participants_added || []).map((p) => ({ userFbId: String(p.id), fullName: p.name || "" })),
        },
      };
    case "VideoCallMessage":
      return {
        type: "event",
        messageID: message.message_id,
        threadID,
        isGroup,
        senderID: message.message_sender && message.message_sender.id,
        timestamp: message.timestamp_precise,
        eventType: "video_call",
        snippet: message.snippet,
        author: message.message_sender && message.message_sender.id,
        logMessageType: "other",
      };
    case "VoiceCallMessage":
      return {
        type: "event",
        messageID: message.message_id,
        threadID,
        isGroup,
        senderID: message.message_sender && message.message_sender.id,
        timestamp: message.timestamp_precise,
        eventType: "voice_call",
        snippet: message.snippet,
        author: message.message_sender && message.message_sender.id,
        logMessageType: "other",
      };
    case "GenericAdminTextMessage":
      return {
        type: "event",
        messageID: message.message_id,
        threadID,
        isGroup,
        senderID: message.message_sender && message.message_sender.id,
        timestamp: message.timestamp_precise,
        snippet: message.snippet,
        eventType: String(message.extensible_message_admin_text_type || "").toLowerCase(),
        eventData: formatEventData(message.extensible_message_admin_text),
        author: message.message_sender && message.message_sender.id,
        logMessageType: getAdminTextMessageType(message.extensible_message_admin_text_type),
        logMessageData: message.extensible_message_admin_text,
      };
    default:
      return { error: "Don't know about message type " + message.__typename };
  }
}

function parseDelta(threadID, delta) {
  const isGroup = undefined;
  if (delta.replied_to_message && delta.replied_to_message.message) {
    return Object.assign(
      { type: "message_reply" },
      formatGraphqlMessage(threadID, isGroup, delta),
      { messageReply: formatGraphqlMessage(threadID, isGroup, delta.replied_to_message.message) }
    );
  }
  return formatGraphqlMessage(threadID, isGroup, delta);
}

async function getMessageGraphql(client, threadID, messageID) {
  const form = {
    av: (client.configs && client.configs.pageID) || client.getCurrentUserID(),
    queries: JSON.stringify({
      o0: {
        doc_id: GET_MESSAGE_DOC_ID,
        query_params: { thread_and_message_id: { thread_id: threadID, message_id: messageID } },
      },
    }),
    batch_name: "MessengerGraphQLThreadFetcher",
  };
  const resData = await postGraphqlBatch(client, graphqlEndpoint(client), form);
  if (!Array.isArray(resData) || !resData.length) throw { error: "getMessage: invalid response" };
  const last = resData[resData.length - 1] || {};
  if (last.error_results > 0) throw (resData[0] && resData[0].o0 && resData[0].o0.errors) || { error: "getMessage: error_results > 0" };
  const fetchData = resData[0] && resData[0].o0 && resData[0].o0.data && resData[0].o0.data.message;
  if (!fetchData) throw { error: "getMessage: message not found" };
  return parseDelta(threadID, fetchData);
}

async function getThreadHistoryGraphql(client, threadID, amount, timestamp) {
  const form = {
    av: (client.configs && client.configs.pageID) || client.getCurrentUserID(),
    queries: JSON.stringify({
      o0: {
        doc_id: GET_HISTORY_DOC_ID,
        query_params: {
          id: threadID,
          message_limit: amount,
          load_messages: 1,
          load_read_receipts: false,
          before: timestamp || null,
        },
      },
    }),
    batch_name: "MessengerGraphQLThreadFetcher",
  };
  const resData = await postGraphqlBatch(client, graphqlEndpoint(client), form);
  if (!Array.isArray(resData) || !resData.length) return [];
  if (resData.error) throw resData;
  const last = resData[resData.length - 1] || {};
  if (last.error_results !== 0) throw new Error("There was an error_result.");
  const payload = resData[0] && resData[0].o0 && resData[0].o0.data;
  const messageThread = payload && payload.message_thread;
  if (!messageThread || !messageThread.messages) return [];
  const threadKey = threadIDFromKey(messageThread.thread_key) || String(threadID);
  const isGroup = messageThread.thread_type === "GROUP";
  const nodes = messageThread.messages.nodes || [];
  return nodes.map((message) => formatGraphqlMessage(threadKey, isGroup, message));
}

module.exports = {
  getMessageGraphql,
  getThreadHistoryGraphql,
  getAdminTextMessageType,
  formatAttachment,
  formatExtensibleAttachment,
  formatGraphqlMessage,
};
