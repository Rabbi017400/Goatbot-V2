"use strict";

const { parseJSON, parseBatchJSON, stripAntiJS } = require("../http");

function buildForm(client, form) {
  const configs = client.configs || {};
  const site = configs.siteData || {};
  client.graphQLRequests = (client.graphQLRequests || 1) + 1;
  const merged = {
    __user: configs.userId,
    __req: Number(client.graphQLRequests).toString(36),
    __rev: String(site.__spin_r || ""),
    __a: 1,
    fb_dtsg: configs.dtsg || "",
    jazoest: configs.jazoest || "",
  };
  for (const key of Object.keys(form || {})) {
    if (form[key] !== undefined && form[key] !== null) merged[key] = form[key];
  }
  return merged;
}

function computeTTStamp(fbDtsg) {
  let ttstamp = "2";
  for (let i = 0; i < fbDtsg.length; i++) ttstamp += fbDtsg.charCodeAt(i);
  return ttstamp;
}

function checkResponse(client, body) {
  const text = stripAntiJS(body).toString("utf8");
  const json = parseJSON(Buffer.from(text));
  if (json === null) return text;

  if (json && json.jsmods && Array.isArray(json.jsmods.require)) {
    for (const entry of json.jsmods.require) {
      if (Array.isArray(entry) && entry[0] === "DTSG" && entry[1] === "setToken" && entry[3]) {
        client.configs.dtsg = entry[3][0];
        client.configs.jazoest = computeTTStamp(client.configs.dtsg);
      }
    }
  }

  if (json && json.error === 1357001) {
    const err = new Error("Not logged in.");
    err.error = "Not logged in.";
    err.res = json;
    throw err;
  }
  if (json && json.error && json.error !== 0) {
    const err = new Error(typeof json.error === "string" ? json.error : "Facebook returned error " + json.error);
    err.error = json.error;
    err.res = json;
    throw err;
  }
  return json;
}

async function httpGet(client, url, form, options = {}) {
  const query = buildForm(client, form);
  const qs = new URLSearchParams(query).toString();
  const target = qs ? url + (url.includes("?") ? "&" : "?") + qs : url;
  const headers = client.http.buildHeaders({ withCookies: true });
  Object.assign(headers, options.customHeader || {});
  const res = await client.http.request(target, { method: "GET", headers });
  return checkResponse(client, res.body);
}

async function httpPost(client, url, form, options = {}) {
  const body = new URLSearchParams(buildForm(client, form)).toString();
  const headers = client.http.buildHeaders({ withCookies: true });
  headers["content-type"] = "application/x-www-form-urlencoded";
  headers["origin"] = client.getEndpoint("base_url");
  headers["referer"] = client.getEndpoint("base_url") + "/";
  Object.assign(headers, options.customHeader || {});
  const res = await client.http.request(url, { method: "POST", headers, body });
  return checkResponse(client, res.body);
}

async function httpPostFormData(client, url, form, options = {}) {
  const fd = new FormData();
  for (const key of Object.keys(form || {})) {
    if (form[key] === undefined || form[key] === null) continue;
    fd.append(key, form[key]);
  }
  const headers = client.http.buildHeaders({ withCookies: true });
  headers["origin"] = client.getEndpoint("base_url");
  Object.assign(headers, options.customHeader || {});
  const res = await client.http.request(url, { method: "POST", headers, body: fd });
  return checkResponse(client, res.body);
}

// POST to a GraphQL batch endpoint and return the concatenated JSON array.
async function postGraphqlBatch(client, url, form) {
  const body = new URLSearchParams(buildForm(client, form)).toString();
  const headers = client.http.buildHeaders({ withCookies: true });
  headers["content-type"] = "application/x-www-form-urlencoded";
  headers["x-fb-lsd"] = (client.configs && client.configs.lsd) || "";
  headers["x-fb-friendly-name"] = form && (form.fb_api_req_friendly_name || form.batch_name || form.__friendlyName) || "";
  headers["origin"] = client.getEndpoint("base_url");
  headers["referer"] = client.getEndpoint("base_url") + "/";
  const res = await client.http.request(url, { method: "POST", headers, body });
  const parsed = parseBatchJSON(res.body);
  if (parsed === null) {
    throw new Error("postGraphqlBatch: failed to parse response");
  }
  return parsed;
}

module.exports = { httpGet, httpPost, httpPostFormData, postGraphqlBatch, buildForm, checkResponse };
