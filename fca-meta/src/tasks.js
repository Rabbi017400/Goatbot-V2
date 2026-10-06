"use strict";

const { generateEpochID, generateTimestampString, stringifyBigInt } = require("./utils");

const TASK_LABELS = {
  UpdatePresence: "3",
  ThreadMarkRead: "21",
  AcceptMessageRequestTask: "66",
  AddParticipantsTask: "23",
  UpdateAdminTask: "25",
  SendReactionTask: "29",
  SearchUserTask: "30",
  SearchUserSecondaryTask: "31",
  RenameThreadTask: "32",
  DeleteMessageTask: "33",
  SetThreadImageTask: "37",
  SendMessageTask: "46",
  ReportAppStateTask: "123",
  CreateGroupTask: "130",
  RemoveParticipantTask: "140",
  MuteThreadTask: "144",
  FetchThreadsTask: "145",
  DeleteThreadTask: "146",
  DeleteMessageMeOnlyTask: "155",
  CreatePollTask: "163",
  UpdatePollTask: "164",
  GetContactsFullTask: "207",
  CreateThreadTask: "209",
  FetchMessagesTask: "228",
  FetchCommunityMemberList: "355",
  CreateWhatsAppThreadTask: "388",
  GetContactsTask: "452",
  CommunityThreadHoleDetection: "501",
  FetchReactionsV2UserList: "577",
  SendReactionV2: "604",
  DeleteCommunitySubThread: "639",
  CreateCommunitySubThread: "665",
  FetchAdditionalThreadData: "733",
  EditMessageTask: "742",
};

class TaskManager {
  constructor(client) {
    this.client = client;
    this.tasks = [];
    this.traceID = null;
  }

  addTask(label, payload, queueName) {
    if (!queueName) throw new Error("no queue name provided for task " + label);
    this.tasks.push({
      failure_count: null,
      label,
      payload: JSON.stringify(payload),
      queue_name: queueName,
      task_id: this.client._getTaskID(),
    });
  }

  finalizePayload() {
    const payload = {
      epoch_id: generateEpochID(),
      data_trace_id: this.traceID,
      tasks: this.tasks,
      version_id: String(this.client.configs.versionID),
    };
    this.tasks = [];
    return stringifyBigInt(payload);
  }
}

// --- Individual tasks -----------------------------------------------------

function sendMessageTask(client, { threadID, otid, text, replyToMessage, replyType, mentions, attachmentFBIds, stickerId, sendType, source, hotEmojiSize, url, attributionAppId, initiatingSource, powerUpStyle }) {
  const payload = {
    thread_id: threadID,
    otid: String(otid),
    source: source !== undefined ? source : 0,
    send_type: sendType !== undefined ? sendType : 1,
    sync_group: 1,
  };
  if (attachmentFBIds && attachmentFBIds.length) payload.attachment_fbids = attachmentFBIds;
  if (replyToMessage) {
    payload.reply_metadata = { reply_source_id: replyToMessage, reply_source_type: 1, reply_type: replyType !== undefined ? replyType : 0 };
  }
  if (mentions) payload.mention_data = mentions;
  if (text !== undefined && text !== null && text !== "") payload.text = text;
  if (hotEmojiSize) payload.hot_emoji_size = hotEmojiSize;
  if (stickerId) payload.sticker_id = stickerId;
  if (powerUpStyle) payload.power_up_style = powerUpStyle;
  if (initiatingSource !== undefined) payload.initiating_source = initiatingSource;
  payload.skip_url_preview_gen = 0;
  payload.text_has_links = text && /https?:\/\//.test(text) ? 1 : 0;
  payload.multitab_env = 0;
  if (url) payload.url = url;
  if (attributionAppId) payload.attribution_app_id = attributionAppId;
  return { label: TASK_LABELS.SendMessageTask, payload, queueName: String(threadID) };
}

function markReadTask(threadID, watermark) {
  return {
    label: TASK_LABELS.ThreadMarkRead,
    payload: { thread_id: threadID, last_read_watermark_ts: watermark, sync_group: 1 },
    queueName: String(threadID),
  };
}

function typingTask(threadID, isTyping, isGroup) {
  return {
    label: TASK_LABELS.UpdatePresence,
    payload: {
      thread_key: threadID,
      is_group_thread: isGroup ? 1 : 0,
      is_typing: isTyping ? 1 : 0,
      attribution: 0,
      sync_group: 1,
      thread_type: isGroup ? 2 : 1,
    },
    queueName: "",
  };
}

