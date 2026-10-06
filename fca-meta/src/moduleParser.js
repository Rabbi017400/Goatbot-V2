"use strict";

const { Bitmap } = require("./crypto/bitmap");
const { LightSpeedDecoder } = require("./lightspeed");
const { parseLossless } = require("./bigjson");
const { generateWebSessionID } = require("./utils");

function extractScripts(html) {
  const scripts = [];
  const re = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const attrs = m[1] || "";
    const idMatch = attrs.match(/id\s*=\s*["']([^"']+)["']/i);
    const srcMatch = attrs.match(/src\s*=\s*["']([^"']+)["']/i);
    scripts.push({ id: idMatch ? idMatch[1] : null, src: srcMatch ? srcMatch[1] : null, content: m[2] || "" });
  }
  return scripts;
}

function extractLinks(html) {
  const links = [];
  const re = /<link\b([^>]*)>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const attrs = m[1] || "";
    links.push({
      as: (attrs.match(/\bas\s*=\s*["']([^"']+)["']/i) || [])[1],
      href: (attrs.match(/\bhref\s*=\s*["']([^"']+)["']/i) || [])[1],
    });
  }
  return links;
}

// Scans a single JSON object/array value starting at `start`.
function scanJSONValue(source, start) {
  let i = start;
  while (i < source.length && /\s/.test(source[i])) i++;
  const open = source[i];
  if (open !== "{" && open !== "[") return undefined;
  const close = open === "{" ? "}" : "]";
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let j = i; j < source.length; j++) {
    const ch = source[j];
    if (inString) {
      if (escape) escape = false;
      else if (ch === "\\") escape = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(source.slice(i, j + 1));
        } catch (_) {
          return undefined;
        }
      }
    }
  }
  return undefined;
}

// Parses the JSON value that follows `"<name>",[],` in the raw page source.
function extractConfigValue(source, name) {
  const marker = `"${name}",[],`;
  const idx = source.indexOf(marker);
  if (idx === -1) return undefined;
  return scanJSONValue(source, idx + marker.length);
}

class Configs {
  constructor() {
    this.currentUser = {};
    this.siteData = {};
    this.lsd = "";
    this.dtsg = "";
    this.jazoest = "";
    this.cometReq = "";
    this.routingNamespace = "";
    this.connectionClass = "";
    this.versionID = 0;
    this.webSessionID = "";
    this.mqttWebDeviceID = "";
    this.dgwWebConfig = {};
    this.mqttWebConfig = {};
    this.bitmap = new Bitmap();
    this.csrBitmap = new Bitmap();
    this.bitmapStr = "";
    this.csrBitmapStr = "";
    this.parentThreadKeys = [];
    this.syncParams = {};
    this.raw = "";
  }

  get userId() {
    return String(this.currentUser.USER_ID || this.currentUser.AccountID || "0");
  }

  get accountId() {
    return String(this.currentUser.ACCOUNT_ID || this.currentUser.AccountId || "0");
  }

  get appId() {
    return String(this.currentUser.APP_ID || "");
  }

  get name() {
    return this.currentUser.NAME || "";
  }

  get shortName() {
    return this.currentUser.SHORT_NAME || "";
  }

  isAuthenticated() {
    return this.accountId !== "0" && this.userId !== "0";
  }
}

