"use strict";

const { Client } = require("./src/client");
const { Cookies, cookiesFromAppState } = require("./src/cookies");
const { EventFormatter } = require("./src/eventFormatter");
const { listenMqtt } = require("./src/listen");
const sendMessageApi = require("./src/api/sendMessage");
const userApi = require("./src/api/user");
const threadApi = require("./src/api/thread");
const threadGraphql = require("./src/api/threadGraphql");
const messageActions = require("./src/api/messageActions");
const bumpMessageApi = require("./src/api/bumpMessage");
const effectsApi = require("./src/api/effects");
const profileApi = require("./src/api/profile");
const uploadApi = require("./src/api/upload");
const themeApi = require("./src/api/theme");
const musicApi = require("./src/api/music");
const httpApi = require("./src/api/http");
const { getType } = require("./src/utils");
const { errors } = require("./src/http");

function withCallback(fn) {
  return function (...args) {
    let callback = null;
    if (typeof args[args.length - 1] === "function") callback = args.pop();
    const promise = Promise.resolve().then(() => fn(...args));
    if (callback) {
      promise.then((data) => callback(null, data), (err) => callback(err));
    }
    return promise;
  };
}

function rawHttp(api, fn, args, callback) {
  if (typeof args[1] === "function") {
    callback = args[1];
    args[1] = {};
  }
  if (typeof args[2] === "function") {
    callback = args[2];
    args[2] = {};
  }
  if (typeof callback !== "function") callback = null;
  const promise = Promise.resolve().then(() => fn(api.getClient(), args[0], args[1] || {}, { customHeader: args[2] || {} }));
  if (callback) promise.then((data) => callback(null, data), (err) => callback(err));
  return promise;
}

const DEFAULT_OPTIONS = {
  selfListen: false,
  selfListenEvent: false,
  listenEvents: false,
  listenTyping: false,
  updatePresence: false,
  forceLogin: false,
  autoMarkDelivery: true,
  autoMarkRead: false,
  autoReconnect: true,
  online: false,
  emitReady: false,
  typingIndicator: true,
  forceRefreshIntervalMs: undefined,
  minFullReconnectMs: undefined,
};

