"use strict";

const UNSAFE_INT = 9007199254740992n;
const MARKER = "\u0000__fca_bigint__";
const ESCAPED_MARKER = "\\u0000__fca_bigint__";

function rewriteBigInts(text) {
  let out = "";
  let i = 0;
  const len = text.length;
  let inString = false;
  while (i < len) {
    const ch = text[i];
    if (inString) {
      out += ch;
      if (ch === "\\") {
        if (i + 1 < len) {
          out += text[i + 1];
          i += 2;
          continue;
        }
        i += 1;
        continue;
      }
      if (ch === '"') inString = false;
      i += 1;
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      i += 1;
      continue;
    }
    if (ch === "-" || (ch >= "0" && ch <= "9")) {
      const start = i;
      if (ch === "-") i += 1;
      const digitsStart = i;
      while (i < len && text[i] >= "0" && text[i] <= "9") i += 1;
      if (i === digitsStart) {
        out += text.slice(start, i);
        continue;
      }
      const intEnd = i;
      if (i < len && (text[i] === "." || text[i] === "e" || text[i] === "E")) {
        if (text[i] === ".") {
          i += 1;
          while (i < len && text[i] >= "0" && text[i] <= "9") i += 1;
        }
        if (i < len && (text[i] === "e" || text[i] === "E")) {
          i += 1;
          if (text[i] === "+" || text[i] === "-") i += 1;
          while (i < len && text[i] >= "0" && text[i] <= "9") i += 1;
        }
        out += text.slice(start, i);
        continue;
      }
      const literal = text.slice(start, intEnd);
      const big = BigInt(literal);
      if (big <= -UNSAFE_INT || big >= UNSAFE_INT) {
        out += '"' + ESCAPED_MARKER + literal + '"';
      } else {
        out += literal;
      }
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

function revive(value) {
  if (typeof value === "string" && value.startsWith(MARKER)) {
    return BigInt(value.slice(MARKER.length));
  }
  return value;
}

function parseLossless(text) {
  if (typeof text !== "string") text = String(text);
  return JSON.parse(rewriteBigInts(text), (key, value) => revive(value));
}

module.exports = { parseLossless, MARKER, UNSAFE_INT };
