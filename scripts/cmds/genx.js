const axios = require("axios");

const { getStreamFromURL } = global.utils;

const API = "https://myimg-api.vercel.app";

const MODELS = {
  imagine: { gen: "/generate/text-to-image", ar: "size", style: "style",
    params: ["prompt", "style", "width", "height"], required: { gen: ["prompt"] } },
  flux: { gen: "/generate/flux-text-to-image", ar: "flux",
    params: ["prompt", "size"], required: { gen: ["prompt"] } },
  styledit: { edit: "/generate/image-to-image", ar: "size", style: "style",
    params: ["style", "width", "height", "styleId"] },
  image: { edit: "/generate/image-to-image-v2",
    params: ["prompt", "maxSize"], required: { edit: ["prompt"] } },
  edit: { edit: "/generate/edit", style: "preset",
    params: ["preset", "prompt", "tune"] },
  enhance: { edit: "/generate/enhance" },
  pretty: { edit: "/generate/pretty", params: ["level"] },
  restore: { edit: "/generate/restore" },
  animation: { edit: "/generate/animation" },
  eyeopen: { edit: "/generate/eye-open" },
  age: { edit: "/generate/change-age", params: ["targetAge"], required: { edit: ["targetAge"] } },
  hair: { edit: "/generate/change-hair", params: ["hairType"], required: { edit: ["hairType"] } },
  emotion: { edit: "/generate/change-emotion", params: ["emotionType"], required: { edit: ["emotionType"] } },
  clothes: { edit: "/generate/change-clothes",
    params: ["modelUrl", "clothesUrl", "preset", "modelPreset"] },
  segment: { edit: "/generate/segment" },
  cartoon: { edit: "/generate/cartoonized", params: ["index"] },
  repaint: { edit: "/generate/repaint", style: "style", params: ["style"] },
  cosplay: { edit: "/generate/cosplay", params: ["templateUrl", "index"],
    required: { edit: ["templateUrl"] } },
  upscale: { edit: "/generate/scale", params: ["scale", "outputFormat"] },
  faceswap: { edit: "/generate/face-swap", imageParam: "source",
    params: ["source", "target"], required: { edit: ["target"] } },
  nsfw: { gen: "/generate/nsfw-text-to-image", edit: "/generate/nsfw-image-to-image",
    ar: "size", style: "stylePreset",
    params: ["prompt", "style", "stylePreset", "width", "height"], required: { gen: ["prompt"] } },
  video: { edit: "/generate/video",
    params: ["duration", "prompt", "model", "bgmUrl"] },
  videoenhance: { edit: "/generate/video-enhance", imageParam: "videoUrl",
    params: ["videoUrl", "free"] },
  subtitle: { edit: "/generate/remove-subtitle", imageParam: "videoUrl",
    params: ["videoUrl", "bx", "by", "bw", "bh"],
    required: { edit: ["bx", "by", "bw", "bh"] } }
};

const ALIASES = {
  targetage: "targetAge",
  hairtype: "hairType",
  emotiontype: "emotionType",
  modelurl: "modelUrl",
  clothesurl: "clothesUrl",
  modelpreset: "modelPreset",
  templateurl: "templateUrl",
  videourl: "videoUrl",
  maxsize: "maxSize",
  stylepreset: "stylePreset",
  outputformat: "outputFormat",
  generateaudio: "generateAudio",
  firstframe: "firstFrameUrl",
  firstframeurl: "firstFrameUrl",
  lastframe: "lastFrameUrl",
  lastframeurl: "lastFrameUrl",
  bgmurl: "bgmUrl",
  styleid: "styleId"
};

const CONTROL = new Set(["models", "styles", "m", "help", "h"]);
const COMMON = ["i", "img", "imgurl", "image", "wait", "upload"];

const GUIDE = "🐊 NEOKEX GENX\n"
  + "• genx --m <model> <prompt> [--ar <w:h>]\n"
  + "• genx --m <model> <prompt> --i <imgurl>\n"
  + "• reply to an image with: genx --s <preset>\n"
  + "• genx --s <style> --m <model> <prompt>\n"
  + "• genx --models — list models\n"
  + "• genx --styles — list styles\n"
  + "• genx --s — list edit presets";

