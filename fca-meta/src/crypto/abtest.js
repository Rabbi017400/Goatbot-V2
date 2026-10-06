"use strict";

const B64_CHARSET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

const b = 32;
const f = 48;
const g = 57;
const h = 58;
const i = 63;
const d = 65;
const e = 90;
const j = 91;
const k = 94;
const STD_DEV_KEY_PRESS_DURATION = 20;
const AVG_KEY_PRESS_DURATION = 100;
const AVG_TYPING_INTERVAL = 150;
const STD_DEV_TYPING_INTERVAL = 50;

function normFloat64() {
  let u = 0;
  let v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
}

function humanLikeKeyPressInterval() {
  let interval = Math.trunc(normFloat64() * STD_DEV_TYPING_INTERVAL + AVG_TYPING_INTERVAL);
  if (Math.random() < 0.05) {
    const pause = Math.trunc(Math.random() * 400) + 800;
    interval += pause;
  }
  return interval;
}

function humanLikeKeyPressDuration() {
  return Math.trunc(normFloat64() * STD_DEV_KEY_PRESS_DURATION + AVG_KEY_PRESS_DURATION);
}

function getKeyCode(key) {
  const keyCodeMap = { "@": 50, ".": 190, "#": 163, "$": 164, "%": 165 };
  const charCode = key.charCodeAt(0);
  if (keyCodeMap[key] !== undefined) return keyCodeMap[key];
  return key.toUpperCase().charCodeAt(0);
}

function transform(input) {
  let maxVal = 0;
  for (const val of input) if (val > maxVal) maxVal = val;
  const output = new Array(input.length);
  for (let idx = 0; idx < input.length; idx++) {
    const val = input[idx];
    output[idx] = maxVal !== 0 ? Math.floor((val * 63.0) / maxVal) : val;
  }
  return output;
}

class ABTestData {
  constructor() {
    this.result = [];
    this.l = 0;
    this.m = 0;
    this.n = 0;
    this.o = 0;
    this.q = 0;
    this.s = new Array(20).fill(0);
    this.t = new Array(10).fill(0);
    this.u = new Array(10).fill(0);
    this.r = new Array(10).fill(0);
  }

  mimickTernary(keyCode) {
    if ((keyCode >= d && keyCode <= e) || keyCode === b) this.l++;
    else if (keyCode >= f && keyCode <= g) this.m++;
    else if ((keyCode >= h && keyCode <= i) || (keyCode >= j && keyCode <= k)) this.n++;
    else this.o++;
  }

  mimickTernary2(r, keyCode) {
    if (r >= 0) {
      if ((keyCode >= d && keyCode <= e) || keyCode === b) {
        if (r < 400) this.s[Math.floor(r / 20)]++;
        else if (r < 1000) this.t[Math.floor((r - 400) / 60)]++;
        else if (r < 3000) this.u[Math.floor((r - 1000) / 200)]++;
      }
    }
  }

  encodeResult() {
    let result = "";
    for (const val of this.result) {
      let intVal = Math.trunc(val);
      if (intVal > 63 || intVal <= 0) intVal = 0;
      const charIndex = intVal & 63;
      if (charIndex < B64_CHARSET.length) result += B64_CHARSET[charIndex];
    }
    return result;
  }

  generateAbTestData(strings) {
    let prevTime = 0;
    for (const s of strings) {
      const bytes = Buffer.from(s, "utf8");
      for (const byte of bytes) {
        const keyCode = getKeyCode(String.fromCharCode(byte)) % 128;
        this.mimickTernary(keyCode);

        if (prevTime === 0) {
          prevTime = Date.now();
        } else {
          prevTime += humanLikeKeyPressInterval();
        }
        const timeNow = prevTime;
        const keyDuration = humanLikeKeyPressDuration();
        const timeNow2 = timeNow + keyDuration;

        if (this.q !== 0) {
          const r = timeNow - this.q;
          this.mimickTernary2(r, keyCode);
        }
        this.q = timeNow2;

        const dur = timeNow2 - timeNow;
        if (dur >= 50 && dur < 250) this.r[Math.floor((dur - 50) / 20)]++;
      }
    }

    const concatted = Buffer.concat([
      Buffer.from(this.s),
      Buffer.from(this.t),
      Buffer.from(this.u),
    ]);
    const transformed = transform(concatted);
    const transformedR = transform(this.r);

    this.result = this.result.concat(transformed);
    this.result = this.result.concat(transformedR);
    this.result = this.result.concat([this.l / 2, this.m / 2, this.n / 2, this.o / 2]);
    return this.encodeResult();
  }
}

module.exports = { ABTestData };
