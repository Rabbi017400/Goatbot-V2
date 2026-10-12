"use strict";

const assert = require("assert");

const login = require("..");
assert.strictEqual(typeof login, "function");

const { cookiesFromAppState } = require("../src/cookies");
const { decodeLSData } = require("../src/lightspeed");
const { EventFormatter } = require("../src/eventFormatter");
const { DgwSocket } = require("../src/socket/client");
const frames = require("../src/socket/frames");
const { TaskManager, sendMessageTask, acceptMessageRequestTask } = require("../src/tasks");
const { parseBootstrap } = require("../src/moduleParser");
const { generateEpochID, stringifyBigInt, generateOfflineThreadingID } = require("../src/utils");
const { Bitmap } = require("../src/crypto/bitmap");
const { ABTestData } = require("../src/crypto/abtest");

const cookies = cookiesFromAppState([{ key: "xs", value: "abc" }, { key: "c_user", value: "123" }]);
assert.strictEqual(cookies.isLoggedIn(), true);
assert.strictEqual(cookies.getUserID(), "123");
assert.strictEqual(cookies.toString(), "xs=abc; c_user=123");

const epoch = generateEpochID();
assert.strictEqual(typeof epoch, "bigint");
const encoded = stringifyBigInt({ epoch_id: epoch });
assert.ok(/^\{"epoch_id":\d+\}$/.test(encoded), "epoch id must be a raw integer: " + encoded);

const dataFrame = frames.encodeDataFrame(7, Buffer.from("hello"), { requiresAck: true, ackID: 3 });
const decoded = frames.decodeFrame(dataFrame);
assert.strictEqual(decoded.frame.type, frames.FRAME_TYPE.DATA);
assert.strictEqual(decoded.frame.streamID, 7);
assert.strictEqual(decoded.frame.ackID, 3);
assert.strictEqual(decoded.frame.requiresAck, true);
assert.strictEqual(decoded.frame.payload.toString(), "hello");
assert.strictEqual(decoded.rest.length, 0);

const decodedAck = frames.decodeFrame(frames.encodeAck(9, 5));
assert.strictEqual(decodedAck.frame.streamID, 9);
assert.strictEqual(decodedAck.frame.ackID, 5);

assert.strictEqual(frames.decodeFrame(frames.encodeEndOfData(4)).frame.streamID, 4);

const sp = ["insertMessage"];
const msgFields = [];
msgFields[0] = "hello world";
msgFields[3] = 100;
msgFields[5] = 1700000000000;
msgFields[8] = "mid.$abc";
msgFields[9] = "otid-1";
msgFields[10] = 12345;
const steps = [1, [5, "insertMessage", ...msgFields]];
const table = decodeLSData({ step: steps }, sp);
assert.ok(table.LSInsertMessage, "expected LSInsertMessage to be decoded");
assert.strictEqual(table.LSInsertMessage[0].Text, "hello world");
assert.strictEqual(table.LSInsertMessage[0].MessageId, "mid.$abc");
assert.strictEqual(table.LSInsertMessage[0].SenderId, 12345);

const { parseLossless } = require("../src/bigjson");
const { toBigOrNumber } = require("../src/utils");
const parsedBig = parseLossless('{"ThreadKey":27628698476797803,"ContactId":10001564263269473,"Safe":42}');
assert.strictEqual(parsedBig.ThreadKey, 27628698476797803n, "int64 above MAX_SAFE_INTEGER must stay exact");
assert.strictEqual(String(parsedBig.ThreadKey), "27628698476797803");
assert.strictEqual(parsedBig.ContactId, 10001564263269473n);
assert.strictEqual(parsedBig.Safe, 42);
assert.strictEqual(parseLossless('{"s":"27628698476797803"}').s, "27628698476797803", "strings must not be rewritten");

const bigFields = [];
bigFields[3] = "27628698476797803";
bigFields[5] = 1700000000000;
bigFields[8] = "mid.$big";
bigFields[10] = "10001564263269473";
const bigTable = decodeLSData({ step: [1, [5, "insertMessage", ...bigFields]] }, ["insertMessage"]);
assert.strictEqual(bigTable.LSInsertMessage[0].ThreadKey, 27628698476797803n, "decoder must preserve int64 thread ids");
assert.strictEqual(String(bigTable.LSInsertMessage[0].ThreadKey), "27628698476797803");
assert.strictEqual(bigTable.LSInsertMessage[0].SenderId, 10001564263269473n);

assert.strictEqual(toBigOrNumber("42"), 42, "safe ids stay plain numbers for legacy compatibility");
assert.strictEqual(toBigOrNumber("27628698476797803"), 27628698476797803n, "unsafe ids stay exact");
assert.strictEqual(String(toBigOrNumber(27628698476797803n)), "27628698476797803");

const bigSp = ["updateOrInsertThread"];
const threadFields = [];
threadFields[7] = "27628698476797803";
threadFields[9] = 2;
const bigThreadTable = decodeLSData({ step: [1, [5, "updateOrInsertThread", ...threadFields]] }, bigSp);
assert.strictEqual(bigThreadTable.LSUpdateOrInsertThread[0].ThreadKey, 27628698476797803n);
const bigFormatter = new EventFormatter({ getCurrentUserID: () => "999" }, {});
bigFormatter.processTable(bigThreadTable);
assert.strictEqual(bigFormatter.getThreadMeta("27628698476797803").isGroup, true, "big thread id must be findable by its exact string");

const fakeClient = { getCurrentUserID: () => "999" };
const formatter = new EventFormatter(fakeClient, { selfListen: true });

