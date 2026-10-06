"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { Client } = require("../src/client");
const { Cookies } = require("../src/cookies");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "fca-int-"));
const file = path.join(tmp, "acct.json");

const c1 = new Client({ cookies: new Cookies({ xs: "OLD", c_user: "42", datr: "OLDD", sb: "SB1" }), store: { file } });
assert.strictEqual(c1.sessionStore.key, "u42");
c1.cookies.set("xs", "NEW");
c1._onCookieRotation(["xs", "datr"]);
assert.strictEqual(c1.persistSession(true), true);

const saved = JSON.parse(fs.readFileSync(file, "utf8"));
assert.ok(saved.rotations.xs && saved.rotations.datr, "rotations recorded");
assert.ok(saved.cookies.some((c) => c.key === "xs" && c.value === "NEW"), "rotated xs persisted");
assert.strictEqual(saved.rotations.xs.previous, "OLD", "rotation remembers the seeded value");

const c2 = new Client({ cookies: new Cookies({ xs: "OLD", c_user: "42", datr: "OLDD", sb: "SB1" }), store: { file } });
assert.strictEqual(c2.cookies.get("xs"), "NEW", "rotated xs must win over stale appState");
assert.strictEqual(c2.cookies.get("datr"), "OLDD", "non-rotated cookie keeps fresh appState value");
assert.strictEqual(c2.cookies.get("sb"), "SB1");

const c3 = new Client({ cookies: new Cookies({ xs: "BRANDNEW", c_user: "42", datr: "OLDD", sb: "SB1" }), store: { file } });
assert.strictEqual(c3.cookies.get("xs"), "BRANDNEW", "fresh appState wins when store has no rotation");

const anon = new Client({ cookies: new Cookies({ datr: "D1" }), store: { file: path.join(tmp, "anon.json") } });
assert.ok(anon.sessionStore.key.startsWith("d"), "datr-derived key");

const devFile = path.join(tmp, "dev.json");
const d1 = new Client({ cookies: new Cookies({ xs: "X", c_user: "77", datr: "DD", sb: "SB" }), store: { file: devFile } });
d1.configs = { mqttWebDeviceID: "device-abc-123" };
assert.strictEqual(d1.persistSession(true), true);
const devSaved = JSON.parse(fs.readFileSync(devFile, "utf8"));
assert.strictEqual(devSaved.deviceID, "device-abc-123", "device id must be persisted");

const d2 = new Client({ cookies: new Cookies({ xs: "X", c_user: "77", datr: "DD", sb: "SB" }), store: { file: devFile } });
assert.strictEqual(d2._persistedDeviceID, "device-abc-123", "device id must be reloaded for reuse");

c2.sessionStore.clear();
assert.strictEqual(c2.sessionStore.load(), null);

fs.rmSync(tmp, { recursive: true, force: true });
console.log("integration: persistence wiring OK");
