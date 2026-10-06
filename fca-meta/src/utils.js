"use strict";

const crypto = require("crypto");

const META_EPOCH_MS = 1072915200000;

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getType(obj) {
  return Object.prototype.toString.call(obj).slice(8, -1);
}

let lastTimestamp = 0;
let epochCounter = 0;
function generateEpochID() {
  const timestamp = Date.now();
  if (timestamp === lastTimestamp) {
    epochCounter++;
  } else {
    lastTimestamp = timestamp;
    epochCounter = 0;
  }
  return (BigInt(timestamp) << 22n) | (BigInt(epochCounter) << 12n) | 42n;
}

function generateEpochIDString() {
  return generateEpochID().toString();
}

function randomString(length) {
  const chars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  let out = "";
  const bytes = crypto.randomBytes(length);
  for (let i = 0; i < length; i++) out += chars[bytes[i] % chars.length];
  return out;
}

function generateMachineID() {
  return randomString(51).toLowerCase();
}

function generateSessionID() {
  const min = 2171078810009599n;
  const max = 4613554604867583n;
  const range = max - min + 1n;
  const value = BigInt("0x" + crypto.randomBytes(8).toString("hex")) % range;
  return (min + value).toString();
}

function generateWebSessionID(loggedIn) {
  const rand = () => randomString(6).toLowerCase();
  if (loggedIn) return `${rand()}:${rand()}:${rand()}`;
  return `:${rand()}:${rand()}`;
}

function generateTraceID() {
  const uuidHex = crypto.randomUUID().replace(/-/g, "");
  return "#" + Buffer.from(uuidHex, "hex").toString("base64url");
}

function generateThreadingID(clientID) {
  const k = Date.now();
  const l = Math.floor(Math.random() * 4294967295);
  return `<${k}:${l}-${clientID}@mail.projektitan.com>`;
}

function binaryToDecimal(data) {
  let ret = "";
  while (data !== "0") {
    let end = 0;
    let fullName = "";
    for (let i = 0; i < data.length; i++) {
      end = 2 * end + parseInt(data[i], 10);
      if (end >= 10) {
        fullName += "1";
        end -= 10;
      } else {
        fullName += "0";
      }
    }
    ret = end.toString() + ret;
    data = fullName.slice(fullName.indexOf("1"));
  }
  return ret;
}

function generateOfflineThreadingID() {
  const ret = Date.now();
  const value = Math.floor(Math.random() * 4294967295);
  const str = ("0000000000000000000000" + value.toString(2)).slice(-22);
  const msgs = ret.toString(2) + str;
  return binaryToDecimal(msgs);
}

function generateTimestampRelative() {
  const now = new Date();
  return `${now.getHours()}:${String(now.getMinutes()).padStart(2, "0")}`;
}

function padZeros(val, len) {
  val = String(val);
  len = len || 2;
  while (val.length < len) val = "0" + val;
  return val;
}

function generateTimestampString() {
  return String(Date.now());
}

function getSignatureID() {
  return Math.floor(Math.random() * 2147483648).toString(16);
}

function getGUID() {
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

function isReadableStream(obj) {
  return (
    obj instanceof require("stream").Stream &&
    (getType(obj._read) === "Function" || getType(obj._read) === "AsyncFunction") &&
    getType(obj._readableState) === "Object"
  );
}

function removeSpecialChar(inputString) {
  if (typeof inputString !== "string") return inputString;
  const buffer = Buffer.from(inputString, "utf8");
  let filteredBuffer = Buffer.alloc(0);
  for (let i = 0; i < buffer.length; i++) {
    if (buffer[i] === 0xef && buffer[i + 1] === 0xb8 && buffer[i + 2] === 0x8f) {
      i += 2;
    } else {
      filteredBuffer = Buffer.concat([filteredBuffer, buffer.slice(i, i + 1)]);
    }
  }
  return filteredBuffer.toString("utf8");
}

function parseMessageIDTimestamp(messageID) {
  if (typeof messageID !== "string" || !messageID.startsWith("mid.$") || messageID.length < 6) {
    return null;
  }
  let payload;
  try {
    payload = Buffer.from(messageID.slice(6), "base64url");
  } catch (_) {
    return null;
  }
  if (payload.length !== 21) return null;
  const ms = payload.readUIntBE(8, 5);
  return ms + META_EPOCH_MS;
}

// Thread/contact IDs are int64 and routinely exceed Number.MAX_SAFE_INTEGER, so
// they must reach the wire as their exact digits. Safe values stay plain numbers
// to preserve the legacy fb-chat-api shape; only unrepresentable values become
// BigInt, which stringifyBigInt emits verbatim.
function toBigOrNumber(value) {
  if (value === undefined || value === null || value === "") return value;
  if (typeof value === "bigint") return value;
  if (typeof value === "number") return value;
  if (typeof value === "string" && /^-?\d+$/.test(value)) {
    try {
      const parsed = BigInt(value);
      return parsed >= -9007199254740991n && parsed <= 9007199254740991n ? Number(parsed) : parsed;
    } catch (_) {
      return value;
    }
  }
  return value;
}

// JSON.stringify that keeps BigInt values as raw numbers (needed for epoch_id,
// which exceeds Number.MAX_SAFE_INTEGER).
function stringifyBigInt(obj) {
  const serialize = (value) => {
    if (typeof value === "bigint") return value.toString();
    if (value === null || value === undefined) return "null";
    if (typeof value === "number") return Number.isFinite(value) ? String(value) : "null";
    if (typeof value === "boolean") return value ? "true" : "false";
    if (typeof value === "string") return JSON.stringify(value);
    if (Array.isArray(value)) return "[" + value.map(serialize).join(",") + "]";
    if (typeof value === "object") {
      const parts = [];
      for (const key of Object.keys(value)) {
        if (value[key] === undefined) continue;
        parts.push(JSON.stringify(key) + ":" + serialize(value[key]));
      }
      return "{" + parts.join(",") + "}";
    }
    return "null";
  };
  return serialize(obj);
}

function streamToBuffer(stream) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    stream.on("data", (chunk) => chunks.push(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve(Buffer.concat(chunks)));
  });
}

module.exports = {
  META_EPOCH_MS,
  delay,
  getType,
  generateEpochID,
  generateEpochIDString,
  randomString,
  generateMachineID,
  generateSessionID,
  generateWebSessionID,
  generateTraceID,
  generateThreadingID,
  generateOfflineThreadingID,
  generateTimestampRelative,
  generateTimestampString,
  padZeros,
  getSignatureID,
  getGUID,
  isReadableStream,
  removeSpecialChar,
  parseMessageIDTimestamp,
  toBigOrNumber,
  stringifyBigInt,
  streamToBuffer,
};