const goatFormatter = new EventFormatter(fakeClient, { selfListen: false, selfListenEvent: true, listenEvents: true });
goatFormatter.updateThreadMeta(200, { threadID: "200", isGroup: true, participantIDs: ["999", "111"] });
const goatEvents = goatFormatter.processTable({
  LSInsertMessage: [{ MessageId: "a1", ThreadKey: 200, SenderId: "999", TimestampMs: 1, IsAdminMessage: true, MessageRenderingType: 3, Text: "New name" }],
});
assert.strictEqual(goatEvents.length, 1, "own admin event must pass with selfListenEvent");
assert.strictEqual(goatEvents[0].logMessageType, "log:thread-name");
const ownMessageEvents = goatFormatter.processTable({
  LSInsertMessage: [{ MessageId: "a2", ThreadKey: 200, SenderId: "999", TimestampMs: 2, Text: "hello" }],
});
assert.strictEqual(ownMessageEvents.length, 0, "own normal message must be suppressed when selfListen is false");
formatter.updateThreadMeta(100, { threadID: "100", isGroup: true, participantIDs: ["1", "2"] });
const events = formatter.processTable(table);
const message = events.find((e) => e.type === "message");
assert.ok(message, "expected a message event");
assert.strictEqual(message.body, "hello world");
assert.strictEqual(message.senderID, "12345");
assert.strictEqual(message.threadID, "100");
assert.strictEqual(message.isGroup, true);

const fakeClient2 = { configs: { versionID: 123 }, _getTaskID: () => 1 };
const tm = new TaskManager(fakeClient2);
const sendTask = sendMessageTask(fakeClient2, { threadID: 42, otid: 1, text: "hi" });
tm.addTask(sendTask.label, sendTask.payload, sendTask.queueName);
const payload = JSON.parse(tm.finalizePayload());
assert.strictEqual(payload.version_id, "123");
assert.strictEqual(payload.tasks[0].label, "46");
assert.strictEqual(payload.tasks[0].queue_name, "42");
assert.ok(payload.epoch_id > 0);

const replyTask = sendMessageTask(fakeClient2, { threadID: 42, otid: 2, text: "hi", replyToMessage: "mid.$x" });
assert.deepStrictEqual(replyTask.payload.reply_metadata, { reply_source_id: "mid.$x", reply_source_type: 1, reply_type: 0 });
const sendTaskNoReply = sendMessageTask(fakeClient2, { threadID: 42, otid: 3, text: "hi" });
assert.strictEqual(sendTaskNoReply.payload.reply_metadata, undefined);

const acceptTask = acceptMessageRequestTask(123456789);
assert.strictEqual(acceptTask.label, "66");
assert.strictEqual(acceptTask.queueName, "message_request");
assert.strictEqual(acceptTask.payload.sync_group, 95, "message requests live in sync group 95");
assert.strictEqual(acceptTask.payload.thread_key, 123456789);

const { reactionTask } = require("../src/tasks");
const reactionNoThread = reactionTask({ messageID: "m1", actorID: 5, reaction: "\u2764" });
assert.strictEqual(reactionNoThread.payload.thread_key, undefined, "thread_key is optional on Lightspeed");
assert.strictEqual(reactionNoThread.payload.reaction_style, null);
assert.strictEqual(reactionNoThread.queueName, JSON.stringify(["reaction", "m1"]));
const reactionAnyEmoji = reactionTask({ threadID: 9, messageID: "m1", actorID: 5, reaction: "\uD83D\uDD25" });
assert.strictEqual(reactionAnyEmoji.payload.thread_key, 9);
assert.strictEqual(reactionAnyEmoji.payload.reaction_style, null, "every reaction uses the standard reaction_style");

const bitmap = new Bitmap();
bitmap.update([1, 2, 3]);
assert.ok(bitmap.toCompressedString().compressedStr.length > 0);

const ab = new ABTestData();
assert.ok(ab.generateAbTestData(["hello"]).length > 0);

const html = `<html><body><script>requireLazy(["Bootloader"],function(Bootloader){Bootloader.handlePayload("{}")});</script></body></html>`;
assert.ok(parseBootstrap(Buffer.from(html)).configs);

const socket = new DgwSocket({
  getCookies: () => "xs=abc",
  origin: "https://www.facebook.com",
  wsURL: "wss://gateway.facebook.com/ws/lightspeed",
  appID: "123",
  userID: "456",
});
assert.strictEqual(socket.isConnected(), false);

assert.ok(/^\d+$/.test(generateOfflineThreadingID()));

const { Client } = require("../src/client");
const client = new Client({ appState: [{ key: "xs", value: "a" }, { key: "c_user", value: "1" }] });
assert.strictEqual(typeof client.newHTTPQuery, "function");

const { RENDERING_TYPE } = require("../src/eventFormatter");
assert.strictEqual(RENDERING_TYPE[1], "log:subscribe");
assert.strictEqual(RENDERING_TYPE[3], "log:thread-name");
assert.strictEqual(RENDERING_TYPE[8], "log:thread-admins");

const adminFormatter = new EventFormatter(fakeClient, { selfListen: true });
const UID1 = "100000000000001";
const UID2 = "100000000000002";
const UID3 = "100000000000003";
const UID4 = "100000000000004";
adminFormatter.updateThreadMeta(200, { threadID: "200", isGroup: true, participantIDs: [UID1, UID2, UID3] });
adminFormatter.updateContact(UID2, { name: "Bob" });
const subscribeEvt = adminFormatter.formatAdminMessage({ MessageId: "m1", ThreadKey: 200, SenderId: UID1, TimestampMs: 5, IsAdminMessage: true, MessageRenderingType: 1, Text: UID2 }, "200", []);
assert.strictEqual(subscribeEvt.type, "event");
assert.strictEqual(subscribeEvt.logMessageType, "log:subscribe");
assert.deepStrictEqual(subscribeEvt.logMessageData.addedParticipants, [{ userFbId: UID2, fullName: "Bob" }]);

const nameEvt = adminFormatter.formatAdminMessage({ MessageId: "m2", ThreadKey: 200, SenderId: UID1, TimestampMs: 6, IsAdminMessage: true, MessageRenderingType: 3, Text: "New name" }, "200", []);
assert.strictEqual(nameEvt.logMessageType, "log:thread-name");
assert.strictEqual(nameEvt.logMessageData.name, "New name");

const adminEvt = adminFormatter.formatAdminMessage({ MessageId: "m3", ThreadKey: 200, SenderId: UID1, TimestampMs: 7, IsAdminMessage: true, MessageRenderingType: 8, Text: UID2 }, "200", []);
assert.strictEqual(adminEvt.logMessageType, "log:thread-admins");
assert.strictEqual(adminEvt.logMessageData.TARGET_ID, UID2);
assert.strictEqual(adminEvt.logMessageData.ADMIN_EVENT, "add_admin");

