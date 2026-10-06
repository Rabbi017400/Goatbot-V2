"use strict";

const { getType, toBigOrNumber } = require("../utils");
const { getContactsFullTask, getContactsTask, searchUserTask } = require("../tasks");
const { parsePublishResponse } = require("./decode");
const { postGraphqlBatch } = require("./http");

const USER_INFO_DOC_ID = "5009315269112105";

function contactToUserInfo(contact) {
  if (!contact) return null;
  const id = contact.ContactId !== undefined ? contact.ContactId : contact.Id;
  return {
    name: contact.Name || contact.FullName || "",
    firstName: contact.FirstName || "",
    vanity: contact.SecondaryName || contact.Username || "",
    thumbSrc: contact.ProfilePictureUrl || "",
    profileUrl: id ? `https://www.facebook.com/profile.php?id=${id}` : "",
    gender: contact.Gender === 2 || contact.Gender === 4 ? 2 : contact.Gender === 1 || contact.Gender === 3 ? 1 : 0,
    type: "user",
    isFriend: contact.ContactViewerRelationship === 3,
    isBirthday: false,
    userID: String(id),
  };
}

function contactFromTable(table, id) {
  for (const contact of [...(table.LSVerifyContactRowExists || []), ...(table.LSDeleteThenInsertContact || [])]) {
    const cid = contact.ContactId !== undefined ? contact.ContactId : contact.Id;
    if (String(cid) === String(id)) return contact;
  }
  return null;
}

async function getUserInfo(client, ids) {
  const list = getType(ids) === "Array" ? ids : [ids];
  const result = {};
  const missing = [];
  for (const id of list) {
    let contact = null;
    try {
      const response = await client.sendTasks([getContactsFullTask(toBigOrNumber(id))]);
      const table = parsePublishResponse(response);
      contact = contactFromTable(table, id);
    } catch (_) { /* fall back to graphql below */ }
    if (contact) result[String(id)] = contactToUserInfo(contact);
    else missing.push(id);
  }
  if (missing.length) {
    const graph = await fetchUsersGraphql(client, missing).catch(() => ({}));
    for (const id of missing) result[String(id)] = graph[String(id)] || defaultUser(id);
  }
  return result;
}

async function fetchUsersGraphql(client, ids) {
  const endpoint = (client.getEndpoint ? client.getEndpoint("base_url") : "https://www.facebook.com") + "/api/graphqlbatch/";
  const resData = await postGraphqlBatch(client, endpoint, {
    queries: JSON.stringify({
      o0: { doc_id: USER_INFO_DOC_ID, query_params: { ids: ids.map(String) } },
    }),
    batch_name: "MessengerParticipantsFetcher",
  });
  const out = {};
  const actors = resData && resData[0] && resData[0].o0 && resData[0].o0.data && resData[0].o0.data.messaging_actors;
  if (!Array.isArray(actors)) return out;
  for (const actor of actors) {
    if (!actor || actor.id === undefined) continue;
    const image = actor.big_image_src ? actor.big_image_src.uri : "";
    out[String(actor.id)] = {
      name: actor.name || "",
      firstName: actor.short_name || "",
      vanity: actor.username || "",
      thumbSrc: image,
      profileUrl: actor.url || `https://www.facebook.com/profile.php?id=${actor.id}`,
      gender: actor.gender || 0,
      type: actor.__typename || "user",
      isFriend: Boolean(actor.is_viewer_friend),
      isBirthday: Boolean(actor.is_birthday),
      userID: String(actor.id),
    };
  }
  return out;
}

function defaultUser(id) {
  return {
    name: "",
    firstName: "",
    vanity: "",
    thumbSrc: "",
    profileUrl: `https://www.facebook.com/profile.php?id=${id}`,
    gender: 0,
    type: "user",
    isFriend: false,
    isBirthday: false,
    userID: String(id),
  };
}

async function getUserID(client, username) {
  const { httpGet } = require("./http");
  const { getGUID } = require("../utils");
  const res = await httpGet(client, "https://www.facebook.com/ajax/typeahead/search.php", {
    value: String(username).toLowerCase(),
    viewer: client.getCurrentUserID(),
    rsp: "search",
    context: "search",
    path: "/home.php",
    request_id: getGUID(),
  });
  const entries = res && res.payload && res.payload.entries;
  if (Array.isArray(entries)) {
    return entries.map((data) => ({
      userID: String(data.uid),
      photoUrl: data.photo,
      indexRank: data.index_rank,
      name: data.text,
      isVerified: data.is_verified,
      profileUrl: data.path,
      category: data.category,
      score: data.score,
      type: data.type,
    }));
  }
  const response = await client.sendTasks([searchUserTask(username)]);
  const table = parsePublishResponse(response);
  const results = [];
  for (const item of table.LSInsertSearchResult || []) {
    if (item.Type_ === 1 || item.Type_ === 2) {
      const fbid = item.OtherUserId || (item.ThreadType && item.ThreadType < 100 ? toBigOrNumber(item.ResultId) : 0);
      if (fbid) results.push({ userID: String(fbid), name: item.DisplayName, photoUrl: item.ProfilePicUrl, type: "user" });
    }
  }
  return results;
}

async function getFriendsList(client) {
  const response = await client.sendTasks([getContactsTask()]);
  const table = parsePublishResponse(response);
  const result = {};
  for (const contact of [...(table.LSVerifyContactRowExists || []), ...(table.LSDeleteThenInsertContact || [])]) {
    if (contact.ContactViewerRelationship !== 3) continue;
    const id = contact.ContactId !== undefined ? contact.ContactId : contact.Id;
    if (!id) continue;
    result[String(id)] = {
      name: contact.Name || "",
      firstName: contact.FirstName || "",
      vanity: contact.SecondaryName || "",
      thumbSrc: contact.ProfilePictureUrl || "",
      profileUrl: `https://www.facebook.com/profile.php?id=${id}`,
      gender: contact.Gender,
      isFriend: true,
      userID: String(id),
    };
  }
  return result;
}

module.exports = { getUserInfo, getUserID, getFriendsList, contactToUserInfo };