function parse(args) {
  const flags = {};
  const rest = [];
  for (let i = 0; i < args.length; i++) {
    const token = args[i];
    if (token.startsWith("--")) {
      const key = token.slice(2).toLowerCase();
      const next = args[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = true;
      }
    } else {
      rest.push(token);
    }
  }
  return { flags, rest };
}

function findImage(flags, event) {
  let image = flags.i || flags.img || flags.imgurl || flags.image;
  if (typeof image !== "string") image = undefined;
  const replied = event && event.messageReply;
  if (!image && replied && Array.isArray(replied.attachments)) {
    const att = replied.attachments.find(a => a.url && (
      ["photo", "image", "animated_image", "gif", "video"].includes(a.type) ||
      /\.(png|jpe?g|webp|gif|mp4|mov)$/i.test(a.url)
    ));
    if (att) image = att.url;
  }
  return image;
}

function ratioToSize(ar, base) {
  const m = /^(\d+)\s*[:x/]\s*(\d+)$/.exec(String(ar).trim());
  if (!m) return null;
  const rw = Number(m[1]);
  const rh = Number(m[2]);
  if (!rw || !rh) return null;
  if (rw >= rh) return { width: base, height: Math.round(base * rh / rw) };
  return { width: Math.round(base * rw / rh), height: base };
}

function applyAr(model, ar, params) {
  const size = ratioToSize(ar, 1024);
  if (!size) return;
  if (model.ar === "flux") params.size = `${size.width}x${size.height}`;
  else {
    params.width = size.width;
    params.height = size.height;
  }
}

async function callApi(path, params) {
  const res = await axios.get(API + path, {
    params,
    timeout: 600000,
    validateStatus: () => true
  });
  return res.data;
}

function react(api, message, messageID, emoji) {
  try {
    if (api && typeof api.setMessageReaction === "function") {
      api.setMessageReaction(emoji, messageID, () => {}, true);
      return;
    }
  } catch (e) {}
  try {
    if (typeof message.reaction === "function") message.reaction(emoji, messageID);
  } catch (e) {}
}

function resultUrl(data) {
  const r = (data && data.result) || {};
  return r.resultUrl || r.url || (data && (data.resultUrl || data.url));
}

async function sendMedia(message, data) {
  const url = resultUrl(data);
  if (!url) return false;
  const stream = await getStreamFromURL(url);
  const ext = (url.split("?")[0].match(/\.(png|jpe?g|webp|gif|mp4|mov)$/i) || [null, "png"])[1];
  if (stream && typeof stream === "object") stream.path = `genx.${ext}`;
  await message.reply({ attachment: stream });
  return true;
}

async function listModels(message) {
  const lines = Object.keys(MODELS).map(name => {
    const m = MODELS[name];
    const tags = [m.gen ? "gen" : "", m.edit ? "edit" : ""].filter(Boolean).join("/");
    return `• ${name} — ${tags}`;
  });
  return message.reply(`🧠 Models (${lines.length})\n${lines.join("\n")}`);
}

async function listStyles(message) {
  const data = await callApi("/nsfw-styles", {});
  if (!data || !Array.isArray(data.styles)) return false;
  const lines = data.styles.map(s => `• ${typeof s === "string" ? s : s.name || s.id}`);
  return message.reply(`🔞 Styles (${lines.length})\n${lines.join("\n")}`);
}

async function listPresets(message) {
  const data = await callApi("/edit-presets", {});
  if (!data || !Array.isArray(data.presets)) return false;
  const lines = data.presets.map(p => `• ${p.styleId} — ${p.label}`);
  return message.reply(`🧩 Presets (${lines.length})\n${lines.join("\n")}`);
}