const nickEvt = adminFormatter.formatAdminMessage({ MessageId: "m4", ThreadKey: 200, SenderId: UID1, TimestampMs: 8, IsAdminMessage: true, MessageRenderingType: 7, Text: "Bobby", MentionIds: UID2 }, "200", []);
assert.strictEqual(nickEvt.logMessageType, "log:user-nickname");
assert.strictEqual(nickEvt.logMessageData.participant_id, UID2);

const threadTable = { LSAddParticipantIdToGroupThread: [{ ThreadKey: 200, ContactId: UID4, Nickname: "Dan", IsAdmin: true }] };
adminFormatter.absorb(threadTable);
const meta200 = adminFormatter.getThreadMeta(200);
assert.ok(meta200.participantIDs.includes(UID4));
assert.strictEqual(meta200.nicknames[UID4], "Dan");
assert.ok(meta200.adminIDs.includes(UID4));

const richFormatter = new EventFormatter(fakeClient, { selfListen: true });
richFormatter.updateThreadMeta(300, { threadID: "300", isGroup: true, participantIDs: [UID1, UID2], adminIDs: [UID1] });
richFormatter.updateContact(UID2, { name: "Bob" });
const promoteTable = {
  LSUpdateThreadParticipantAdminStatus: [{ ThreadKey: 300, ContactId: UID2, IsAdmin: true }],
  LSInsertMessage: [{ MessageId: "a1", ThreadKey: 300, SenderId: UID1, TimestampMs: 1, IsAdminMessage: true, MessageRenderingType: 8, Text: UID2 }],
};
const promoteEvents = richFormatter.processTable(promoteTable);
const promote = promoteEvents.find((e) => e.logMessageType === "log:thread-admins");
assert.ok(promote, "expected log:thread-admins event");
assert.strictEqual(promote.logMessageData.ADMIN_EVENT, "add_admin");
assert.strictEqual(promote.senderID, UID1);
assert.strictEqual(promote.body, UID2);

const demoteTable = {
  LSUpdateThreadParticipantAdminStatus: [{ ThreadKey: 300, ContactId: UID2, IsAdmin: false }],
  LSInsertMessage: [{ MessageId: "a2", ThreadKey: 300, SenderId: UID1, TimestampMs: 2, IsAdminMessage: true, MessageRenderingType: 8, Text: UID2 }],
};
const demote = richFormatter.processTable(demoteTable).find((e) => e.logMessageType === "log:thread-admins");
assert.strictEqual(demote.logMessageData.ADMIN_EVENT, "remove_admin");

const subFormatter = new EventFormatter(fakeClient, { selfListen: true });
subFormatter.updateThreadMeta(400, { threadID: "400", isGroup: true, participantIDs: [UID1, UID2] });
subFormatter.updateContact(UID3, { name: "Carol" });
const subTable = {
  LSAddParticipantIdToGroupThread: [{ ThreadKey: 400, ContactId: UID3 }],
  LSInsertMessage: [{ MessageId: "s1", ThreadKey: 400, SenderId: UID1, TimestampMs: 3, IsAdminMessage: true, MessageRenderingType: 1, Text: "" }],
};
const subEvt = subFormatter.processTable(subTable).find((e) => e.logMessageType === "log:subscribe");
assert.deepStrictEqual(subEvt.logMessageData.addedParticipants, [{ userFbId: UID3, fullName: "Carol" }]);

const typTable = { LSUpdateTypingIndicator: [{ ThreadKey: 300, SenderId: UID2, IsTyping: true }] };
const typEvt = richFormatter.processTable(typTable).find((e) => e.type === "typ");
assert.strictEqual(typEvt.fromMobile, false);
assert.strictEqual(typEvt.userID, UID2);

const unsendFormatter = new EventFormatter(fakeClient, { selfListen: true });
unsendFormatter.updateThreadMeta(500, { threadID: "500", isGroup: true });
unsendFormatter.processTable({ LSInsertMessage: [{ MessageId: "u1", ThreadKey: 500, SenderId: UID2, TimestampMs: 10, Text: "hi" }] });
const unsend = unsendFormatter.processTable({ LSDeleteMessage: [{ ThreadKey: 500, MessageId: "u1" }] }).find((e) => e.type === "message_unsend");
assert.strictEqual(unsend.senderID, UID2);
assert.ok(unsend.timestamp > 0);

const attFormatter = new EventFormatter(fakeClient, { selfListen: true });
attFormatter.updateThreadMeta(600, { threadID: "600", isGroup: true });
attFormatter.absorb({ LSInsertAttachment: [{ MessageId: "att1", ThreadKey: 600, AttachmentFbid: "9", AttachmentType: 2, PreviewUrl: "http://p", ImageUrl: "http://i", PreviewWidth: 10, PreviewHeight: 20 }] });
const attMsg = attFormatter.formatMessage({ MessageId: "att1", ThreadKey: 600, SenderId: UID2, TimestampMs: 11, Text: "" });
assert.strictEqual(attMsg.attachments[0].previewWidth, 10);
assert.strictEqual(attMsg.attachments[0].previewHeight, 20);

const { EventEmitter } = require("events");
const { listenMqtt } = require("../src/listen");
const liveClient = new EventEmitter();
liveClient.getCurrentUserID = () => "999";
liveClient.connect = async () => {};
liveClient.sendTasks = async () => {};
liveClient.disconnect = () => {};
liveClient._messageThreadMap = new Map();
const liveFormatter = new EventFormatter(liveClient, { selfListen: true });
const dispatched = [];
const liveHandle = listenMqtt(liveClient, liveFormatter, (err, ev) => dispatched.push([err, ev]), { emitReady: true });
liveClient.emit("ls-table", { LSInsertMessage: [{ MessageId: "m1", ThreadKey: 700, SenderId: UID2, TimestampMs: Date.now(), Text: "hello" }] });
liveClient.emit("ls-table", { LSInsertMessage: [{ MessageId: "m2", ThreadKey: 700, SenderId: UID2, TimestampMs: Date.now() + 1, Text: "reply", ReplySourceId: "m1", ReplyToUserId: UID1, ReplyMessageText: "hello" }] });
assert.strictEqual(dispatched[0][1].type, "message");
assert.strictEqual(dispatched[1][1].type, "message_reply");
assert.strictEqual(dispatched[1][1].messageReply.messageID, "m1");
assert.strictEqual(liveClient._messageThreadMap.get("m1"), "700");
liveHandle.stopListening(() => {});