function reactionTaskV2({ threadID, messageID, actorID, reaction, add }) {
  return {
    label: TASK_LABELS.SendReactionV2,
    payload: {
      thread_id: threadID,
      message_id: messageID,
      message_timestamp: 0,
      actor_id: actorID,
      reaction_fbid: 0,
      reaction_style: 1,
      current_count: 0,
      viewer_is_reactor: add ? 1 : 0,
      operation: add ? 1 : 3,
      reaction_literal: reaction,
      entry_point: null,
      sync_group: 104,
    },
    queueName: JSON.stringify(["reaction_v2", messageID]),
  };
}

function reactionTask({ threadID, messageID, actorID, reaction, timestampMs }) {
  return {
    label: TASK_LABELS.SendReactionTask,
    payload: {
      thread_key: threadID,
      timestamp_ms: timestampMs || Date.now(),
      message_id: messageID,
      actor_id: actorID,
      reaction,
      reaction_style: null,
      sync_group: 1,
      send_attribution: 65537,
    },
    queueName: JSON.stringify(["reaction", messageID]),
  };
}

function deleteMessageTask(messageID) {
  return { label: TASK_LABELS.DeleteMessageTask, payload: { message_id: messageID }, queueName: "unsend_message" };
}

function deleteMessageMeOnlyTask(threadID, messageID) {
  return {
    label: TASK_LABELS.DeleteMessageMeOnlyTask,
    payload: { thread_key: threadID, message_id: messageID },
    queueName: "155",
  };
}

function createWhatsAppThreadTask({ waJID, offlineThreadKey, threadType, folderType = 0, bumpTimestampMs = 0, tamThreadSubtype = 0 }) {
  return {
    label: TASK_LABELS.CreateWhatsAppThreadTask,
    payload: {
      wa_jid: waJID,
      offline_thread_key: offlineThreadKey,
      thread_type: threadType,
      folder_type: folderType,
      bump_timestamp_ms: bumpTimestampMs,
      tam_thread_subtype: tamThreadSubtype,
    },
    queueName: String(offlineThreadKey),
  };
}

function fetchCommunityMemberListTask({ communityID, threadKey, groupThreadID = null, roles = [0], fetchAdminsOnly = 0, cursor = "", source = 7, searchText = null, threadRoles = [], requestID }) {
  return {
    label: TASK_LABELS.FetchCommunityMemberList,
    payload: {
      community_id: communityID,
      roles,
      fetch_admins_only: fetchAdminsOnly,
      cursor,
      source,
      thread_key: threadKey,
      search_text: searchText,
      thread_roles: threadRoles,
      group_thread_id: groupThreadID,
      request_id: requestID || Number(generateTimestampString()),
    },
    queueName: "fetch_community_member_list",
  };
}

function createCommunitySubThreadTask({ clientMutationID, communityID, parentMessageID, parentThreadID }) {
  return {
    label: TASK_LABELS.CreateCommunitySubThread,
    payload: {
      client_mutation_id: clientMutationID,
      community_id: communityID,
      parent_message_id: parentMessageID,
      parent_thread_id: parentThreadID,
    },
    queueName: `create_community_sub_thread_${parentThreadID}`,
  };
}

function deleteCommunitySubThreadTask({ threadKey, actorID, syncGroup = 1 }) {
  return {
    label: TASK_LABELS.DeleteCommunitySubThread,
    payload: { thread_key: threadKey, actor_id: actorID, sync_group: syncGroup },
    queueName: String(threadKey),
  };
}

function communityThreadHoleDetectionTask({ threadID, previousTQSeqID, currentTQSeqID, deltaType }) {
  return {
    label: TASK_LABELS.CommunityThreadHoleDetection,
    payload: {
      thread_id: threadID,
      previous_tq_seq_id: previousTQSeqID,
      current_tq_seq_id: currentTQSeqID,
      delta_type: deltaType,
    },
    queueName: `cm_thread_hole_detection${threadID}`,
  };
}

function editMessageTask(messageID, text) {
  return { label: TASK_LABELS.EditMessageTask, payload: { message_id: messageID, text }, queueName: "edit_message" };
}

