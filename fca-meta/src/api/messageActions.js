"use strict";

const { getType, generateOfflineThreadingID, toBigOrNumber } = require("../utils");
const {
  reactionTask,
  deleteMessageTask,
  deleteMessageMeOnlyTask,
  editMessageTask,
  fetchReactionsV2UserListTask,
  forwardMessageTask,
  createPollTask,
} = require("../tasks");
const { parsePublishResponse } = require("./decode");

const EMOJI_CHARS = /^[\p{Extended_Pictographic}\p{Emoji_Component}\u200D]+$/u;
const EMOJI_GLYPH = /[\p{Extended_Pictographic}\p{Regional_Indicator}\u20E3]/u;

function isEmojiReaction(value) {
  if (typeof value !== "string" || value.length === 0 || value.length > 64) return false;
  return EMOJI_CHARS.test(value) && EMOJI_GLYPH.test(value);
}

async function setMessageReaction(client, reaction, messageID, threadID) {
  if (client.iUserID) throw { error: "Cannot set reaction as another profile." };
  if (reaction === undefined || reaction === null) reaction = "";
  if (REACTION_ALIASES[reaction] !== undefined) reaction = REACTION_ALIASES[reaction];
  if (reaction !== "" && !isEmojiReaction(reaction)) throw { error: "Reaction is not a valid emoji." };
  const emoji = reaction;
  let targetThread = threadID;
  if (targetThread === undefined || targetThread === null || targetThread === "") {
    targetThread = client._getMessageThread ? client._getMessageThread(messageID) : (client._messageThreadMap && client._messageThreadMap.get(String(messageID))) || "";
  }
  const timestampMs = Date.now();
  await client.sendTasks([reactionTask({
    threadID: targetThread === undefined || targetThread === null || targetThread === "" ? undefined : toBigOrNumber(targetThread),
    messageID,
    actorID: toBigOrNumber(client.getCurrentUserID()),
    reaction: emoji,
    timestampMs,
  })]);
  return {};
}

const REACTION_ALIASES = {
  ":heart_eyes:": "\uD83D\uDE0D",
  ":love:": "\uD83D\uDE0D",
  ":laughing:": "\uD83D\uDE06",
  ":haha:": "\uD83D\uDE06",
  ":open_mouth:": "\uD83D\uDE2E",
  ":wow:": "\uD83D\uDE2E",
  ":cry:": "\uD83D\uDE22",
  ":sad:": "\uD83D\uDE22",
  ":angry:": "\uD83D\uDE20",
  ":thumbsup:": "\uD83D\uDC4D",
  ":like:": "\uD83D\uDC4D",
  ":thumbsdown:": "\uD83D\uDC4E",
  ":dislike:": "\uD83D\uDC4E",
  ":heart:": "\u2764",
  ":glowingheart:": "\uD83D\uDC97",
};

async function unsendMessage(client, messageID) {
  await client.sendTasks([deleteMessageTask(messageID)]);
  return {};
}

async function deleteMessage(client, messageOrMessages) {
  const list = getType(messageOrMessages) === "Array" ? messageOrMessages : [messageOrMessages];
  const map = client._messageThreadMap;
  await client.sendTasks(
    list.map((id) => deleteMessageMeOnlyTask(map && map.has(String(id)) ? toBigOrNumber(map.get(String(id))) : 0, id))
  );
  return {};
}

async function editMessage(client, text, messageID) {
  if (typeof text !== "string" || !text) throw new Error("editMessage: text is required.");
  if (messageID === undefined || messageID === null || messageID === "") throw new Error("editMessage: messageID is required.");
  const id = String(messageID);
  const response = await client.sendTasks([editMessageTask(id, text)]);
  const table = parsePublishResponse(response);
  const edits = table.LSEditMessage || [];
  const edit = edits.find((e) => e && e.MessageID) || edits[0] || null;
  if (!edit) throw new Error("editMessage: no edit response from server.");
  if (edit.MessageID !== id) throw new Error("editMessage: server returned a different message ID.");
  if (edit.Text !== text) {
    const error = new Error("The message is too old or not from you!");
    error.error = error.message;
    error.messageID = id;
    throw error;
  }
  return { messageID: edit.MessageID, body: edit.Text, editCount: edit.EditCount };
}

async function forwardAttachment(client, attachmentID, threadID) {
  const threadIDs = getType(threadID) === "Array" ? threadID : [threadID];
  const { httpPost } = require("./http");
  const timestamp = Math.floor(Date.now() / 1000);
  const form = { attachment_id: attachmentID };
  for (let i = 0; i < threadIDs.length; i++) form["recipient_map[" + (timestamp + i) + "]"] = threadIDs[i];
  await httpPost(client, "https://www.facebook.com/mercury/attachments/forward/", form);
  return {};
}

async function getMessage(client, threadID, messageID) {
  const { getMessageGraphql } = require("./messageGraphql");
  if (messageID === undefined || messageID === null) {
    messageID = threadID;
    threadID = client._getMessageThread
      ? client._getMessageThread(messageID)
      : client._messageThreadMap && client._messageThreadMap.get(String(messageID));
  }
  if (!threadID || !messageID) return {};
  return getMessageGraphql(client, String(threadID), String(messageID));
}

async function createPoll(client, threadID, question, options) {
  await client.sendTasks([createPollTask(toBigOrNumber(threadID), question, options)]);
  return {};
}

module.exports = {
  setMessageReaction,
  unsendMessage,
  deleteMessage,
  editMessage,
  forwardAttachment,
  getMessage,
  createPoll,
};
