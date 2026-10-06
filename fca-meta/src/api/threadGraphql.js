"use strict";

const { getType } = require("../utils");
const { postGraphqlBatch } = require("./http");

const THREAD_LIST_DOC_ID = "3336396659757871";
const THREAD_FETCH_DOC_ID = "3449967031715030";
const MAX_BATCH = 50;

function formatID(id) {
  if (id === undefined || id === null) return id;
  return String(id).replace(/(fb)?id[:.]/, "");
}

function formatEventReminders(reminder) {
  if (!reminder) return null;
  const members = reminder.event_reminder_members && reminder.event_reminder_members.edges;
  return {
    reminderID: reminder.id,
    eventCreatorID: reminder.lightweight_event_creator ? reminder.lightweight_event_creator.id : null,
    time: reminder.time,
    eventType: String(reminder.lightweight_event_type || "").toLowerCase(),
    locationName: reminder.location_name,
    locationCoordinates: reminder.location_coordinates,
    locationPage: reminder.location_page,
    eventStatus: String(reminder.lightweight_event_status || "").toLowerCase(),
    note: reminder.note,
    repeatMode: String(reminder.repeat_mode || "").toLowerCase(),
    eventTitle: reminder.event_title,
    triggerMessage: reminder.trigger_message,
    secondsToNotifyBefore: reminder.seconds_to_notify_before,
    allowsRsvp: reminder.allows_rsvp,
    relatedEvent: reminder.related_event,
    members: Array.isArray(members)
      ? members.map((member) => ({
          memberID: member.node ? member.node.id : undefined,
          state: String(member.guest_list_state || "").toLowerCase(),
        }))
      : [],
  };
}

function formatParticipantUser(node) {
  const actor = node && node.messaging_actor ? node.messaging_actor : {};
  const image = actor.big_image_src ? actor.big_image_src.uri : null;
  return {
    id: formatID(actor.id),
    name: actor.name,
    firstName: actor.short_name,
    vanity: actor.username,
    url: actor.url,
    thumbSrc: image,
    profileUrl: image,
    gender: actor.gender,
    type: actor.__typename,
    isFriend: Boolean(actor.is_viewer_friend),
    isBirthday: Boolean(actor.is_birthday),
    isMessengerUser: actor.is_messenger_user,
    isVerified: actor.is_verified,
  };
}

function mapNicknames(customizationInfo) {
  const out = {};
  const list = customizationInfo && customizationInfo.participant_customizations;
  if (Array.isArray(list)) {
    for (const entry of list) {
      if (entry && entry.nickname) out[String(entry.participant_id)] = String(entry.nickname);
    }
  }
  return out;
}

function formatThreadFromGraphQL(data) {
  if (data && Array.isArray(data.errors) && data.errors.length) {
    const details = data.errors.map((e) => (e && e.message ? e.message : String(e))).join(", ");
    throw new Error("getThreadInfo: " + details);
  }
  const messageThread = data && data.message_thread ? data.message_thread : data;
  if (!messageThread) return null;
  const threadKey = messageThread.thread_key || {};
  const threadID = String(threadKey.thread_fbid || threadKey.other_user_id || "");
  const edges = (messageThread.all_participants && messageThread.all_participants.edges) || [];
  const userInfo = edges.map((edge) => formatParticipantUser(edge && edge.node));
  const participantIDs = userInfo.map((u) => String(u.id));
  const lastNodes = messageThread.last_message && messageThread.last_message.nodes;
  const lastNode = Array.isArray(lastNodes) && lastNodes.length ? lastNodes[0] : null;
  const snippetSender = lastNode && lastNode.message_sender && lastNode.message_sender.messaging_actor
    ? formatID(lastNode.message_sender.messaging_actor.id)
    : null;
  const readNodes = messageThread.last_read_receipt && messageThread.last_read_receipt.nodes;
  const lastReadTimestamp = Array.isArray(readNodes) && readNodes.length ? readNodes[0].timestamp_precise : null;
  const approvalNodes = messageThread.group_approval_queue && messageThread.group_approval_queue.nodes;
  const customization = messageThread.customization_info || null;
  const isGroup = messageThread.thread_type === "GROUP";
  const threadAdmins = Array.isArray(messageThread.thread_admins) ? messageThread.thread_admins : [];

  return {
    threadID,
    threadName: messageThread.name,
    participantIDs,
    userInfo,
    unreadCount: messageThread.unread_count,
    messageCount: messageThread.messages_count,
    timestamp: messageThread.updated_time_precise,
    muteUntil: messageThread.mute_until,
    isGroup,
    isSubscribed: messageThread.is_viewer_subscribed,
    isArchived: Boolean(messageThread.has_viewer_archived),
    folder: messageThread.folder,
    cannotReplyReason: messageThread.cannot_reply_reason,
    eventReminders: Array.isArray(messageThread.event_reminders && messageThread.event_reminders.nodes)
      ? messageThread.event_reminders.nodes.map(formatEventReminders)
      : null,
    emoji: customization ? customization.emoji : null,
    color: customization && customization.outgoing_bubble_color
      ? String(customization.outgoing_bubble_color).slice(2)
      : null,
    threadTheme: messageThread.thread_theme,
    nicknames: mapNicknames(customization),
    adminIDs: threadAdmins,
    approvalMode: Boolean(messageThread.approval_mode),
    approvalQueue: Array.isArray(approvalNodes)
      ? approvalNodes.map((a) => ({
          inviterID: a.inviter ? a.inviter.id : undefined,
          requesterID: a.requester ? a.requester.id : undefined,
          timestamp: a.request_timestamp,
          request_source: a.request_source,
        }))
      : [],
    reactionsMuteMode: messageThread.reactions_mute_mode
      ? String(messageThread.reactions_mute_mode).toLowerCase()
      : null,
    mentionsMuteMode: messageThread.mentions_mute_mode
      ? String(messageThread.mentions_mute_mode).toLowerCase()
      : null,
    isPinProtected: Boolean(messageThread.is_pin_protected),
    relatedPageThread: messageThread.related_page_thread,
    name: messageThread.name,
    snippet: lastNode ? lastNode.snippet : null,
    snippetSender,
    snippetAttachments: [],
    serverTimestamp: messageThread.updated_time_precise,
    imageSrc: messageThread.image ? messageThread.image.uri : null,
    isCanonicalUser: Boolean(messageThread.is_canonical_neo_user),
    isCanonical: !isGroup,
    recipientsLoadable: true,
    hasEmailParticipant: false,
    readOnly: false,
    canReply: messageThread.cannot_reply_reason == null,
    lastMessageTimestamp: lastNode ? lastNode.timestamp_precise : null,
    lastMessageType: "message",
    lastReadTimestamp,
    threadType: isGroup ? 2 : 1,
    inviteLink: {
      enable: Boolean(messageThread.joinable_mode && messageThread.joinable_mode.mode === 1),
      link: messageThread.joinable_mode ? messageThread.joinable_mode.link : null,
    },
  };
}