function muteThreadTask(threadID, muteExpireTimeMs) {
  return {
    label: TASK_LABELS.MuteThreadTask,
    payload: { thread_key: threadID, mailbox_type: 0, mute_expire_time_ms: muteExpireTimeMs, sync_group: 1 },
    queueName: String(threadID),
  };
}

function renameThreadTask(threadID, name) {
  return {
    label: TASK_LABELS.RenameThreadTask,
    payload: { thread_key: threadID, thread_name: name, sync_group: 1 },
    queueName: String(threadID),
  };
}

function setThreadImageTask(threadID, imageID) {
  return {
    label: TASK_LABELS.SetThreadImageTask,
    payload: { thread_key: threadID, image_id: imageID, sync_group: 1 },
    queueName: "thread_image",
  };
}

function updateAdminTask(threadID, contactID, isAdmin) {
  return {
    label: TASK_LABELS.UpdateAdminTask,
    payload: { thread_key: threadID, contact_id: contactID, is_admin: isAdmin ? 1 : 0 },
    queueName: "admin_status",
  };
}

function addParticipantsTask(threadID, contactIDs) {
  return {
    label: TASK_LABELS.AddParticipantsTask,
    payload: { thread_key: threadID, contact_ids: contactIDs, sync_group: 1 },
    queueName: String(threadID),
  };
}

function removeParticipantTask(threadID, contactID) {
  return {
    label: TASK_LABELS.RemoveParticipantTask,
    payload: { thread_id: threadID, contact_id: contactID },
    queueName: "remove_participant_v2",
  };
}

function deleteThreadTask(threadID, removeType = 0) {
  return {
    label: TASK_LABELS.DeleteThreadTask,
    payload: { thread_key: threadID, remove_type: removeType, sync_group: 1 },
    queueName: String(threadID),
  };
}

function fetchThreadsTask({ parentThreadKey, referenceThreadKey, referenceActivityTimestamp, syncGroup, cursor, isAfter = 0, additionalPagesToFetch = 0 }) {
  return {
    label: TASK_LABELS.FetchThreadsTask,
    payload: {
      is_after: isAfter,
      parent_thread_key: parentThreadKey,
      reference_thread_key: referenceThreadKey,
      reference_activity_timestamp: referenceActivityTimestamp,
      additional_pages_to_fetch: additionalPagesToFetch,
      cursor: cursor || null,
      messaging_tag: null,
      sync_group: syncGroup,
    },
    queueName: "trq",
  };
}

function fetchMessagesTask({ threadKey, referenceTimestampMs = 0, referenceMessageId = "", cursor = "", direction = 0, syncGroup = 1 }) {
  return {
    label: TASK_LABELS.FetchMessagesTask,
    payload: {
      thread_key: threadKey,
      direction,
      reference_timestamp_ms: referenceTimestampMs,
      reference_message_id: referenceMessageId,
      sync_group: syncGroup,
      cursor,
    },
    queueName: "mrq." + threadKey,
  };
}

function createThreadTask(threadFBID, syncGroup = 1) {
  return {
    label: TASK_LABELS.CreateThreadTask,
    payload: {
      thread_fbid: threadFBID,
      force_upsert: 0,
      use_open_messenger_transport: 0,
      sync_group: syncGroup,
      metadata_only: 0,
      preview_only: 0,
    },
    queueName: String(threadFBID),
  };
}

function createGroupTask({ threadID, otid, participants }) {
  return {
    label: TASK_LABELS.CreateGroupTask,
    payload: {
      participants,
      send_payload: { thread_id: threadID, otid: String(otid), source: 0, send_type: 8 },
    },
    queueName: String(threadID),
  };
}

function searchUserTask(query, { secondary = false, supportedTypes } = {}) {
  const payload = {
    query,
    supported_types: supportedTypes || [1, 3, 4, 2, 6, 7, 8, 9],
    session_id: null,
    surface_type: 15,
    selected_participants: null,
    group_id: null,
    community_id: null,
    query_id: null,
  };
  return {
    label: secondary ? TASK_LABELS.SearchUserSecondaryTask : TASK_LABELS.SearchUserTask,
    payload,
    queueName: secondary ? "search_secondary" : `["search_primary",${Date.now()}]`,
  };
}

function getContactsTask(limit) {
  return {
    label: TASK_LABELS.GetContactsTask,
    payload: limit ? { limit } : {},
    queueName: JSON.stringify(["search_contacts", generateTimestampString()]),
  };
}

