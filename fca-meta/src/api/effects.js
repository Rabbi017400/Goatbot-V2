"use strict";

const fs = require("fs");
const { getType, streamToBuffer, toBigOrNumber } = require("../utils");
const { uploadAttachment } = require("./upload");
const {
  EFFECTS,
  AVATARS,
  resolveEffect,
  resolveEffectTag,
  isAvatarEffect,
  listEffects,
  getAvatar,
  randomAvatar,
  avatarPath,
  isAvatarSupported,
} = require("./effects/core");
const { SEND_TYPE, extractMessageID, buildSendPayload, buildSendTask } = require("./effects/sender");

function parseMessage(message) {
  if (typeof message === "string") return { body: message, replyToMessageID: undefined };
  if (message == null) return { body: "", replyToMessageID: undefined };
  if (getType(message) !== "Object" && getType(message) !== "Array") return { body: String(message), replyToMessageID: undefined };
  return {
    body: (message.body != null ? message.body : message.text) || "",
    replyToMessageID: message.replyToMessageID || message.replyTo || undefined,
  };
}

async function attachmentFbid(client, source, threadID, filename) {
  const buffer = Buffer.isBuffer(source) ? source : await streamToBuffer(source);
  const name = filename || (source && (source.filename || source.name));
  const payload = name ? Object.assign(buffer, { filename: name }) : buffer;
  const metadata = await uploadAttachment(client, payload, threadID);
  return metadata.image_id || metadata.gif_id || metadata.video_id || metadata.file_id || metadata.audio_id || "";
}

function effectResult(response) {
  const messageID = extractMessageID(response);
  const error = !messageID && response && response.error ? response.error : "";
  if (error) throw error;
  return messageID;
}

async function sendEffect(client, effectName, message, threadID) {
  if (effectName === undefined || effectName === null || effectName === "") throw new Error("effect name is required");
  if (threadID === undefined || threadID === null || threadID === "") throw new Error("sendEffect: threadID is required");
  const effectId = resolveEffect(effectName);
  if (isAvatarEffect(effectId)) throw new Error("sendEffect: \"" + effectName + "\" is an avatar effect; use sendAvatarEffect instead.");
  const effectTag = resolveEffectTag(effectName);
  const payload = parseMessage(message);
  const send = buildSendPayload(threadID, {
    text: payload.body,
    sendType: SEND_TYPE.TEXT,
    powerUpStyle: effectId,
    replyToMessageID: payload.replyToMessageID,
  });
  const response = await client.sendTasks([buildSendTask(send)]);
  const messageID = effectResult(response);
  if (messageID) client._trackMessageThread(messageID, String(threadID));
  return { task: "sendEffect", messageID, threadID: String(threadID), body: payload.body, effect: effectTag, effectId };
}

async function sendAvatarEffect(client, name, message, threadID) {
  if (name !== undefined && name !== null && name !== "" && name !== "random" && !getAvatar(name)) {
    throw new Error("unknown avatar effect \"" + name + "\"");
  }
  if (threadID === undefined || threadID === null || threadID === "") throw new Error("sendAvatarEffect: threadID is required");
  const avatar = getAvatar(name) || randomAvatar();
  if (!avatar) throw new Error("no avatar effects are available");
  const file = avatarPath(avatar);
  if (!fs.existsSync(file)) throw new Error("missing avatar effect asset " + avatar.file);
  const payload = parseMessage(message);
  const fbid = await attachmentFbid(client, fs.createReadStream(file), threadID, avatar.file);
  if (!fbid) throw new Error("avatar effect upload failed");
  const send = buildSendPayload(threadID, {
    text: payload.body,
    sendType: SEND_TYPE.MEDIA,
    attachmentFBIds: [toBigOrNumber(fbid)],
    powerUpStyle: resolveEffect(avatar.effect),
    replyToMessageID: payload.replyToMessageID,
  });
  const response = await client.sendTasks([buildSendTask(send)]);
  const messageID = effectResult(response);
  if (messageID) client._trackMessageThread(messageID, String(threadID));
  return {
    task: "sendAvatarEffect",
    messageID,
    threadID: String(threadID),
    body: payload.body,
    avatar: avatar.name,
    effect: resolveEffectTag(avatar.effect),
  };
}

function listAvatarEffects() {
  return AVATARS.map((avatar) => ({
    name: avatar.name,
    effect: avatar.effect,
    tag: resolveEffectTag(avatar.effect),
    id: resolveEffect(avatar.effect),
    file: avatar.file,
    label: avatar.label,
    available: fs.existsSync(avatarPath(avatar)),
  }));
}

module.exports = {
  sendEffect,
  sendAvatarEffect,
  listEffects,
  listAvatarEffects,
  isAvatarSupported,
  EFFECTS,
  AVATARS,
  resolveEffect,
  resolveEffectTag,
  isAvatarEffect,
};