function parseBootstrap(html) {
  const raw = html.toString("utf8");
  const configs = new Configs();
  configs.raw = raw;
  const scripts = extractScripts(raw);

  configs.currentUser = extractConfigValue(raw, "CurrentUserInitialData") || {};
  configs.siteData = extractConfigValue(raw, "SiteData") || {};
  const lsd = extractConfigValue(raw, "LSD");
  configs.lsd = (lsd && lsd.token) || "";
  const dtsg = extractConfigValue(raw, "DTSGInitData") || extractConfigValue(raw, "DTSGInitialData");
  configs.dtsg = (dtsg && dtsg.token) || "";
  const mqttDevice = extractConfigValue(raw, "MqttWebDeviceID");
  configs.mqttWebDeviceID = (mqttDevice && mqttDevice.clientID) || "";
  configs.dgwWebConfig = extractConfigValue(raw, "DGWWebConfig") || {};
  configs.mqttWebConfig = extractConfigValue(raw, "MqttWebConfig") || {};
  const webClass = extractConfigValue(raw, "WebConnectionClassServerGuess");
  configs.connectionClass = (webClass && webClass.connectionClass) || "";
  const syncParams = extractConfigValue(raw, "LSPlatformMessengerSyncParams");
  configs.syncParams = syncParams || {};

  for (const script of scripts) {
    const content = (script.content || "").trim();
    if (!content) continue;
    if (script.id === "envjson") {
      const d = parseLossless(content);
      if (d && d.routing_namespace) configs.routingNamespace = d.routing_namespace;
    } else if (script.id === "__eqmc") {
      const d = parseLossless(content);
      if (d && d.u) {
        try {
          const u = new URL(d.u);
          configs.jazoest = u.searchParams.get("jazoest") || configs.jazoest;
          configs.cometReq = u.searchParams.get("__comet_req") || configs.cometReq;
        } catch (_) { /* ignore */ }
      }
    }
  }

  const dynMatch = raw.match(/"__dyn"\s*:\s*"([^"]*)"/);
  if (dynMatch) configs.bitmapStr = dynMatch[1];
  const csrMatch = raw.match(/"__csr"\s*:\s*"([^"]*)"/);
  if (csrMatch) configs.csrBitmapStr = csrMatch[1];
  const jazoestMatch = raw.match(/"jazoest"\s*:\s*"?(\d+)"?/);
  if (jazoestMatch && !configs.jazoest) configs.jazoest = jazoestMatch[1];
  const cometReqMatch = raw.match(/"__comet_req"\s*:\s*"?(\d+)"?/);
  if (cometReqMatch && !configs.cometReq) configs.cometReq = cometReqMatch[1];

  const versionMatch = raw.match(/__d\("LSVersion"[\s\S]{0,200}?exports="(\d+)"/);
  if (versionMatch) configs.versionID = versionMatch[1];

  configs.webSessionID = generateWebSessionID(configs.isAuthenticated());

  const ls = extractLightspeedData(raw);
  configs.parentThreadKeys = ls.parentThreadKeys;

  return { configs, lsTable: ls.table };
}

function extractLightspeedData(raw) {
  const table = {};
  const parentThreadKeys = [];

  const re = /"RelayPrefetchedStreamCache"[\s\S]*?(\{"complete"[\s\S]*?\})\s*\]/g;
  let m;
  while ((m = re.exec(raw)) !== null) {
    const value = scanJSONValue(m[1], 0);
    if (value) applyLightspeedResult(value.result || value, table, parentThreadKeys);
  }

  const payloadRe = /"payload"\s*:\s*"((?:\\.|[^"\\])*)"[\s\S]{0,4000}?"dependencies"\s*:\s*(\[[\s\S]*?\])/g;
  while ((m = payloadRe.exec(raw)) !== null) {
    try {
      const payload = JSON.parse('"' + m[1] + '"');
      const deps = JSON.parse(m[2]);
      applyLightspeedPayload(payload, deps, table, parentThreadKeys);
    } catch (_) { /* ignore */ }
  }

  return { table, parentThreadKeys };
}

function applyLightspeedResult(result, table, parentThreadKeys) {
  if (!result) return;
  const ls = result.viewer && result.viewer.lightspeed_web_request;
  if (ls) applyLightspeedPayload(ls.payload, ls.dependencies, table, parentThreadKeys);
}

function applyLightspeedPayload(payloadStr, deps, table, parentThreadKeys) {
  if (!payloadStr) return;
  let payload;
  try {
    payload = JSON.parse(payloadStr);
  } catch (_) {
    return;
  }
  const depMap = {};
  for (const dep of deps || []) {
    if (dep && dep.name) depMap[dep.name] = dep.value && dep.value.__dr !== undefined ? dep.value.__dr : dep.value;
  }
  const t = {};
  const decoder = new LightSpeedDecoder(depMap, t);
  decoder.decode(payload.step);
  for (const key of Object.keys(t)) {
    if (!table[key]) table[key] = [];
    table[key].push(...t[key]);
  }
  for (const range of t.LSThreadsRangesQuery || []) {
    if (range.ParentThreadKey !== undefined && !parentThreadKeys.includes(range.ParentThreadKey)) {
      parentThreadKeys.push(range.ParentThreadKey);
    }
  }
}

function findVersionInJS(content) {
  const m = content.match(/__d\("LSVersion"[\s\S]{0,200}?exports="(\d+)"/);
  return m ? m[1] : 0;
}

module.exports = { parseBootstrap, extractScripts, extractLinks, extractConfigValue, findVersionInJS, Configs };
