"use strict";

const { getType, generateOfflineThreadingID, removeSpecialChar, toBigOrNumber, delay } = require("../utils");
const { sendMessageTask, createGroupTask, THREAD_SOURCE, INITIATING_SOURCE } = require("../tasks");
const { uploadAttachment } = require("./upload");
const { parsePublishResponse } = require("./decode");

const ALLOWED_PROPERTIES = ["attachment", "url", "sticker", "emoji", "emojiSize", "body", "mentions", "location", "replyToMessage"];

// Typing-indicator timing for the pre-send "composing" signal.
const TYPING_MS_PER_CHAR = 20;
const TYPING_MIN_MS = 250;
const TYPING_MAX_MS = 1500;

function buildMentions(msg) {
  if (!msg.mentions) return null;
  const ids = [];
  const offsets = [];
  const lengths = [];
  const types = [];
  for (const mention of msg.mentions) {
    const tag = mention.tag;
    if (typeof tag !== "string") continue;
    const offset = String(msg.body).indexOf(tag, mention.fromIndex || 0);
    if (offset < 0) continue;
    ids.push(String(mention.id == null ? 0 : mention.id));
    offsets.push(String(offset));
    lengths.push(String(tag.length));
    types.push("p");
  }
  if (!ids.length) return null;
  return {
    mention_ids: ids.join(","),
    mention_offsets: offsets.join(","),
    mention_lengths: lengths.join(","),
    mention_types: types.join(","),
  };
}

async function sendMessage(client, msg, threadID, options = {}) {
  let { replyToMessage } = options;
  if (typeof msg === "string") msg = { body: msg };
  if (getType(msg) !== "Object") throw new Error("Message should be of type string or object and not " + getType(msg) + ".");
  if (replyToMessage === undefined && msg.replyToMessage !== undefined) replyToMessage = msg.replyToMessage;
  if (getType(threadID) !== "Array" && getType(threadID) !== "Number" && getType(threadID) !== "String") {
    throw new Error("ThreadID should be of type number, string, or array and not " + getType(threadID) + ".");
  }

  const disallowed = Object.keys(msg).filter((prop) => !ALLOWED_PROPERTIES.includes(prop));
  if (disallowed.length > 0) throw new Error("Dissallowed props: `" + disallowed.join(", ") + "`");

  let body = msg.body;
  if (typeof body === "string") body = removeSpecialChar(body);

  let targetThread = threadID;
  if (getType(threadID) === "Array") {
    targetThread = await createThreadForUsers(client, threadID);
  }

  const attachmentFBIds = [];
  let sendType = 1;
  let stickerId = 0;
  let hotEmojiSize = 0;

  if (msg.attachment) {
    const list = getType(msg.attachment) === "Array" ? msg.attachment : [msg.attachment];
    for (const attachment of list) {
      const metadata = await uploadAttachment(client, attachment, targetThread);
      const fbId = metadata.image_id || metadata.video_id || metadata.audio_id || metadata.gif_id || metadata.file_id;
      if (fbId) attachmentFBIds.push(toBigOrNumber(fbId));
    }
    sendType = 3;
  }
  if (msg.sticker) {
    stickerId = toBigOrNumber(msg.sticker);
    sendType = 2;
  }
  if (msg.emoji) {
    if (msg.body) throw new Error("body is not empty");
    body = msg.emoji;
    sendType = 1;
    hotEmojiSize = { small: 1, medium: 2, large: 3 }[msg.emojiSize || "medium"] || 2;
  }

  const otid = generateOfflineThreadingID();
  // Show a typing indicator before a text send, like a real client composing the
  // message. Presence is stateless (not queued with the message) so it does not
  // interfere with the send task.
  if (options.typingIndicator !== false && typeof body === "string" && body) {
    let isGroup = options.isGroup;
    if (isGroup === undefined && client.formatter && typeof client.formatter.getThreadMeta === "function") {
      const meta = client.formatter.getThreadMeta(targetThread);
      if (meta && meta.isGroup !== undefined) isGroup = meta.isGroup;
    }
    const sendTyping = require("./thread").sendTypingIndicator;
    await sendTyping(client, targetThread, true, isGroup).catch(() => {});
    await delay(Math.min(TYPING_MAX_MS, Math.max(TYPING_MIN_MS, TYPING_MS_PER_CHAR * body.length)));
    await sendTyping(client, targetThread, false, isGroup).catch(() => {});
  }
  const task = sendMessageTask(client, {
    threadID: toBigOrNumber(targetThread),
    otid: otid,
    text: body,
    replyToMessage,
    mentions: buildMentions(msg),
    attachmentFBIds,
    stickerId,
    sendType,
    source: THREAD_SOURCE.MESSENGER_INBOX_IN_THREAD,
    hotEmojiSize,
    initiatingSource: INITIATING_SOURCE.FACEBOOK_INBOX,
  });

  const response = await client.sendTasks([task]);
  const table = parsePublishResponse(response);
  const messages = [
    ...(table.LSUpsertMessage || []),
    ...(table.LSInsertMessage || []),
    ...(table.LSDeleteThenInsertMessage || []),
    ...(table.LSReplaceOptimsiticMessage || []),
  ];
  const first = messages.find((m) => m && m.MessageId) || messages[0];
  const messageID = first ? first.MessageId : "";
  if (messageID) client._trackMessageThread(messageID, targetThread, first && first.TimestampMs);
  return {
    threadID: String(targetThread),
    messageID,
    timestamp: first && first.TimestampMs ? first.TimestampMs : Date.now(),
  };
}

async function createThreadForUsers(client, userIDs) {
  const selfID = client.getCurrentUserID();
  const threadFBID = Date.now();
  const participants = userIDs.map(toBigOrNumber).filter((id) => id && String(id) !== String(selfID));
  const task = createGroupTask({
    threadID: threadFBID,
    otid: generateOfflineThreadingID(),
    participants: [toBigOrNumber(selfID), ...participants],
  });
  const response = await client.sendTasks([task]);
  const { resolveCreatedThreadID } = require("./thread");
  const realThreadID = resolveCreatedThreadID(response, threadFBID);
  if (realThreadID) return realThreadID;
  return String(threadFBID);
}

module.exports = { sendMessage, buildMentions };