function buildApi(client, globalOptions) {
  const formatter = new EventFormatter(client, globalOptions);
  client.formatter = formatter;
  const api = {};

  api.getCurrentUserID = () => client.getCurrentUserID();
  api.getAppState = () => client.getAppState();
  api.getCookies = () => client.cookies.getAll();
  api.getUserId = () => client.getCurrentUserID();
  api.getSessionID = () => client.configs && client.configs.webSessionID;
  api.getClient = () => client;
  api.getOptions = () => globalOptions;

  api.setOptions = (options) => {
    Object.assign(globalOptions, options);
    if (options.userAgent) {
      client.userAgent = options.userAgent;
      client.http.setUserAgent(options.userAgent);
    }
    formatter.selfListen = globalOptions.selfListen !== false;
    formatter.selfListenEvent = Boolean(globalOptions.selfListenEvent);
    formatter.listenEvents = globalOptions.listenEvents !== false;
    formatter.listenTyping = globalOptions.listenTyping !== false;
    formatter.updatePresence = Boolean(globalOptions.updatePresence);
    return api;
  };

  // --- Messaging ----------------------------------------------------------
  api.sendMessage = function sendMessage(msg, threadID, callback, replyToMessage, isGroup) {
    if (typeof callback !== "function") {
      if (typeof callback === "string" && replyToMessage === undefined) replyToMessage = callback;
      callback = null;
      if (typeof threadID === "function") {
        const cb = threadID;
        return cb({ error: "Pass a threadID as a second argument." });
      }
    }
    const promise = sendMessageApi.sendMessage(client, msg, threadID, { replyToMessage, isGroup, typingIndicator: globalOptions.typingIndicator !== false });
    if (callback) promise.then((d) => callback(null, d), (e) => callback(e));
    return promise;
  };

  api.unsendMessage = withCallback((messageID) => messageActions.unsendMessage(client, messageID));
  api.uploadAttachment = withCallback((attachments) => uploadApi.uploadAttachmentList(client, attachments));
  api.deleteMessage = function deleteMessage(messageOrMessages, callback) {
    if (typeof callback !== "function") callback = null;
    const promise = messageActions.deleteMessage(client, messageOrMessages);
    if (callback) promise.then((d) => callback(null, d), (e) => callback(e));
    return promise;
  };
  api.editMessage = withCallback((text, messageID) => messageActions.editMessage(client, text, messageID));
  api.setMessageReaction = function setMessageReaction(reaction, messageID, threadID, callback, forceCustomReaction) {
    if (typeof threadID === "function") {
      forceCustomReaction = callback;
      callback = threadID;
      threadID = undefined;
    } else if (typeof threadID === "boolean") {
      forceCustomReaction = threadID;
      threadID = undefined;
    } else if (typeof callback === "boolean") {
      forceCustomReaction = callback;
      callback = null;
    }
    if (typeof callback !== "function") callback = null;
    const promise = messageActions.setMessageReaction(client, reaction, messageID, threadID);
    if (callback) promise.then((d) => callback(null, d), (e) => callback(e));
    return promise;
  };
  api.forwardAttachment = withCallback((attachmentID, threadID) => messageActions.forwardAttachment(client, attachmentID, threadID));
  api.getMessage = withCallback((threadIDOrMessageID, messageID) => messageActions.getMessage(client, threadIDOrMessageID, messageID));
  api.bumpMessage = function bumpMessage(messageID, threadID, callback) {
    if (typeof threadID === "function") {
      callback = threadID;
      threadID = undefined;
    }
    const promise = bumpMessageApi.bumpMessage(client, messageID, threadID);
    if (callback) promise.then((d) => callback(null, d), (e) => callback(e));
    return promise;
  };
  api.bumpThread = function bumpThread(threadID, messageID, callback) {
    if (typeof messageID === "function") {
      callback = messageID;
      messageID = undefined;
    }
    const promise = bumpMessageApi.bumpThread(client, threadID, messageID, formatter);
    if (callback) promise.then((d) => callback(null, d), (e) => callback(e));
    return promise;
  };
  api.sendEffect = function sendEffect(effectName, message, threadID, callback) {
    if (typeof threadID === "function") {
      callback = threadID;
      threadID = null;
    }
    const promise = effectsApi.sendEffect(client, effectName, message, threadID);
    if (callback) promise.then((d) => callback(null, d), (e) => callback(e));
    return promise;
  };
  api.sendAvatarEffect = function sendAvatarEffect(name, message, threadID, callback) {
    if (typeof threadID === "function") {
      callback = threadID;
      threadID = null;
    }
    const promise = effectsApi.sendAvatarEffect(client, name, message, threadID);
    if (callback) promise.then((d) => callback(null, d), (e) => callback(e));
    return promise;
  };
  api.listEffects = () => effectsApi.listEffects();
  api.listAvatarEffects = () => effectsApi.listAvatarEffects();
  api.isAvatarSupported = () => effectsApi.isAvatarSupported();
  api.effects = {
    sendEffect: api.sendEffect,
    sendAvatarEffect: api.sendAvatarEffect,
    listEffects: api.listEffects,
    listAvatarEffects: api.listAvatarEffects,
    isAvatarSupported: api.isAvatarSupported,
  };
  api.createPoll = withCallback((threadID, question, options) => messageActions.createPoll(client, threadID, question, options));

  // --- Threads ------------------------------------------------------------
  api.getThreadList = withCallback((limit, timestamp, tags) => threadGraphql.getThreadList(client, formatter, limit, timestamp === undefined ? null : timestamp, tags === undefined ? [""] : tags));
  api.getThreadInfo = withCallback(async (threadID) => {
    const info = await threadGraphql.getThreadInfo(client, formatter, threadID);
    if (info && typeof info === "object") {
      if (info.userInfo) for (const u of info.userInfo) if (u && u.name) formatter.setUserName(u.id || u.userID, u.name);
    }
    return info;
  });
  api.getThreadHistory = withCallback((threadID, amount, timestamp) => threadApi.getThreadHistory(client, formatter, threadID, amount, timestamp));
  api.getThreadPictures = withCallback((threadID, offset, limit) => threadApi.getThreadPictures(client, threadID, offset, limit));
  api.searchForThread = withCallback((query) => threadApi.searchForThread(client, formatter, query));
  api.markAsRead = withCallback((threadID, timestamp) => threadApi.markAsRead(client, threadID, timestamp));
  api.markAsDelivered = withCallback((threadID, messageID) => threadApi.markAsDelivered(client, threadID, messageID));
  api.markAsSeen = withCallback((seenTimestamp) => threadApi.markAsSeen(client, seenTimestamp));
  api.sendTypingIndicator = function sendTypingIndicator(threadID, isTypingOrCallback, isGroupOrCallback, maybeCallback) {
    let isTyping = true;
    let isGroup;
    let callback = null;
    if (typeof isTypingOrCallback === "boolean") {
      isTyping = isTypingOrCallback;
      if (typeof isGroupOrCallback === "function") callback = isGroupOrCallback;
      else if (typeof maybeCallback === "function") callback = maybeCallback;
      const promise = threadApi.sendTypingIndicator(client, threadID, isTyping, isGroup);
      if (callback) promise.then(() => callback(null), (err) => callback(err));
      return promise;
    }
    if (typeof isGroupOrCallback === "boolean") isGroup = isGroupOrCallback;
    else if (typeof isGroupOrCallback === "function") callback = isGroupOrCallback;
    const start = threadApi.sendTypingIndicator(client, threadID, true, isGroup);
    const done = () => threadApi.sendTypingIndicator(client, threadID, false, isGroup);
    if (callback) start.then(() => callback(null), (err) => callback(err));
    return function end(cb) {
      const p = done();
      if (typeof cb === "function") p.then(() => cb(null), (err) => cb(err));
      return p;
    };
  };
  api.muteThread = withCallback((threadID, muteSeconds) => threadApi.muteThread(client, threadID, muteSeconds));
  api.changeArchivedStatus = withCallback((threadID, archive) => threadApi.changeArchivedStatus(client, threadID, archive));
  api.setTitle = withCallback((title, threadID) => threadApi.setTitle(client, threadID, title));
  api.changeNickname = withCallback((nickname, threadID, participantID) => threadApi.changeNickname(client, nickname, threadID, participantID));
  api.changeThreadColor = withCallback((color, threadID) => threadApi.changeThreadColor(client, color, threadID));
  api.changeThreadEmoji = withCallback((emoji, threadID) => threadApi.changeThreadEmoji(client, emoji, threadID));
  api.changeGroupImage = withCallback((image, threadID) => threadApi.changeGroupImage(client, image, threadID));
  api.createAITheme = withCallback((prompt) => themeApi.createAITheme(client, prompt));
  api.setThreadTheme = withCallback((threadID, themeID) => themeApi.setThreadTheme(client, threadID, themeID));
  api.changeTheme = withCallback((prompt, threadID) => themeApi.changeTheme(client, prompt, threadID));
  api.setTheme = withCallback((threadID, themeID) => themeApi.setThreadTheme(client, threadID, themeID));
  api.searchMusic = withCallback((query, options) => musicApi.searchMusic(client, query, options));
  api.sendMusicSticker = function sendMusicSticker(track, threadID, callback) {
    if (typeof threadID === "function") {
      callback = threadID;
      threadID = undefined;
    }
    let song = track;
    if (getType(song) === "Object") {
      song = Object.assign({}, song, {
        songId: song.songId || song.song_id || song.audioAssetId || song.audio_asset_id || song.id,
      });
    }
    const promise = musicApi.sendMusicSticker(client, song, threadID);
    if (callback) promise.then((d) => callback(null, d), (e) => callback(e));
    return promise;
  };
  api.changeAdminStatus = withCallback((threadID, adminIDs, adminStatus) => threadApi.changeAdminStatus(client, threadID, adminIDs, adminStatus));
  api.addUserToGroup = withCallback((userIDs, threadID) => threadApi.addUserToGroup(client, userIDs, threadID));
  api.removeUserFromGroup = withCallback((userID, threadID) => threadApi.removeUserFromGroup(client, userID, threadID));
  api.deleteThread = withCallback((threadID) => threadApi.deleteThread(client, threadID));
  api.createNewGroup = withCallback((participantIDs, groupTitle) => threadApi.createNewGroup(client, participantIDs, groupTitle));
  api.changeBlockedStatus = withCallback((userID, block) => threadApi.changeBlockedStatus(client, userID, block));
  api.markAsReadAll = withCallback(() => threadApi.markAsReadAll(client));
  api.unfriend = withCallback((userID) => threadApi.unfriend(client, userID));
  api.handleFriendRequest = withCallback((userID, accept) => threadApi.handleFriendRequest(client, userID, accept));
  api.handleMessageRequest = withCallback((threadID, accept) => threadApi.handleMessageRequest(client, threadID, accept));

  // --- Users --------------------------------------------------------------
  api.getUserInfo = withCallback((ids) => userApi.getUserInfo(client, ids));
  api.getUserID = withCallback((username) => userApi.getUserID(client, username));
  api.getFriendsList = withCallback(() => userApi.getFriendsList(client));

  // --- Profile ------------------------------------------------------------
  api.changeAvatar = function changeAvatar(image, caption, timestamp, callback) {
    if (typeof caption === "function") {
      callback = caption;
      caption = "";
      timestamp = null;
    } else if (typeof timestamp === "function") {
      callback = timestamp;
      timestamp = null;
    }
    const promise = profileApi.changeAvatar(client, image, caption || "", timestamp || null);
    if (callback) promise.then((d) => callback(null, d), (e) => callback(e));
    return promise;
  };
  api.changeBio = function changeBio(bio, publish, callback) {
    if (typeof publish === "function") {
      callback = publish;
      publish = false;
    }
    const promise = profileApi.changeBio(client, bio, publish);
    if (callback) promise.then((d) => callback(null, d), (e) => callback(e));
    return promise;
  };
  api.setPostReaction = function setPostReaction(postID, type, callback) {
    if (typeof type === "function") {
      callback = type;
      type = 0;
    }
    const promise = profileApi.setPostReaction(client, postID, type);
    if (callback) promise.then((d) => callback(null, d), (e) => callback(e));
    return promise;
  };

  // --- Raw HTTP -----------------------------------------------------------
  api.httpGet = function httpGet(url, form, customHeader, callback, notAPI) {
    return rawHttp(api, httpApi.httpGet, [url, form, customHeader, notAPI], callback);
  };
  api.httpPost = function httpPost(url, form, customHeader, callback, notAPI) {
    return rawHttp(api, httpApi.httpPost, [url, form, customHeader, notAPI], callback);
  };
  api.httpPostFormData = function httpPostFormData(url, form, customHeader, callback, notAPI) {
    return rawHttp(api, httpApi.httpPostFormData, [url, form, customHeader, notAPI], callback);
  };

  // --- Misc ---------------------------------------------------------------
  api.resolvePhotoUrl = withCallback((photoID) => resolvePhotoUrl(client, photoID));
  api.getEmojiUrl = (emoji, size, pixelRatio) => getEmojiUrl(emoji, size, pixelRatio);
  api.threadColors = require("./src/threadColors").THREAD_COLORS;
  api.addExternalModule = (moduleObj) => {
    if (getType(moduleObj) !== "Object") throw new Error("moduleObj must be an object, not " + getType(moduleObj) + "!");
    for (const apiName of Object.keys(moduleObj)) {
      if (getType(moduleObj[apiName]) !== "Function") {
        throw new Error('Item "' + apiName + '" in moduleObj must be a function, not ' + getType(moduleObj[apiName]) + "!");
      }
      api[apiName] = moduleObj[apiName](client, api, globalOptions);
    }
    return api;
  };
  api.refreshFb_dtsg = withCallback(async (obj) => {
    if (getType(obj) === "Object" && Object.keys(obj).length > 0) {
      if (obj.fb_dtsg !== undefined) client.configs.dtsg = obj.fb_dtsg;
      if (obj.jazoest !== undefined) client.configs.jazoest = obj.jazoest;
      return { data: obj, message: "refreshed " + Object.keys(obj).join(", ") };
    }
    const tokens = await client.refreshTokens();
    return {
      data: { fb_dtsg: tokens.fb_dtsg, jazoest: tokens.jazoest },
      message: "refreshed fb_dtsg and jazoest",
    };
  });
  api.logout = withCallback(async () => {
    client.disconnect();
    return true;
  });

  // --- Listening ----------------------------------------------------------
  api.listenMqtt = (callback) => {
    const handle = listenMqtt(client, formatter, callback, {
      emitReady: globalOptions.emitReady === true,
      replayGraceMs: globalOptions.replayGraceMs,
      autoMarkDelivery: globalOptions.autoMarkDelivery === true,
      autoMarkRead: globalOptions.autoMarkRead === true,
    });
    api.stopListening = (cb) => handle.stopListening(cb);
    api.stopListeningAsync = () => handle.stopListeningAsync();
    return handle;
  };
  api.forceReconnect = () => client.forceReconnect();
  api.fullReconnect = () => client.fullReconnect();
  api.canReconnect = () => client.canReconnect();

  api.stopListening = () => {};
  api.stopListeningAsync = () => Promise.resolve();

  return api;
}