const { threadToInfo } = require("../src/api/thread");
const info = threadToInfo(null, {
  ThreadKey: 200,
  ThreadName: "Group",
  ThreadType: 2,
  UnreadMessageCount: 3,
  MessageCount: 9,
  LastActivityTimestampMs: 1700000000000,
  FolderName: "inbox",
}, null);
assert.strictEqual(info.threadID, "200");
assert.strictEqual(info.isGroup, true);
assert.strictEqual(info.threadType, 2);
assert.deepStrictEqual(info.approvalQueue, []);
assert.deepStrictEqual(info.snippetAttachments, []);
assert.strictEqual(info.isCanonical, false);
assert.strictEqual(info.canReply, true);
assert.strictEqual(info.recipientsLoadable, true);
assert.deepStrictEqual(info.inviteLink, { enable: false, link: null });
assert.strictEqual(info.lastMessageType, "message");

const threadGraphql = require("../src/api/threadGraphql");
const { parseBatchJSON } = require("../src/http");
const threadPayload = {
  o0: {
    data: {
      message_thread: {
        thread_key: { thread_fbid: "200" },
        thread_type: "GROUP",
        name: "Group",
        all_participants: { edges: [{ node: { messaging_actor: { id: "100000000000001", name: "Alice", __typename: "User" } } }] },
        thread_admins: [{ id: "100000000000001" }],
        customization_info: {
          emoji: "\uD83D\uDE00",
          outgoing_bubble_color: "FF0000FF",
          participant_customizations: [{ participant_id: "100000000000001", nickname: "Al" }],
        },
        image: { uri: "http://img" },
        last_message: { nodes: [{ snippet: "hi", timestamp_precise: "1700000000000", message_sender: { messaging_actor: { id: "100000000000001" } } }] },
        joinable_mode: { mode: 1, link: "http://link" },
      },
    },
  },
};
const batch = parseBatchJSON(Buffer.from("for (;;);" + JSON.stringify(threadPayload) + "\r\n" + JSON.stringify({ error_results: 0, successful_results: 1 })));
assert.ok(Array.isArray(batch) && batch.length === 2, "parseBatchJSON must split concatenated objects");
const formattedInfo = threadGraphql.formatThreadFromGraphQL(batch[0].o0.data.message_thread);
assert.strictEqual(formattedInfo.threadID, "200");
assert.strictEqual(formattedInfo.isGroup, true);
assert.strictEqual(formattedInfo.threadType, 2);
assert.deepStrictEqual(formattedInfo.adminIDs, [{ id: "100000000000001" }]);
assert.strictEqual(formattedInfo.nicknames["100000000000001"], "Al");
assert.strictEqual(formattedInfo.color, "0000FF");
assert.deepStrictEqual(formattedInfo.inviteLink, { enable: true, link: "http://link" });
assert.strictEqual(formattedInfo.canReply, true);
assert.strictEqual(formattedInfo.userInfo[0].name, "Alice");
const listItem = threadGraphql.formatThreadListItem({ thread_key: { other_user_id: "300" }, thread_type: "ONE_TO_ONE", all_participants: { edges: [] }, last_message: { nodes: [] } });
assert.strictEqual(listItem.threadID, "300");
assert.strictEqual(listItem.isGroup, false);
assert.strictEqual(listItem.threadType, 1);
assert.deepStrictEqual(listItem.approvalQueue, []);

const { scoreTrack, rankResults, normalizeTrack } = require("../src/api/music");

assert.strictEqual(scoreTrack("kesariya", { title: "Kesariya", artist: "Pritam", album: "Brahmastra" }), 1);
assert.ok(scoreTrack("Tere Pyaar mein", { title: "Terre Pyaar Mein", artist: "Himesh" }) >= 0.6);
assert.ok(scoreTrack("kesariya", { title: "Hum Bhool Gaye", artist: "Malik Tayyab" }) < 0.2);
const musicEdges = [
  { node: { item: { display_id: "1", title: { text: "Balamua Maare" }, display_artist: { text: "Neelkamal Singh" } } } },
  { node: { item: { display_id: "2", song_id: "2002", title: { text: "Kesariya" }, display_artist: { text: "Pritam" }, progressive_download: [{ url: "http://dl" }] } } },
  { node: { item: { display_id: "3", song_id: "3003", title: { text: "Kesariya" }, display_artist: { text: "Ali Khan" } } } },
];
const ranked = rankResults("kesariya", musicEdges, {});
assert.deepStrictEqual(ranked.map((item) => item.id), ["2", "3"]);
// The sticker id is `song_id`, not the picker `display_id`; tag containers
// expose their tracks under `sub_items`.
assert.strictEqual(ranked[0].songId, "2002");
const tagged = rankResults("kesariya", [{ node: { item: { __typename: "MusicPickerMediaTagWithAudioAssetsWrapper" }, sub_items: musicEdges.map((e) => e.node.item) } }], {});
assert.strictEqual(tagged.length, 2);
assert.strictEqual(tagged[0].songId, "2002");
const rawRanked = rankResults("kesariya", musicEdges, { exact: false });
assert.strictEqual(rawRanked.length, 3);
assert.strictEqual(rawRanked[0].score, 1);
assert.strictEqual(normalizeTrack(musicEdges[1].node.item).url, "http://dl");

const { bumpMessage, bumpThread } = require("../src/api/bumpMessage");
assert.strictEqual(typeof bumpMessage, "function");
assert.strictEqual(typeof bumpThread, "function");

const bumpTask = sendMessageTask(fakeClient2, { threadID: 42, otid: 1, text: "", replyToMessage: "mid.$x", replyType: 1, attachmentFBIds: [], stickerId: 0, sendType: 1, source: 65537, hotEmojiSize: 0, initiatingSource: 1 });
const bumpPayload = bumpTask.payload;
assert.strictEqual(bumpPayload.reply_metadata.reply_source_id, "mid.$x");
assert.strictEqual(bumpPayload.reply_metadata.reply_type, 1);
assert.ok(!("text" in bumpPayload), "bump must not carry text");

