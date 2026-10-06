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

  updateFromResponse(headers) {
    const rotated = [];
    if (!headers) return rotated;
    const setCookie = headers.getSetCookie ? headers.getSetCookie() : headers.raw ? headers.raw()["set-cookie"] : null;
    if (!setCookie) return rotated;
    const now = Date.now();
    for (const raw of setCookie) {
      const [pair] = raw.split(";");
      const eq = pair.indexOf("=");
      if (eq === -1) continue;
      const name = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1).trim();
      if (!name) continue;
      let expired = false;
      let maxAge = null;
      for (const attr of raw.split(";").slice(1)) {
        const [a, v] = attr.split("=");
        const attrName = (a || "").trim().toLowerCase();
        if (attrName === "max-age" && v !== undefined) maxAge = parseInt(v.trim(), 10);
        else if (attrName === "expires" && v !== undefined) {
          const t = Date.parse(v.trim());
          expired = !Number.isNaN(t) && t < now;
        }
      }
      const remove = (maxAge !== null && maxAge <= 0) || (maxAge === null && expired);
      const previous = this.values[name];
      if (remove) delete this.values[name];
      else this.values[name] = value;
      rotated.push({ name, previous });
    }
    return rotated;
  }
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

module.exports = { Cookies, cookiesFromAppState, appStateFromCookies, FB_REQUIRED_COOKIES };
