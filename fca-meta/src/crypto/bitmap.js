"use strict";

const CHAR_MAP = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ-_";

function encodeRunLength(num) {
  const binaryStr = num.toString(2);
  return "0".repeat(binaryStr.length - 1) + binaryStr;
}

function encodeBase64(binaryStr) {
  while (binaryStr.length % 6 !== 0) binaryStr += "0";
  let result = "";
  for (let i = 0; i < binaryStr.length; i += 6) {
    const val = parseInt(binaryStr.slice(i, i + 6), 2);
    result += CHAR_MAP[val];
  }
  return result;
}

class Bitmap {
  constructor() {
    this.bMap = [];
    this.compressedStr = "";
  }

  update(data) {
    let maxIndex = -1;
    for (const index of data) if (index > maxIndex) maxIndex = index;
    if (maxIndex >= this.bMap.length) {
      const expanded = new Array(maxIndex + 1).fill(0);
      for (let i = 0; i < this.bMap.length; i++) expanded[i] = this.bMap[i];
      this.bMap = expanded;
    }
    for (const index of data) {
      if (this.bMap[index] === 0 && this.compressedStr !== "") this.compressedStr = "";
      this.bMap[index] = 1;
    }
    return this;
  }

  toCompressedString() {
    if (this.bMap.length === 0) return this;
    if (this.compressedStr !== "") return this;

    let out = "";
    let count = 1;
    let lastValue = this.bMap[0];
    out += String(lastValue);
    for (let i = 1; i < this.bMap.length; i++) {
      const currentValue = this.bMap[i];
      if (currentValue === lastValue) {
        count++;
      } else {
        out += encodeRunLength(count);
        lastValue = currentValue;
        count = 1;
      }
    }
    if (count > 0) out += encodeRunLength(count);
    this.compressedStr = encodeBase64(out);
    return this;
  }
}

module.exports = { Bitmap };