const effectTask = sendMessageTask(fakeClient2, { threadID: 42, otid: 1, text: "hi", powerUpStyle: 4 });
assert.strictEqual(effectTask.payload.power_up_style, 4);

// --- Anti-suspension regression guards -----------------------------------
// A real Messenger client always tags the message origin. Leaving source at 0
// (UNKNOWN) was a per-message bot marker; it must default to MESSENGER_INBOX_IN_THREAD.
const { THREAD_SOURCE, INITIATING_SOURCE, forwardMessageTask, typingTask } = require("../src/tasks");
assert.strictEqual(THREAD_SOURCE.MESSENGER_INBOX_IN_THREAD, 65537);
assert.strictEqual(INITIATING_SOURCE.FACEBOOK_INBOX, 1);
assert.strictEqual(sendTaskNoReply.payload.source, 65537, "send must default to MESSENGER_INBOX_IN_THREAD");
assert.strictEqual(sendMessageTask(fakeClient2, { threadID: 1, otid: 1, text: "x" }).payload.initiating_source, undefined, "initiating_source is caller-supplied");
assert.strictEqual(forwardMessageTask(1, "o", "mid.$f").payload.source, 65537, "forwards must also carry the origin");
assert.strictEqual(typingTask(1, true, false).payload.attribution, 0, "presence attribution stays 0, matching mautrix");

const { removeSpecialChar } = require("../src/utils");
assert.strictEqual(removeSpecialChar("a\uFE0Fb"), "a\uFE0Fb", "emoji variation selector must be preserved");
assert.strictEqual(removeSpecialChar("\uFEFFhi"), "hi", "a leading BOM must be stripped");
assert.strictEqual(removeSpecialChar("hi\u2764\uFE0F"), "hi\u2764\uFE0F", "heart with VS16 must survive intact");

const { parseUserAgent: pua, buildClientHints: bch, buildDocumentHeaders } = require("../src/useragent");
const mobileHints = bch(pua("Mozilla/5.0 (Linux; Android 12) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/101.0.0.0 Mobile Safari/537.36"));
assert.strictEqual(mobileHints["sec-ch-ua-mobile"], "?1", "a mobile UA must produce mobile client hints");
assert.strictEqual(mobileHints["sec-ch-ua-platform"], '"Android"');
assert.ok(mobileHints["sec-ch-ua"].includes("Google Chrome"), "hints must not claim a different browser than the UA");
const docHeaders = buildDocumentHeaders("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36");
assert.strictEqual(docHeaders["sec-ch-ua-mobile"], "?0");
assert.strictEqual(docHeaders["user-agent"], "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36");

const { chromeConnectOptions, CHROME_CIPHERS } = require("../src/tls");
const tlsOpts = chromeConnectOptions();
assert.deepStrictEqual(tlsOpts.ALPNProtocols, ["http/1.1"], "ALPN must be pinned to http/1.1 like a Chrome browser");
assert.ok(CHROME_CIPHERS.includes("TLS_AES_128_GCM_SHA256"));
assert.ok(!("GREASE" in tlsOpts));

const effects = require("../src/api/effects");
assert.strictEqual(effects.resolveEffect("love"), 1);
assert.strictEqual(effects.resolveEffect("gift_wrap"), 2);
assert.strictEqual(effects.resolveEffect("celebration"), 3);
assert.strictEqual(effects.resolveEffect("fire"), 4);
assert.strictEqual(effects.resolveEffect(1000), 1000);
assert.strictEqual(effects.resolveEffectTag("fire"), "FIRE");
assert.strictEqual(effects.resolveEffectTag(1001), "AVATAR_ANGRY");
assert.strictEqual(effects.isAvatarEffect("avatar_love"), true);
assert.strictEqual(effects.isAvatarEffect("fire"), false);
assert.strictEqual(effects.isAvatarEffect(1), false);
assert.ok(effects.listEffects().some((e) => e.tag === "CELEBRATION"));
assert.strictEqual(effects.listAvatarEffects().length, 4);
assert.strictEqual(effects.isAvatarSupported(), true);
const { buildSendPayload } = require("../src/api/effects/sender");
const fxPayload = buildSendPayload("7", { text: "boom", sendType: 1, powerUpStyle: 3 });
assert.strictEqual(fxPayload.power_up_style, 3);
assert.strictEqual(fxPayload.thread_id, "7");

const { getAvatar, isAvatarEffect, resolveEffectTag: retag } = require("../src/api/effects/core");
assert.strictEqual(getAvatar("angry").name, "anger");
assert.strictEqual(getAvatar("avatar_angry").name, "anger");
assert.strictEqual(getAvatar(1000).name, "love");
assert.strictEqual(getAvatar("random"), null);
assert.strictEqual(isAvatarEffect(1001), true);
assert.strictEqual(isAvatarEffect("avatar_cry"), true);
assert.strictEqual(isAvatarEffect("fire"), false);
assert.strictEqual(retag("avatar_love"), "AVATAR_LOVE");

const { editMessageTask } = require("../src/tasks");
const { editMessage } = require("../src/api/messageActions");
const { parsePublishResponse } = require("../src/api/decode");
const editTask = editMessageTask("mid.$1", "new text");
assert.strictEqual(editTask.label, "742");
assert.strictEqual(editTask.queueName, "edit_message");
assert.deepStrictEqual(editTask.payload, { message_id: "mid.$1", text: "new text" });

const editResponse = (fields) => ({
  payload: JSON.stringify({ step: [1, [5, "editMessage", ...fields]] }),
  sp: ["editMessage"],
});
const editClient = (fields) => ({ sendTasks: async () => editResponse(fields) });
assert.deepStrictEqual(
  parsePublishResponse(editResponse(["mid.$1", 0, "new text", 1])).LSEditMessage[0],
  { MessageID: "mid.$1", AuthorityLevel: 0, Text: "new text", EditCount: 1 }
);
assert.strictEqual(typeof editMessage, "function");

