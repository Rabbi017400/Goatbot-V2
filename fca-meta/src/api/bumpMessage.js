"use strict";

const { getType, generateOfflineThreadingID } = require("../utils");
const { sendMessageTask } = require("../tasks");
const { parsePublishResponse } = require("./decode");

function extractMessage(response) {
  const table = parsePublishResponse(response);
  const messages = [
    ...(table.LSUpsertMessage || []),
    ...(table.LSInsertMessage || []),
    ...(table.LSDeleteThenInsertMessage || []),
    ...(table.LSReplaceOptimsiticMessage || []),
  ];
  return messages.find((m) => m && m.MessageId) || messages[0] || null;
}

function resolveThreadID(client, messageID, threadID) {
  if (threadID !== undefined && threadID !== null && threadID !== "") return String(threadID);
  const known = client._getMessageThread ? client._getMessageThread(messageID) : "";
  return String(known || "");
}

async function bumpMessage(client, messageID, threadID) {
  if (getType(messageID) !== "String" && getType(messageID) !== "Number") {
    throw new Error("bumpMessage: messageID must be a string or number, not " + getType(messageID) + ".");
  }
  const id = String(messageID);
  let targetThread = resolveThreadID(client, id, threadID);
  if (!targetThread) {
    const { getMessageGraphql } = require("./messageGraphql");
    try {
      const message = await getMessageGraphql(client, "", id);
      targetThread = String((message && message.threadID) || "");
    } catch (_) { /* fall through */ }
  }
  if (!targetThread) throw { error: "bumpMessage: could not resolve thread for message; pass threadID." };

  const otid = generateOfflineThreadingID();
  const task = sendMessageTask(client, {
    threadID: Number(targetThread),
    otid,
    text: "",
    replyToMessage: id,
    replyType: 1,
    mentions: null,
    attachmentFBIds: [],
    stickerId: 0,
    sendType: 1,
    source: 0,
    hotEmojiSize: 0,
    initiatingSource: 1,
  });
  const response = await client.sendTasks([task]);
  const first = extractMessage(response);
  const newMessageID = first ? first.MessageId : "";
  if (newMessageID) client._trackMessageThread(newMessageID, targetThread, first && first.TimestampMs);
  return {
    threadID: targetThread,
    messageID: newMessageID,
    bumpedMessageID: id,
    timestamp: first && first.TimestampMs ? first.TimestampMs : Date.now(),
  };
}

async function bumpThread(client, threadID, messageID, formatter) {
  if (threadID === undefined || threadID === null || threadID === "") {
    throw new Error("bumpThread: threadID is required.");
  }
  let mid = messageID;
  if (!mid) {
    const { getThreadHistory } = require("./thread");
    const history = await getThreadHistory(client, formatter, threadID, 10, undefined);
    const messages = Array.isArray(history) ? history : (history && Array.isArray(history.messages) ? history.messages : []);
    const candidates = messages.filter((m) => m && !m.isUnsent && m.messageID);
    const last = candidates[candidates.length - 1];
    if (!last) throw new Error("bumpThread: found no message to bump.");
    mid = last.messageID;
  }
  return bumpMessage(client, mid, threadID);
}

module.exports = { bumpMessage, bumpThread };
