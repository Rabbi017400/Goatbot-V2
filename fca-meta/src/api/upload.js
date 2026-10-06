"use strict";

const { streamToBuffer } = require("../utils");
const { parseJSON, stripAntiJS } = require("../http");

const MIME_BY_EXT = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  gif: "image/gif",
  webp: "image/webp",
  mp4: "video/mp4",
  mov: "video/quicktime",
  mp3: "audio/mpeg",
  m4a: "audio/mp4",
  wav: "audio/wav",
  pdf: "application/pdf",
};

function guessMime(filename) {
  const ext = String(filename || "").split(".").pop().toLowerCase();
  return MIME_BY_EXT[ext] || "application/octet-stream";
}

function deriveFilename(attachment) {
  if (attachment && typeof attachment.path === "string" && attachment.path) {
    return String(attachment.path).split(/[\\/]/).pop();
  }
  return "";
}

async function uploadAttachment(client, attachment, threadID) {
  const buffer = Buffer.isBuffer(attachment) ? attachment : await streamToBuffer(attachment);
  const filename = attachment.filename || attachment.name || deriveFilename(attachment) || "upload";
  const mimeType = attachment.mimeType || guessMime(filename);

  const form = new FormData();
  form.append("farr", new Blob([buffer], { type: mimeType }), filename);

  const query = new URLSearchParams(client.newHTTPQuery()).toString();
  const url = client.getEndpoint("media_upload") + query;
  const headers = client.http.buildHeaders({ withCookies: true });
  headers["origin"] = client.getEndpoint("base_url");
  headers["referer"] = client.getEndpoint("thread") + String(threadID) + "/";

  const res = await client.http.request(url, { method: "POST", headers, body: form });
  const json = parseJSON(stripAntiJS(res.body));
  if (!json || !json.payload || !json.payload.metadata) {
    const detail = res.body ? res.body.toString("utf8").slice(0, 200) : "empty response";
    throw new Error("failed to upload attachment: " + detail);
  }
  let metadata = json.payload.metadata;
  if (Array.isArray(metadata)) metadata = metadata[0];
  else if (typeof metadata === "object") metadata = metadata["0"];
  return metadata;
}

async function uploadAttachmentList(client, attachments) {
  const { getType } = require("../utils");
  const list = getType(attachments) === "Array" ? attachments : [attachments];
  const results = [];
  for (const attachment of list) {
    results.push(await uploadAttachment(client, attachment, "0"));
  }
  return results;
}

module.exports = { uploadAttachment, uploadAttachmentList, guessMime };