module.exports = {
  config: {
    name: "genx",
    version: "2.1.0",
    author: "Neoaz 🐊",//do not change credits ❌ 
    countDown: 5,
    role: 0,
    shortDescription: { en: "NEOKEX GENX image and video generator" },
    longDescription: { en: "Generate and edit images and video through the NEOKEX GENX API." },
    category: "image",
    guide: {
      en: "{pn} --m <model> <prompt> [--ar <w:h>]\n"
        + "{pn} --m <model> <prompt> --i <imgurl>\n"
        + "reply to an image with: {pn} --s <preset>\n"
        + "{pn} --models | {pn} --styles | {pn} --s"
    }
  },

  onStart: async function ({ api, message, args, event }) {
    const messageID = event.messageID;
    const { flags, rest } = parse(args);

    if (!args.length || flags.help || flags.h)
      return message.reply(GUIDE);
    if (flags.models) return listModels(message);
    if (flags.styles) return listStyles(message);
    if (flags.s === true) return listPresets(message);

    const modelName = typeof flags.m === "string" ? flags.m.toLowerCase() : "";
    const style = typeof flags.s === "string" ? flags.s : undefined;
    const prompt = rest.join(" ").trim();

    if (modelName && !MODELS[modelName])
      return message.reply(`❌ Unknown model: ${modelName}\nUse: genx --models`);

    let image = findImage(flags, event);
    let model = MODELS[modelName];
    if (!model && style && image) model = MODELS.edit;
    if (!model) model = image ? MODELS.image : MODELS.imagine;

    const ip = model.imageParam || "imgurl";
    if (!image && typeof flags[ip.toLowerCase()] === "string") image = flags[ip.toLowerCase()];

    const label = modelName || (model === MODELS.edit ? "edit" : "genx");

    let styleValue = style;
    let promptValue = prompt;
    if (model === MODELS.edit && styleValue) {
      styleValue = [styleValue, promptValue].filter(Boolean).join(" ").trim();
      promptValue = "";
    }

    if (image && !model.edit)
      return message.reply(`❌ ${label} can't edit images. Try: genx --m edit --s <preset>`);
    if (!image && !model.gen)
      return message.reply(`❌ ${label} needs an image. Reply to one or pass --i <imgurl>`);
    if (style && !model.style)
      return message.reply(`❌ ${label} doesn't support --s`);
    if (typeof flags.ar === "string" && !model.ar)
      return message.reply(`❌ ${label} doesn't support --ar`);

    const allowed = new Set([...(model.params || []), ...COMMON, ip].map(k => k.toLowerCase()));
    if (model.ar) allowed.add("ar");
    if (model.style) allowed.add("s");
    for (const key of Object.keys(flags)) {
      if (CONTROL.has(key) || allowed.has(key)) continue;
      return message.reply(`❌ Unknown flag: --${key}\nAllowed for ${label}: ${[...allowed].map(k => "--" + k).join(" ")}`);
    }

    const mode = image ? "edit" : "gen";
    const path = mode === "edit" ? model.edit : model.gen;

    const params = {};
    if (image) params[ip] = image;
    if (promptValue) params.prompt = promptValue;
    if (styleValue) params[model.style] = styleValue;
    if (typeof flags.ar === "string") applyAr(model, flags.ar, params);
    for (const key of Object.keys(flags)) {
      if (CONTROL.has(key) || key === "s" || key === "ar" || key === ip.toLowerCase()) continue;
      const value = flags[key];
      if (value === true) continue;
      params[ALIASES[key] || key] = value;
    }

    const required = (model.required && model.required[mode]) || [];
    const missing = required.filter(p => !params[p]);
    if (missing.length)
      return message.reply(`❌ Missing required: ${missing.map(p => "--" + p).join(" ")}`);

    react(api, message, messageID, "⌛");
    let data;
    try {
      data = await callApi(path, params);
    } catch (e) {
      return react(api, message, messageID, "❌");
    }

    try {
      const sent = data && data.ok !== false ? await sendMedia(message, data) : false;
      react(api, message, messageID, sent ? "✅" : "❌");
    } catch (e) {
      react(api, message, messageID, "❌");
    }
  }
};