function getThreadName(thread) {
  if (thread.name || (thread.thread_key && thread.thread_key.thread_fbid)) return thread.name || null;
  const edges = (thread.all_participants && thread.all_participants.edges) || [];
  const other = thread.thread_key ? thread.thread_key.other_user_id : null;
  for (const edge of edges) {
    const actor = edge && edge.node && edge.node.messaging_actor;
    if (actor && String(actor.id) === String(other)) return actor.name || null;
  }
  return null;
}

function formatThreadListItem(thread) {
  const edges = (thread.all_participants && thread.all_participants.edges) || [];
  const userInfo = edges.map((edge) => formatParticipantUser(edge && edge.node));
  const lastNodes = thread.last_message && thread.last_message.nodes;
  const lastNode = Array.isArray(lastNodes) && lastNodes.length ? lastNodes[0] : null;
  const customization = thread.customization_info || null;
  const isGroup = thread.thread_type === "GROUP";
  const threadAdmins = Array.isArray(thread.thread_admins) ? thread.thread_admins : [];
  const name = getThreadName(thread);
  return {
    threadID: thread.thread_key
      ? formatID(String(thread.thread_key.thread_fbid || thread.thread_key.other_user_id || ""))
      : null,
    name,
    threadName: name,
    unreadCount: thread.unread_count,
    messageCount: thread.messages_count,
    imageSrc: thread.image ? thread.image.uri : null,
    emoji: customization ? customization.emoji : null,
    color: customization && customization.outgoing_bubble_color
      ? String(customization.outgoing_bubble_color).slice(2)
      : null,
    threadTheme: thread.thread_theme,
    nicknames: mapNicknames(customization),
    muteUntil: thread.mute_until,
    userInfo,
    participantIDs: userInfo.map((u) => String(u.id)),
    adminIDs: threadAdmins,
    folder: thread.folder || null,
    isGroup,
    threadType: isGroup ? 2 : 1,
    customizationEnabled: Boolean(thread.customization_enabled),
    participantAddMode: thread.participant_add_mode_as_string || null,
    reactionsMuteMode: thread.reactions_mute_mode || null,
    mentionsMuteMode: thread.mentions_mute_mode || null,
    isArchived: Boolean(thread.has_viewer_archived),
    isSubscribed: Boolean(thread.is_viewer_subscribed),
    timestamp: thread.updated_time_precise || null,
    snippet: lastNode ? lastNode.snippet : null,
    snippetSender: lastNode && lastNode.message_sender && lastNode.message_sender.messaging_actor
      ? formatID(lastNode.message_sender.messaging_actor.id)
      : null,
    snippetAttachments: lastNode ? lastNode.extensible_attachment : null,
    lastMessageTimestamp: lastNode ? lastNode.timestamp_precise : null,
    lastReadTimestamp: thread.last_read_receipt && thread.last_read_receipt.nodes && thread.last_read_receipt.nodes[0]
      ? thread.last_read_receipt.nodes[0].timestamp_precise
      : null,
    cannotReplyReason: thread.cannot_reply_reason || null,
    approvalMode: Boolean(thread.approval_mode),
    approvalQueue: [],
    eventReminders: null,
    isPinProtected: Boolean(thread.is_pin_protected),
    relatedPageThread: thread.related_page_thread || null,
    snippetHasAttachment: false,
    lastMessageType: "message",
    serverTimestamp: thread.updated_time_precise || null,
    isCanonicalUser: Boolean(thread.is_canonical_neo_user),
    isCanonical: !isGroup,
    recipientsLoadable: true,
    hasEmailParticipant: false,
    readOnly: false,
    canReply: thread.cannot_reply_reason == null,
    inviteLink: {
      enable: Boolean(thread.joinable_mode && thread.joinable_mode.mode === 1),
      link: thread.joinable_mode ? thread.joinable_mode.link : null,
    },
  };
}

