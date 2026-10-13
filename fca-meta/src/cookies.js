"use strict";

const FB_REQUIRED_COOKIES = ["xs", "c_user", "datr"];

class Cookies {
  constructor(values) {
    this.values = {};
    this.updateValues(values || {});
  }

  updateValues(newValues) {
    this.values = {};
    for (const key of Object.keys(newValues || {})) {
      const value = newValues[key];
      if (value !== undefined && value !== null) this.values[key] = String(value);
    }
  }

  set(key, value) {
    if (value === undefined || value === null) delete this.values[key];
    else this.values[key] = String(value);
  }

  get(key) {
    return this.values[key] === undefined ? "" : this.values[key];
  }

  has(key) {
    return this.values[key] !== undefined && this.values[key] !== "";
  }

  getAll() {
    return Object.assign({}, this.values);
  }

  isLoggedIn() {
    return this.has("xs") && this.has("c_user");
  }

  getUserID() {
    return this.values["c_user"] || "0";
  }

  getMissingCookieNames() {
    return FB_REQUIRED_COOKIES.filter((name) => !this.has(name));
  }

  // mautrix-meta applies every Set-Cookie the server sends back to the live jar
  // (Cookies.UpdateFromResponse). Meta rotates short-lived cookies such as `fr`
  // and `sb` mid-session, and a long-lived client that ignores the rotation
  // keeps sending a stale value, which is one of the signals that gets an
  // account logged out. Mirror that behaviour: update present values and delete
  // cookies the server explicitly expires.
  updateFromResponse(headers) {
    if (!headers) return;
    let setCookies = [];
    if (typeof headers.getSetCookie === "function") setCookies = headers.getSetCookie() || [];
    else if (typeof headers.get === "function") {
      const raw = headers.get("set-cookie");
      if (raw) setCookies = [raw];
    } else if (Array.isArray(headers)) {
      setCookies = headers;
    }
    for (const raw of setCookies) {
      const parsed = parseSetCookie(raw);
      if (!parsed) continue;
      if (parsed.deleted) delete this.values[parsed.name];
      else this.values[parsed.name] = parsed.value;
    }
  }

  toString() {
    const parts = [];
    for (const key of Object.keys(this.values)) parts.push(`${key}=${this.values[key]}`);
    return parts.join("; ");
  }

  getViewports() {
    const wd = this.values["wd"];
    if (!wd) return ["1920", "1003"];
    const pxs = String(wd).split("x");
    if (pxs.length !== 2) return ["1920", "1003"];
    return [pxs[0], pxs[1]];
  }
}

function parseSetCookie(raw) {
  if (!raw) return null;
  const parts = String(raw).split(";");
  const pair = parts.shift();
  const eq = pair.indexOf("=");
  if (eq === -1) return null;
  const name = pair.slice(0, eq).trim();
  const value = pair.slice(eq + 1).trim();
  if (!name) return null;
  let maxAge = null;
  let expires = null;
  for (const attr of parts) {
    const [keyRaw, ...rest] = attr.split("=");
    const key = keyRaw.trim().toLowerCase();
    const attrValue = rest.join("=").trim();
    if (key === "max-age") {
      const n = Number(attrValue);
      if (!Number.isNaN(n)) maxAge = n;
    } else if (key === "expires") {
      const t = Date.parse(attrValue);
      if (!Number.isNaN(t)) expires = t;
    }
  }
  // Mirror Go's net/http cookie semantics (mautrix Cookies.UpdateFromResponse):
  // Go normalises any explicit `max-age<=0` to -1 (a deletion), and only falls
  // back to `Expires` when Max-Age is absent. The value itself is irrelevant —
  // Facebook clears `xs` as `xs=deleted; expires=Thu, 01 Jan 1970 ...`, so a
  // non-empty value must still be treated as a deletion.
  const deleted =
    (maxAge !== null && maxAge <= 0) ||
    (maxAge === null && expires !== null && expires <= Date.now());
  return { name, value, maxAge, expires, deleted };
}

function cookiesFromAppState(appState) {
  const values = {};
  for (const item of appState || []) {
    const key = item.key || item.name;
    if (!key) continue;
    values[key] = item.value;
  }
  return new Cookies(values);
}

function appStateFromCookies(cookies) {
  const appState = [];
  for (const key of Object.keys(cookies.values)) {
    appState.push({
      key,
      value: cookies.values[key],
      domain: "facebook.com",
      path: "/",
      hostOnly: false,
      creation: new Date().toISOString(),
      lastAccessed: new Date().toISOString(),
    });
  }
  return appState;
}

module.exports = { Cookies, cookiesFromAppState, appStateFromCookies, FB_REQUIRED_COOKIES, parseSetCookie };
