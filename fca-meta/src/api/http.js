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
    err.errorCode = 1357001;
    err.res = json;
    // mautrix-meta treats ErrTokenInvalidated as "full reconnect and retry"
    // rather than just surfacing the error, so a long-lived bot recovers its
    // session instead of failing every subsequent request.
    if (typeof client.onStaleSession === "function") client.onStaleSession(err);
    throw err;
  }
  if (json && json.error === 1357004) {
    // mautrix-meta ErrPleaseReloadPage: the cached bootstrap page (dtsg/lsd) is
    // stale; a full reconnect re-reads it rather than failing forever.
    const err = new Error("Please reload the page.");
    err.error = "Please reload the page.";
    err.errorCode = 1357004;
    err.res = json;
    if (typeof client.onStaleSession === "function") client.onStaleSession(err);
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
  return withStaleRetry(client, options, async () => {
    const query = buildForm(client, form);
    const qs = new URLSearchParams(query).toString();
    const target = qs ? url + (url.includes("?") ? "&" : "?") + qs : url;
    const headers = client.http.buildHeaders({ withCookies: true });
    Object.assign(headers, options.customHeader || {});
    const res = await client.http.request(target, { method: "GET", headers });
    return checkResponse(client, res.body);
  });
}

async function httpPost(client, url, form, options = {}) {
  return withStaleRetry(client, options, async () => {
    const body = new URLSearchParams(buildForm(client, form)).toString();
    const headers = client.http.buildHeaders({ withCookies: true });
    headers["content-type"] = "application/x-www-form-urlencoded";
    headers["origin"] = client.getEndpoint("base_url");
    headers["referer"] = client.getEndpoint("base_url") + "/";
    Object.assign(headers, options.customHeader || {});
    const res = await client.http.request(url, { method: "POST", headers, body });
    return checkResponse(client, res.body);
  });
}

async function httpPostFormData(client, url, form, options = {}) {
  return withStaleRetry(client, options, async () => {
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
  });
}

// POST to a GraphQL batch endpoint and return the concatenated JSON array.
async function postGraphqlBatch(client, url, form) {
  return withStaleRetry(client, {}, async () => {
    const body = new URLSearchParams(buildForm(client, form)).toString();
    const headers = client.http.buildHeaders({ withCookies: true });
    headers["content-type"] = "application/x-www-form-urlencoded";
    // Only send x-fb-lsd when a token is known; mautrix-meta omits the header
    // entirely instead of sending it empty.
    const lsd = client.configs && client.configs.lsd;
    if (lsd) headers["x-fb-lsd"] = lsd;
    headers["x-fb-friendly-name"] = form && (form.fb_api_req_friendly_name || form.batch_name || form.__friendlyName) || "";
    headers["origin"] = client.getEndpoint("base_url");
    headers["referer"] = client.getEndpoint("base_url") + "/";
    const res = await client.http.request(url, { method: "POST", headers, body });
    const parsed = parseBatchJSON(res.body);
    if (parsed === null) {
      throw new Error("postGraphqlBatch: failed to parse response");
    }
    checkBatchStale(client, parsed);
    return parsed;
  });
}

// mautrix-meta inspects the LS response ErrorCode and treats 1357001/1357004 as
// a stale bootstrap (refresh + retry). Batch GraphQL responses carry the same
// code as a top-level `error` field, which must drive the same recovery rather
// than being returned to callers as a successful (but empty) result.
function checkBatchStale(client, parsed) {
  const items = Array.isArray(parsed) ? parsed : [parsed];
  for (const item of items) {
    if (!item || typeof item !== "object") continue;
    const code = item.error !== undefined ? item.error : item.errorCode;
    if (code !== 1357001 && code !== 1357004) continue;
    const err = new Error(code === 1357004 ? "Please reload the page." : "Not logged in.");
    err.error = code;
    err.errorCode = code;
    err.res = item;
    throw err;
  }
}

// mautrix-meta retries a request once the stale bootstrap (fb_dtsg/lsd) has been
// refreshed (error 1357001/1357004 -> refresh -> retry). A long-lived bot hits
// this on GraphQL/Mercury calls well before the socket drops, so recover here
// instead of surfacing "not logged in" to every caller.
async function withStaleRetry(client, options, fn) {
  try {
    return await fn();
  } catch (err) {
    const code = err && (err.errorCode || (err.res && err.res.error));
    if (options.retryOnStale === false || (code !== 1357001 && code !== 1357004)) throw err;
    if (typeof client.refreshStaleSession === "function") await client.refreshStaleSession().catch(() => {});
    else if (typeof client.onStaleSession === "function") client.onStaleSession(err);
    return fn();
  }
}

module.exports = { httpGet, httpPost, httpPostFormData, postGraphqlBatch, buildForm, checkResponse };