function resolveAvatar(client) {
  const endpoint = client.getEndpoint ? client.getEndpoint("base_url") : "https://www.facebook.com";
  return endpoint + "/api/graphqlbatch/";
}

async function getThreadList(client, formatter, limit, timestamp, tags) {
  if (getType(limit) !== "Number" || !Number.isInteger(limit) || limit <= 0) {
    throw { error: "getThreadList: limit must be a positive integer" };
  }
  if (getType(timestamp) !== "Null" && (getType(timestamp) !== "Number" || !Number.isInteger(timestamp))) {
    throw { error: "getThreadList: timestamp must be an integer or null" };
  }
  let effectiveTags = tags;
  if (getType(effectiveTags) === "String") effectiveTags = [effectiveTags];
  if (getType(effectiveTags) !== "Array") {
    throw { error: "getThreadList: tags must be an array" };
  }

  const form = {
    av: client.getCurrentUserID(),
    queries: JSON.stringify({
      o0: {
        doc_id: THREAD_LIST_DOC_ID,
        query_params: {
          limit: limit + (timestamp ? 1 : 0),
          before: timestamp,
          tags: effectiveTags,
          includeDeliveryReceipts: true,
          includeSeqID: false,
        },
      },
    }),
    batch_name: "MessengerGraphQLThreadlistFetcher",
  };

  const resData = await postGraphqlBatch(client, resolveAvatar(client), form);
  if (!Array.isArray(resData) || resData.length === 0) {
    throw { error: "getThreadList: Invalid response data" };
  }
  const last = resData[resData.length - 1];
  if (last && last.error_results > 0) {
    throw (resData[0] && resData[0].o0 && resData[0].o0.errors) || { error: "getThreadList: error_results > 0" };
  }
  if (last && last.successful_results === 0) {
    throw { error: "getThreadList: there was no successful_results", res: resData };
  }
  const nodes = resData[0] && resData[0].o0 && resData[0].o0.data
    && resData[0].o0.data.viewer && resData[0].o0.data.viewer.message_threads
    ? resData[0].o0.data.viewer.message_threads.nodes
    : null;
  if (!Array.isArray(nodes)) {
    throw { error: "getThreadList: Invalid payload structure" };
  }
  const list = timestamp ? nodes.slice(1) : nodes.slice();
  return list.map((node) => formatThreadListItem(node));
}

async function getThreadInfo(client, formatter, threadID) {
  const ids = getType(threadID) === "Array" ? threadID.map(String) : [String(threadID)];
  const queries = {};
  const batch = ids.slice(0, MAX_BATCH);
  batch.forEach((id, index) => {
    queries["o" + index] = {
      doc_id: THREAD_FETCH_DOC_ID,
      query_params: { id, message_limit: 0, load_messages: false, load_read_receipts: false, before: null },
    };
  });

  const resData = await postGraphqlBatch(client, resolveAvatar(client), {
    av: client.getCurrentUserID(),
    queries: JSON.stringify(queries),
    batch_name: "MessengerGraphQLThreadFetcher",
  });
  if (resData && resData.error) throw resData;
  if (!Array.isArray(resData)) throw { error: "getThreadInfo: Invalid response data" };

  const byID = {};
  for (let i = resData.length - 2; i >= 0; i--) {
    const item = resData[i] || {};
    const key = Object.keys(item)[0];
    if (!key) continue;
    const payload = item[key] && item[key].data;
    try {
      const info = formatThreadFromGraphQL(payload);
      if (info && info.threadID) byID[info.threadID] = info;
    } catch (_) { /* skip threads that fail to format */ }
  }

  if (getType(threadID) === "Array") {
    const result = {};
    for (const id of ids) result[id] = byID[id] || null;
    return result;
  }
  return byID[ids[0]] || null;
}

module.exports = { getThreadList, getThreadInfo, formatThreadFromGraphQL, formatThreadListItem, THREAD_LIST_DOC_ID, THREAD_FETCH_DOC_ID };
