"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { appStateFromCookies } = require("./cookies");

const STORE_VERSION = 1;

function defaultDir() {
  return process.env.FCA_META_STATE_DIR || path.join(os.homedir() || ".", ".fca-meta");
}

function sanitizeKey(key) {
  const value = String(key || "").trim();
  if (!value) return "";
  return value.replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 120);
}

function cookieKeyFromCookies(cookies) {
  const get = (name) => (cookies && (cookies.get ? cookies.get(name) : cookies[name])) || "";
  const cUser = get("c_user");
  if (cUser) return sanitizeKey("u" + cUser);
  const datr = get("datr");
  if (datr) return sanitizeKey("d" + crypto.createHash("sha256").update(datr).digest("hex").slice(0, 16));
  return "";
}

function cookieKeyFromAppState(appState) {
  return cookieKeyFromCookies(cookiesFromAppState(appState || []));
}

class SessionStore {
  constructor(options = {}) {
    if (options instanceof SessionStore) return options;
    const config = options && typeof options === "object" ? options : {};
    this.enabled = config.enabled !== false;
    this.dir = config.dir || defaultDir();
    this.key = sanitizeKey(config.key || "");
    this.file = config.file || "";
    this._warned = false;
  }

  _path() {
    if (this.file) return this.file;
    if (!this.key) return "";
    return path.join(this.dir, this.key + ".json");
  }

  _warn(error) {
    if (this._warned || !this.enabled) return;
    this._warned = true;
    if (process.emitWarning) {
      process.emitWarning("fca-meta session store: " + ((error && error.message) || error), "FcaMetaSessionStoreWarning");
    }
  }

  load() {
    if (!this.enabled) return null;
    const file = this._path();
    if (!file) return null;
    let raw;
    try {
      raw = fs.readFileSync(file, "utf8");
    } catch (_) {
      return null;
    }
    let data;
    try {
      data = JSON.parse(raw);
    } catch (_) {
      return null;
    }
    if (!data || data.version !== STORE_VERSION) return null;
    if (this.key.startsWith("u") && data.userID && "u" + data.userID !== this.key) return null;
    return data;
  }

  save(data) {
    if (!this.enabled) return false;
    const file = this._path();
    if (!file) return false;
    const jar = data && data.cookies;
    const pkg = {
      version: STORE_VERSION,
      userID: (data && data.userID) || "",
      deviceID: (data && data.deviceID) || "",
      userAgent: (data && data.userAgent) || "",
      cookies: appStateFromCookies(jar),
      rotations: (data && data.rotations) || {},
      savedAt: new Date().toISOString(),
    };
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = file + "." + process.pid + ".tmp";
      fs.writeFileSync(tmp, JSON.stringify(pkg, null, 2));
      fs.renameSync(tmp, file);
      try {
        fs.chmodSync(file, 0o600);
      } catch (_) {
        /* best effort */
      }
      return true;
    } catch (error) {
      this._warn(error);
      return false;
    }
  }

  clear() {
    if (!this.enabled) return false;
    const file = this._path();
    if (!file) return false;
    try {
      fs.unlinkSync(file);
      return true;
    } catch (_) {
      return false;
    }
  }
}

function cookiesToPropsData(cookies) {
  const values = cookies && cookies.values ? cookies.values : cookies || {};
  const out = {};
  for (const key of Object.keys(values)) {
    const value = values[key];
    if (value === undefined || value === null) continue;
    out[key] = {
      value: String(value),
      domain: ".facebook.com",
      path: "/",
      hostOnly: false,
      creation: new Date().toISOString(),
      lastAccessed: new Date().toISOString(),
    };
  }
  return out;
}

module.exports = { SessionStore, STORE_VERSION, defaultDir, sanitizeKey, cookieKeyFromCookies, cookieKeyFromAppState, cookiesToPropsData };