(async () => {
  const okEdit = await editMessage(editClient(["mid.$1", 0, "new text", 1]), "new text", "mid.$1");
  assert.deepStrictEqual(okEdit, { messageID: "mid.$1", body: "new text", editCount: 1 });
  await assert.rejects(() => editMessage(editClient(["mid.$1", 0, "old text", 1]), "new text", "mid.$1"), /too old or not from you/);
  await assert.rejects(() => editMessage(editClient(["mid.$other", 0, "new text", 1]), "new text", "mid.$1"), /different message ID/);
  await assert.rejects(() => editMessage(editClient([]), "new text", "mid.$1"), /different message ID/);
  await assert.rejects(() => editMessage(editClient(["mid.$1", 0, "new text", 1]), "", "mid.$1"), /text is required/);
  await assert.rejects(() => editMessage(editClient(["mid.$1", 0, "new text", 1]), "new text"), /messageID is required/);

  await assert.rejects(() => bumpMessage({ getCurrentUserID: () => "1" }, { bad: true }), /messageID/);

  const { parseUserAgent, buildClientHints, USER_AGENT } = require("../src/useragent");
  const hints = buildClientHints(parseUserAgent(USER_AGENT));
  assert.ok(hints["sec-ch-ua"].includes('"Google Chrome";v="141"'), "ch-hints must match UA chrome version");
  assert.ok(hints["sec-ch-ua-full-version-list"].includes("141.0.7390.122"), "full version list must match build");
  const ua142 = parseUserAgent("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36");
  assert.strictEqual(ua142.chromeVersion, "142");
  assert.ok(buildClientHints(ua142)["sec-ch-ua"].includes('"Google Chrome";v="142"'));

  const { parseRetryAfter } = require("../src/http");
  assert.strictEqual(parseRetryAfter({ get: (k) => (k === "retry-after" ? "2" : null) }), 2000);
  assert.strictEqual(parseRetryAfter({ get: () => null }), 0);
  assert.strictEqual(parseRetryAfter(null), 0);
  assert.ok(parseRetryAfter({ get: () => new Date(Date.now() + 5000).toUTCString() }) > 0);

  const messageActions = require("../src/api/messageActions");
  const reactionCalls = [];
  const reactionClient = {
    getCurrentUserID: () => "5",
    sendTasks: async (tasks) => { reactionCalls.push(tasks[0]); return {}; },
    _getMessageThread: () => "",
    _getMessageTimestamp: () => 0,
  };
  // searchMusic must not swallow a logged-out envelope as an empty result set:
  // `{"data":{},"error":1357001}` has no picker container and previously came
  // back as [] (surfacing to commands as "No song matched").
  const { searchMusic } = require("../src/api/music");
  const musicClient = (response) => ({
    makeGraphQLRequest: async () => response,
    musicTokensStale: () => false,
    refreshMusicSession: async () => false,
  });
  await assert.rejects(
    () => searchMusic(musicClient({ data: {}, error: 1357001 }), "it's you", { exact: false }),
    /session expired or not logged in/
  );
  const emptyContainer = await searchMusic(
    musicClient({ data: { xfb_music_picker_connection_container: { items: { edges: [] } } } }),
    "zzxqwkjhgfdsa",
    { exact: false }
  );
  assert.strictEqual(emptyContainer.length, 0, "a real no-match keeps the container and returns []");

  await messageActions.setMessageReaction(reactionClient, "\u2764", "mid.$a");
  assert.strictEqual(reactionCalls[0].payload.thread_key, undefined, "thread_key must be omitted when unknown");
  assert.strictEqual(reactionCalls[0].payload.reaction_style, null);
  await messageActions.setMessageReaction(reactionClient, "\uD83D\uDD25", "mid.$a", "42");
  assert.strictEqual(reactionCalls[1].payload.thread_key, 42);
  assert.strictEqual(reactionCalls[1].payload.reaction, "\uD83D\uDD25", "any unicode emoji is accepted without a force flag");
  await messageActions.setMessageReaction(reactionClient, "\uD83C\uDDFA\uD83C\uDDF8", "mid.$a", "42");
  assert.strictEqual(reactionCalls[2].payload.reaction, "\uD83C\uDDFA\uD83C\uDDF8", "flags are valid reactions");
  await messageActions.setMessageReaction(reactionClient, "", "mid.$a", "42");
  assert.strictEqual(reactionCalls[3].payload.reaction, "", "empty reaction removes the reaction");
  await assert.rejects(() => messageActions.setMessageReaction(reactionClient, "hello", "mid.$a", "42"), (err) => err.error === "Reaction is not a valid emoji.");

  const reactionFormatter = new EventFormatter(fakeClient, { selfListen: true });
  const reactionEvents = reactionFormatter.processTable({
    LSUpsertReaction: [{ ThreadKey: 7, MessageId: "m9", ActorId: "999", Reaction: "\u2764", TimestampMs: 1 }],
    LSUpdateOrInsertReactionV2: [{ ThreadKey: 7, MessageID: "m9", ReactionLiteral: "\u2764\uFE0F", ViewerIsReactor: true, LastUpdatedTimestampMS: 2 }],
  });
  assert.strictEqual(reactionEvents.filter((e) => e.type === "message_reaction").length, 1, "the same reaction must not be emitted twice");
  assert.strictEqual(reactionEvents[0].reaction, "\u2764");
  assert.strictEqual(reactionEvents[0].senderID, "999");
  const removalEvents = reactionFormatter.processTable({
    LSDeleteReactionV2: [{ ThreadKey: 7, MessageID: "m9", LastUpdatedTimestampMS: 3 }],
  });
  assert.strictEqual(removalEvents.length, 1);
  assert.strictEqual(removalEvents[0].type, "message_reaction");
  assert.strictEqual(removalEvents[0].reaction, "", "a V2 deletion clears the reaction");

  const { stringifyBigInt } = require("../src/utils");
  const { typingTask } = require("../src/tasks");
  const bigTyping = typingTask(12345678901234567n, true, true);
  assert.strictEqual(
    stringifyBigInt(bigTyping.payload),
    '{"thread_key":12345678901234567,"is_group_thread":1,"is_typing":1,"attribution":0,"sync_group":1,"thread_type":2}',
    "typing payloads with int64 thread ids must serialize instead of throwing"
  );
  assert.throws(() => JSON.stringify(bigTyping.payload), /BigInt/, "plain JSON.stringify is the failure this guards against");

  const replyFormatter = new EventFormatter(fakeClient, { selfListen: true });
  replyFormatter.updateThreadMeta(100, { threadID: "100", isGroup: true, participantIDs: ["1", "2"] });
  const replyInline = replyFormatter.processTable({
    LSInsertMessage: [{
      MessageId: "r1", ThreadKey: 100, SenderId: "111", TimestampMs: 1, Text: "nice",
      ReplySourceId: "mid.$photo", ReplyToUserId: "222", ReplyMessageText: "look",
      ReplyAttachmentType: 2, ReplyAttachmentId: 777, ReplyMediaUrl: "https://cdn/photo.jpg",
      ReplyMediaUrlMimeType: "image/jpeg", ReplyMediaPreviewWidth: 640, ReplyMediaPreviewHeight: 480,
    }],
  });
  const replyEvent = replyInline.find((e) => e.type === "message_reply");
  assert.ok(replyEvent, "a reply must produce a message_reply event");
  assert.strictEqual(replyEvent.messageReply.attachments.length, 1, "reply photo must surface in messageReply.attachments");
  assert.strictEqual(replyEvent.messageReply.attachments[0].type, "photo");
  assert.strictEqual(replyEvent.messageReply.attachments[0].url, "https://cdn/photo.jpg");
  assert.strictEqual(replyEvent.messageReply.attachments[0].ID, 777);
  assert.strictEqual(replyEvent.messageReply.senderID, "222");
  assert.strictEqual(replyEvent.messageReply.messageID, "mid.$photo");

  const replyCached = replyFormatter.processTable({
    LSInsertAttachment: [{ MessageId: "mid.$photo", AttachmentFbid: 777, AttachmentType: 2, PlayableUrl: "https://cdn/full.jpg", PreviewUrl: "https://cdn/thumb.jpg" }],
    LSInsertMessage: [{ MessageId: "r2", ThreadKey: 100, SenderId: "111", TimestampMs: 2, Text: "again", ReplySourceId: "mid.$photo", ReplyToUserId: "222", ReplyMessageText: "look", ReplyAttachmentType: 2, ReplyMediaUrl: "https://cdn/reply.jpg" }],
  });
  const cachedReply = replyCached.find((e) => e.type === "message_reply");
  assert.strictEqual(cachedReply.messageReply.attachments[0].url, "https://cdn/full.jpg", "cached original attachments must be preferred over the reply preview");

  const replyNone = replyFormatter.processTable({
    LSInsertMessage: [{ MessageId: "r3", ThreadKey: 100, SenderId: "111", TimestampMs: 3, Text: "text only", ReplySourceId: "mid.$text", ReplyToUserId: "222", ReplyMessageText: "hi" }],
  });
  assert.deepStrictEqual(replyNone.find((e) => e.type === "message_reply").messageReply.attachments, [], "a text-only reply has no attachments");

  const { sendMessage: sendMessageFn } = require("../src/api/sendMessage");
  const sendCalls = [];
  const typingCalls = [];
  const smClient = {
    getCurrentUserID: () => "5",
    sendTasks: async (tasks) => { sendCalls.push(tasks[0]); return { payload: JSON.stringify({ step: [] }), sp: [] }; },
    sendStatelessTask: async (task) => { typingCalls.push(task.payload); },
  };
  await sendMessageFn(smClient, { body: "hi", replyToMessage: "mid.$x" }, 42);
  assert.deepStrictEqual(sendCalls[0].payload.reply_metadata, { reply_source_id: "mid.$x", reply_source_type: 1, reply_type: 0 });
  assert.strictEqual(sendCalls[0].payload.source, 65537, "a real send must carry the MESSENGER_INBOX_IN_THREAD origin");
  assert.strictEqual(sendCalls[0].payload.initiating_source, 1, "a real send must carry the FACEBOOK_INBOX initiating source");
  assert.strictEqual(typingCalls.length, 2, "a text send must show a typing indicator on then off");
  assert.strictEqual(typingCalls[0].is_typing, 1);
  assert.strictEqual(typingCalls[1].is_typing, 0);

  const { postGraphqlBatch } = require("../src/api/http");
  const gqlCalls = [];
  const gqlClient = {
    configs: { userId: "5", dtsg: "d", jazoest: "2", lsd: "LSD-TOKEN", siteData: {}, versionID: 1 },
    graphQLRequests: 1,
    getEndpoint: (n) => (n === "base_url" ? "https://www.facebook.com" : "https://www.facebook.com"),
    http: {
      buildHeaders: () => ({}),
      request: async (url, opts) => { gqlCalls.push({ url, opts }); return { body: 'for (;;);{"o0":{"data":1}}\r\n{"error_results":0}' }; },
    },
  };
  const batchData = await postGraphqlBatch(gqlClient, "https://www.facebook.com/api/graphqlbatch/", { batch_name: "MessengerGraphQLThreadFetcher", queries: "{}" });
  assert.strictEqual(gqlCalls[0].opts.headers["x-fb-lsd"], "LSD-TOKEN", "batch GraphQL must send x-fb-lsd like the single-query path");
  assert.strictEqual(gqlCalls[0].opts.headers["x-fb-friendly-name"], "MessengerGraphQLThreadFetcher");
  assert.ok(Array.isArray(batchData), "batch response must parse into an array");

  const { uploadAttachment } = require("../src/api/upload");
  assert.strictEqual(typeof uploadAttachment, "function");

  // autoMarkDelivery must send a delivery receipt for live messages.
  // (require directly: the IIFE shadows EventEmitter/listenMqtt further down)
  const _EventEmitter = require("events").EventEmitter;
  const _listenMqtt = require("../src/listen").listenMqtt;
  const deliverClient = new _EventEmitter();
  deliverClient.connect = async () => { };
  deliverClient.reset = async () => { };
  deliverClient._messageThreadMap = new Map();
  const deliverCalls = [];
  deliverClient.configs = { userId: "5", dtsg: "d", jazoest: "2", siteData: {}, versionID: 1 };
  deliverClient.graphQLRequests = 1;
  deliverClient.getEndpoint = () => "https://www.facebook.com";
  deliverClient.http = {
    buildHeaders: () => ({}),
    request: async (url, opts) => { deliverCalls.push({ url, opts }); return { body: "{}" }; },
  };
  deliverClient.sendTasks = async () => ({});
  const deliverHandle = _listenMqtt(deliverClient, { processTable: (t) => t.events || [], absorb: () => { } }, () => { }, { replayGraceMs: 60000, autoMarkDelivery: true });
  deliverClient.emit("ls-table", { events: [{ type: "message", messageID: "m-deliver", threadID: "77", timestamp: Date.now() }] });
  await new Promise((r) => setTimeout(r, 20));
  assert.ok(deliverCalls.some((c) => c.url.includes("delivery_receipts.php")), "autoMarkDelivery must send a delivery receipt");
  deliverHandle.stopListening();

  const { Client } = require("../src/client");
  const autoOffClient = new Client({ appState: [{ key: "xs", value: "a" }, { key: "c_user", value: "1" }], autoReconnect: false });
  autoOffClient._loggedIn = true;
  autoOffClient._socketWasConnected = true;
  autoOffClient._openSocket = async () => { throw new Error("boom"); };
  autoOffClient._emitError = () => { };
  let permanentErr = null;
  autoOffClient.on("permanent-error", (e) => { permanentErr = e; });
  await autoOffClient._runConnectionLoop();
  assert.ok(permanentErr, "autoReconnect:false must stop reconnecting and surface the drop");

  const threadApi = require("../src/api/thread");
  const declineCalls = [];
  const declineClient = {
    configs: { userId: "5", dtsg: "d", jazoest: "2", siteData: {}, versionID: 1 },
    graphQLRequests: 1,
    getEndpoint: () => "https://www.facebook.com",
    http: {
      buildHeaders: () => ({}),
      request: async (url, opts) => { declineCalls.push({ url, opts }); return { body: "{}" }; },
    },
    sendTasks: async () => ({}),
  };
  await threadApi.handleMessageRequest(declineClient, 42, false);
  assert.ok(declineCalls[0].url.includes("move_thread.php"), "decline must move the thread out of the request inbox");
  assert.ok(declineCalls[0].opts.body.includes("other%5B0%5D=42"), "decline must target the other folder");

  const { EventEmitter } = require("events");
  const { listenMqtt } = require("../src/listen");
  const listenClient = new EventEmitter();
  listenClient.connect = async () => { };
  listenClient.reset = async () => { };
  listenClient._messageThreadMap = new Map();
  const delivered = [];
  const fakeFmt = {
    processTable: (table) => table.events || [],
    absorb: () => { },
  };
  const handle = listenMqtt(listenClient, fakeFmt, (err, event) => { if (!err) delivered.push(event); }, { replayGraceMs: 60000 });
  const oldTs = Date.now() - 120000;
  listenClient.emit("ls-table", { events: [
    { type: "message", messageID: "old-cmd", threadID: "1", timestamp: oldTs, body: "sing hello" },
    { type: "message", messageID: "live-1", threadID: "1", timestamp: Date.now(), body: "hi" },
    { type: "message_reaction", messageID: "m1", threadID: "1", timestamp: oldTs, reaction: "\u2764" },
    { type: "event", messageID: "old-join", threadID: "1", timestamp: oldTs, logMessageType: "log:subscribe" },
  ] });
  assert.deepStrictEqual(delivered.map((e) => `${e.type}:${e.messageID || ""}`), ["message:live-1", "message_reaction:m1"], "replayed history must be dropped before ready");
  listenClient.emit("ready", { reconnect: true });
  listenClient.emit("ls-table", { events: [{ type: "message", messageID: "live-2", threadID: "1", timestamp: Date.now() - 5000, body: "after ready" }] });
  assert.ok(delivered.some((e) => e.messageID === "live-2"), "messages delivered after ready must not be gated");
  handle.stopListening();
  assert.strictEqual(listenClient.listenerCount("ls-table"), 0, "stopListening must detach listeners");

  // --- full/periodic reconnect (mautrix parity) ---------------------------
  const reconnectClient = new Client({
    cookies: cookiesFromAppState([{ key: "xs", value: "abc" }, { key: "c_user", value: "123" }]),
    forceRefreshIntervalMs: 50000,
  });
  reconnectClient._loggedIn = true;
  reconnectClient.loadMessagesPage = async () => { reconnectClient.bootstrapCount = (reconnectClient.bootstrapCount || 0) + 1; return {}; };
  reconnectClient.reset = async () => { reconnectClient.resetCount = (reconnectClient.resetCount || 0) + 1; };
  reconnectClient.connect = async () => { reconnectClient.connectCount = (reconnectClient.connectCount || 0) + 1; return reconnectClient._connectPromise || Promise.resolve(); };
  reconnectClient._schedulePeriodicReconnect();
  assert.ok(reconnectClient._periodicReconnectTimer, "periodic reconnect timer must be armed after connect");
  await reconnectClient.fullReconnect();
  assert.strictEqual(reconnectClient.resetCount, 1, "fullReconnect must tear down the connection");
  assert.strictEqual(reconnectClient.bootstrapCount, 1, "fullReconnect must re-run the bootstrap");
  assert.strictEqual(reconnectClient.connectCount, 1, "fullReconnect must reconnect");
  assert.strictEqual(reconnectClient.canReconnect(), false, "min full-reconnect interval must gate an immediate second full reconnect");
  await reconnectClient.fullReconnect();
  assert.strictEqual(reconnectClient.resetCount, 1, "a full reconnect within the min interval must be skipped");
  reconnectClient._stopPeriodicReconnect();
  reconnectClient.permanentErrored = true;
  reconnectClient._lastFullReconnect = 0;
  await reconnectClient.fullReconnect();
  assert.strictEqual(reconnectClient.resetCount, 1, "a permanent error must stop full reconnects");
  reconnectClient.disconnect();

  console.log("smoke: all assertions passed");
})();
