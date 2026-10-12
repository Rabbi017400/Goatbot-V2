"use strict";

const assert = require("assert");
const { Client } = require("../src/client");
const { Cookies } = require("../src/cookies");

// fca-meta must never back up or reuse cookies from disk: every login uses
// exactly the appState it was given (account.txt), so a redeploy cannot
// resurrect a previous, possibly-rotated session.

const c = new Client({ cookies: new Cookies({ xs: "OLD", c_user: "42", datr: "OLDD", sb: "SB1" }) });
assert.strictEqual(c.sessionStore, undefined, "no session store is created");
assert.strictEqual(typeof c.persistSession, "undefined", "no persistence API on the client");

// Cookie rotation is applied in-memory for the running session only.
c.cookies.set("xs", "NEW");
assert.strictEqual(c.cookies.get("xs"), "NEW");

// A fresh client built from the same appState starts from the appState values,
// not from anything written by the previous one.
const c2 = new Client({ cookies: new Cookies({ xs: "OLD", c_user: "42", datr: "OLDD", sb: "SB1" }) });
assert.strictEqual(c2.cookies.get("xs"), "OLD", "appState is the single source of truth");
assert.strictEqual(c2.cookies.get("datr"), "OLDD");

console.log("integration: no-persistence wiring OK");
