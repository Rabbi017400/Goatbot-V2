"use strict";

function int(value) {
  if (value === null || value === undefined) return 0;
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "number") return Math.trunc(value);
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value === "string") {
    const n = Number(value);
    return Number.isNaN(n) ? 0 : Math.trunc(n);
  }
  return 0;
}

// int64 fields are mostly Facebook ids (threads, users, attachments). They can
// exceed Number.MAX_SAFE_INTEGER, so keep the exact value as a BigInt and only
// fall back to a plain number when the value is representable.
function bigint(value) {
  if (value === null || value === undefined) return 0;
  if (typeof value === "bigint") return value;
  if (typeof value === "number") {
    return Number.isSafeInteger(value) ? value : BigInt(Math.trunc(value));
  }
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!/^-?\d+$/.test(trimmed)) return 0;
    try {
      const parsed = BigInt(trimmed);
      return parsed >= -9007199254740991n && parsed <= 9007199254740991n ? Number(parsed) : parsed;
    } catch (_) {
      return 0;
    }
  }
  return 0;
}

function str(value) {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return "";
}

function bool(value) {
  if (value === null || value === undefined) return false;
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "string") return value !== "" && value !== "0" && value !== "false";
  return Boolean(value);
}

function any(value) {
  return value;
}

module.exports = { int, bigint, str, bool, any };