function resolvePhotoUrl(client, photoID) {
  const { httpGet } = require("./src/api/http");
  return httpGet(client, "https://www.facebook.com/mercury/attachments/photo", { photo_id: photoID }).then((res) => {
    const url = res && res.jsmods && res.jsmods.require && res.jsmods.require[0] && res.jsmods.require[0][3] && res.jsmods.require[0][3][0];
    if (!url) throw { error: "resolvePhotoUrl: could not resolve photo url", res };
    return url;
  });
}

function getEmojiUrl(emoji, size, pixelRatio) {
  const ratio = pixelRatio || "1.0";
  const ending = ratio + "/" + (size === undefined ? 32 : size) + "/" + emoji.codePointAt(0).toString(16) + ".png";
  let base = 317426846;
  for (let i = 0; i < ending.length; i++) {
    base = (base << 5) - base + ending.charCodeAt(i);
  }
  const hashed = (base & 255).toString(16);
  return "https://static.xx.fbcdn.net/images/emoji.php/v8/z" + hashed + "/" + ending;
}

async function login(credentials, options, callback) {
  if (typeof options === "function") {
    callback = options;
    options = {};
  }
  options = options || {};
  const promise = (async () => {
    const appState = Array.isArray(credentials) ? credentials : credentials && credentials.appState;
    if (!appState) {
      throw new Error("login requires an appState cookie array (cookies from a logged-in browser session).");
    }
    const cookies = cookiesFromAppState(appState);
    const client = new Client({
      cookies,
      userAgent: options.userAgent,
      proxy: options.proxy,
      host: options.host,
      autoReconnect: options.autoReconnect,
      forceRefreshIntervalMs: options.forceRefreshIntervalMs,
      minFullReconnectMs: options.minFullReconnectMs,
    });
    await client.loadMessagesPage();
    if (!client.isLoggedIn) throw errors.tokenInvalidated;
    return buildApi(client, Object.assign({}, DEFAULT_OPTIONS, options));
  })();
  if (typeof callback === "function") {
    promise.then((api) => callback(null, api), (err) => callback(err));
  }
  return promise;
}

module.exports = login;
module.exports.login = login;
module.exports.Client = Client;
module.exports.Cookies = Cookies;
module.exports.cookiesFromAppState = cookiesFromAppState;
module.exports.getType = getType;
