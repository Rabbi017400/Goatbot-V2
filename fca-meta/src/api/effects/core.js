"use strict";

const fs = require("fs");
const path = require("path");

const ASSETS_DIR = path.join(__dirname, "..", "..", "..", "assets");
const AVATAR_DIR = path.join(ASSETS_DIR, "avatar");

const EFFECTS = Object.freeze({
  none: { id: 0, tag: "NONE", emoji: "", label: "None" },
  love: { id: 1, tag: "LOVE", emoji: "\u2764\uFE0F", label: "Love" },
  heart: { id: 1, tag: "LOVE", emoji: "\u2764\uFE0F", label: "Love" },
  hearts: { id: 1, tag: "LOVE", emoji: "\u2764\uFE0F", label: "Love" },
  gift_wrap: { id: 2, tag: "GIFT_WRAP", emoji: "\uD83C\uDF81", label: "Gift wrap" },
  giftwrap: { id: 2, tag: "GIFT_WRAP", emoji: "\uD83C\uDF81", label: "Gift wrap" },
  gift_box: { id: 2, tag: "GIFT_WRAP", emoji: "\uD83C\uDF81", label: "Gift wrap" },
  gift: { id: 2, tag: "GIFT_WRAP", emoji: "\uD83C\uDF81", label: "Gift wrap" },
  present: { id: 2, tag: "GIFT_WRAP", emoji: "\uD83C\uDF81", label: "Gift wrap" },
  celebration: { id: 3, tag: "CELEBRATION", emoji: "\uD83C\uDF89", label: "Celebration" },
  confetti: { id: 3, tag: "CELEBRATION", emoji: "\uD83C\uDF89", label: "Celebration" },
  celebrate: { id: 3, tag: "CELEBRATION", emoji: "\uD83C\uDF89", label: "Celebration" },
  party: { id: 3, tag: "CELEBRATION", emoji: "\uD83C\uDF89", label: "Celebration" },
  fire: { id: 4, tag: "FIRE", emoji: "\uD83D\uDD25", label: "Fire" },
  flame: { id: 4, tag: "FIRE", emoji: "\uD83D\uDD25", label: "Fire" },
  hot: { id: 4, tag: "FIRE", emoji: "\uD83D\uDD25", label: "Fire" },
  avatar_love: { id: 1000, tag: "AVATAR_LOVE", emoji: "", label: "Avatar love" },
  avatar_angry: { id: 1001, tag: "AVATAR_ANGRY", emoji: "", label: "Avatar anger" },
  avatar_anger: { id: 1001, tag: "AVATAR_ANGRY", emoji: "", label: "Avatar anger" },
  avatar_laugh: { id: 1002, tag: "AVATAR_LAUGH", emoji: "", label: "Avatar laugh" },
  avatar_cry: { id: 1003, tag: "AVATAR_CRY", emoji: "", label: "Avatar cry" },
});

const AVATARS = Object.freeze([
  { name: "love", effect: "avatar_love", file: "avatar_love.gif", label: "Love" },
  { name: "anger", effect: "avatar_angry", file: "avatar_anger.gif", label: "Anger" },
  { name: "laugh", effect: "avatar_laugh", file: "avatar_laugh.gif", label: "Laugh" },
  { name: "cry", effect: "avatar_cry", file: "avatar_cry.gif", label: "Cry" },
]);

const AVATAR_ALIASES = {
  angry: "anger",
  mad: "anger",
  angry_face: "anger",
  lol: "laugh",
  laughing: "laugh",
  happy: "laugh",
  sad: "cry",
  crying: "cry",
};

function normalizeKey(name) {
  return String(name).toLowerCase().replace(/[\s-]+/g, "_");
}

function resolveEffect(name) {
  if (name === undefined || name === null || name === "") {
    throw new Error("effect name is required");
  }
  const key = normalizeKey(name);
  if (EFFECTS[key]) return EFFECTS[key].id;
  const numeric = String(name).trim();
  if (/^\d+$/.test(numeric)) return Number(numeric);
  throw new Error("unsupported Messenger effect \"" + name + "\". Use love, gift_wrap, celebration, fire or a numeric effect id.");
}

function resolveEffectTag(name) {
  const key = normalizeKey(name);
  if (EFFECTS[key]) return EFFECTS[key].tag;
  const id = Number(name);
  const found = Object.values(EFFECTS).find((effect) => effect.id === id);
  return found ? found.tag : "CUSTOM";
}

function isAvatarEffect(name) {
  if (name === undefined || name === null || name === "") return false;
  if (getAvatar(name)) return true;
  const key = normalizeKey(name);
  if (EFFECTS[key]) return EFFECTS[key].tag.startsWith("AVATAR_");
  const numeric = String(name).trim();
  if (/^\d+$/.test(numeric)) {
    const id = Number(numeric);
    const found = Object.values(EFFECTS).find((effect) => effect.id === id);
    return Boolean(found && found.tag.startsWith("AVATAR_"));
  }
  return false;
}

function listEffects() {
  const seen = new Set();
  const out = [];
  for (const effect of Object.values(EFFECTS)) {
    if (seen.has(effect.tag)) continue;
    seen.add(effect.tag);
    out.push({
      tag: effect.tag,
      id: effect.id,
      label: effect.label,
      emoji: effect.emoji,
      aliases: Object.entries(EFFECTS).filter(([, value]) => value.tag === effect.tag).map(([key]) => key),
    });
  }
  return out;
}

function getAvatar(name) {
  if (name === undefined || name === null || name === "" || normalizeKey(name) === "random") return null;
  const key = normalizeKey(name);
  const aliased = AVATAR_ALIASES[key] || key;
  const byName = AVATARS.find((avatar) => avatar.name === aliased || normalizeKey(avatar.effect) === aliased);
  if (byName) return byName;
  const numeric = String(name).trim();
  if (/^\d+$/.test(numeric)) {
    const id = Number(numeric);
    return AVATARS.find((avatar) => EFFECTS[avatar.effect] && EFFECTS[avatar.effect].id === id) || null;
  }
  return null;
}

function randomAvatar() {
  return AVATARS[Math.floor(Math.random() * AVATARS.length)];
}

function avatarPath(avatar) {
  return path.join(AVATAR_DIR, avatar.file);
}

function isAvatarSupported() {
  return AVATARS.every((avatar) => fs.existsSync(avatarPath(avatar)));
}

module.exports = {
  ASSETS_DIR,
  AVATAR_DIR,
  EFFECTS,
  AVATARS,
  normalizeKey,
  resolveEffect,
  resolveEffectTag,
  isAvatarEffect,
  listEffects,
  getAvatar,
  randomAvatar,
  avatarPath,
  isAvatarSupported,
};
