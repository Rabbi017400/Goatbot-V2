"use strict";

const { generateOfflineThreadingID } = require("../../utils");
const { sendMessageTask, THREAD_SOURCE, INITIATING_SOURCE } = require("../../tasks");
const { parsePublishResponse } = require("../decode");

const SEND_MESSAGE_LABEL = "46";

const SEND_TYPE = {
  UNKNOWN: 0,
  TEXT: 1,
  STICKER: 2,
  MEDIA: 3,
  FORWARD: 5,
  EXTERNAL_MEDIA: 7,
};

function extractMessageID(response) {
  if (!response) return "";
  const table = parsePublishResponse(response);
  const messages = [
    ...(table.LSUpsertMessage || []),
    ...(table.LSInsertMessage || []),
    ...(table.LSDeleteThenInsertMessage || []),
    ...(table.LSReplaceOptimsiticMessage || []),
  ];
  const first = messages.find((m) => m && m.MessageId);
  return first ? first.MessageId : "";
}

function buildSendPayload(threadID, fields) {
  return sendMessageTask(null, {
    threadID: String(threadID),
    otid: generateOfflineThreadingID(),
    text: fields.text,
    replyToMessage: fields.replyToMessageID,
    replyType: fields.replyType,
    mentions: fields.mentionData,
    attachmentFBIds: fields.attachmentFBIds,
    stickerId: fields.stickerID,
    sendType: fields.sendType,
    source: fields.source !== undefined ? fields.source : THREAD_SOURCE.MESSENGER_INBOX_IN_THREAD,
    hotEmojiSize: fields.hotEmojiSize,
    url: fields.url,
    initiatingSource: fields.initiatingSource !== undefined ? fields.initiatingSource : INITIATING_SOURCE.FACEBOOK_INBOX,
    powerUpStyle: fields.powerUpStyle,
  }).payload;
}

function buildSendTask(payload) {
  return { label: SEND_MESSAGE_LABEL, payload, queueName: String(payload.thread_id) };
}

module.exports = { SEND_TYPE, extractMessageID, buildSendPayload, buildSendTask };
