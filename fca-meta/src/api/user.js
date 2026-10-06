"use strict";

const { getType } = require("../utils");
const { getContactsFullTask, getContactsTask, searchUserTask } = require("../tasks");
const { parsePublishResponse } = require("./decode");

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
  for (const id of list) {
    try {
      const response = await client.sendTasks([getContactsFullTask(Number(id))]);
      const table = parsePublishResponse(response);
      const contact = contactFromTable(table, id);
      result[String(id)] = contactToUserInfo(contact) || defaultUser(id);
    } catch (err) {
      result[String(id)] = defaultUser(id);
    }
  }
  return result;
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
      const fbid = item.OtherUserId || (item.ThreadType && item.ThreadType < 100 ? Number(item.ResultId) : 0);
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