function getContactsFullTask(contactID) {
  return {
    label: TASK_LABELS.GetContactsFullTask,
    payload: { contact_id: contactID },
    queueName: "cpq_v2",
  };
}

function acceptMessageRequestTask(threadID) {
  return {
    label: TASK_LABELS.AcceptMessageRequestTask,
    payload: { thread_key: threadID, sync_group: 95, ig_folder: null },
    queueName: "message_request",
  };
}

function reportAppStateTask(appState) {
  return {
    label: TASK_LABELS.ReportAppStateTask,
    payload: { app_state: appState, request_id: generateTimestampString() },
    queueName: "ls_presence_report_app_state",
  };
}

function fetchAdditionalThreadDataTask(threadID) {
  return {
    label: TASK_LABELS.FetchAdditionalThreadData,
    payload: { thread_key: threadID },
    queueName: `fetch_additional_thread_data_${threadID}`,
  };
}

function fetchReactionsV2UserListTask({ threadID, messageID, reactionFBID = null, cursor = null }) {
  return {
    label: TASK_LABELS.FetchReactionsV2UserList,
    payload: { thread_id: threadID, message_id: messageID, reaction_fbid: reactionFBID, cursor, sync_group: 1 },
    queueName: "fetch_reactions_v2_details_users_list",
  };
}

function nicknameTask(threadID, contactID, nickname) {
  return {
    label: "44",
    payload: {
      thread_key: threadID,
      contact_id: contactID,
      nickname: nickname || "",
      sync_group: 1,
    },
    queueName: "thread_participant_nickname",
  };
}

function threadColorTask(threadID, themeFbid) {
  return {
    label: "43",
    payload: {
      thread_key: threadID,
      theme_fbid: themeFbid,
      source: null,
      sync_group: 1,
      payload: null,
    },
    queueName: "thread_theme",
  };
}

function threadEmojiTask(threadID, emoji) {
  return {
    label: "100003",
    payload: {
      thread_key: threadID,
      custom_emoji: emoji,
      avatar_sticker_instruction_key_id: null,
      sync_group: 1,
    },
    queueName: "thread_quick_reaction",
  };
}

function createPollTask(threadID, question, options) {
  return {
    label: TASK_LABELS.CreatePollTask,
    payload: { question_text: question, thread_key: threadID, options, sync_group: 1 },
    queueName: "poll_creation",
  };
}

function updatePollTask(threadID, pollID, selectedOptions) {
  return {
    label: TASK_LABELS.UpdatePollTask,
    payload: { thread_key: threadID, poll_id: pollID, added_options: [], selected_options: selectedOptions, sync_group: 1 },
    queueName: "poll_update",
  };
}

function forwardMessageTask(threadID, otid, forwardedMsgId) {
  return {
    label: TASK_LABELS.SendMessageTask,
    payload: {
      thread_id: threadID,
      otid: otid,
      source: 0,
      send_type: 5,
      sync_group: 1,
      forwarded_msg_id: forwardedMsgId,
      skip_url_preview_gen: 0,
      text_has_links: 0,
      multitab_env: 0,
    },
    queueName: String(threadID),
  };
}

module.exports = {
  TASK_LABELS,
  TaskManager,
  sendMessageTask,
  markReadTask,
  typingTask,
  reactionTask,
  reactionTaskV2,
  deleteMessageTask,
  deleteMessageMeOnlyTask,
  editMessageTask,
  muteThreadTask,
  renameThreadTask,
  setThreadImageTask,
  updateAdminTask,
  addParticipantsTask,
  removeParticipantTask,
  deleteThreadTask,
  fetchThreadsTask,
  fetchMessagesTask,
  createThreadTask,
  createGroupTask,
  searchUserTask,
  getContactsTask,
  getContactsFullTask,
  acceptMessageRequestTask,
  reportAppStateTask,
  fetchAdditionalThreadDataTask,
  fetchReactionsV2UserListTask,
  createWhatsAppThreadTask,
  fetchCommunityMemberListTask,
  createCommunitySubThreadTask,
  deleteCommunitySubThreadTask,
  communityThreadHoleDetectionTask,
  nicknameTask,
  threadColorTask,
  threadEmojiTask,
  createPollTask,
  updatePollTask,
  forwardMessageTask,
};
