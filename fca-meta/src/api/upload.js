"use strict";

const { streamToBuffer, delay, randomString } = require("../utils");
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

const MAX_UPLOAD_ATTEMPTS = 4;
const STALE_SESSION_CODES = new Set([1357001, 1357004]);

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

function extractMetadata(json) {
  if (!json || !json.payload || !json.payload.metadata) return null;
  let metadata = json.payload.metadata;
  if (Array.isArray(metadata)) metadata = metadata[0];
  else if (typeof metadata === "object") metadata = metadata["0"];
  return metadata || null;
}

// mautrix-meta builds the multipart body with a browser-style
// `----WebKitFormBoundary<16 chars>` boundary (SendMercuryUploadRequest ->
// newMercuryMediaPayload). undici's FormData uses `----formdata-undici-*`, which
// is a non-browser fingerprint the upload endpoint can flag. Reproduce the
// browser body (and content-type) exactly.
function buildMercuryMultipart(media) {
  const boundary = "----WebKitFormBoundary" + randomString(16);
  const chunks = [];
  const crlf = "\r\n";
  chunks.push(Buffer.from("--" + boundary + crlf));
  chunks.push(
    Buffer.from(
      `Content-Disposition: form-data; name="farr"; filename="${media.filename}"${crlf}` +
        `Content-Type: ${media.mimeType}${crlf}${crlf}`
    )
  );
  chunks.push(media.buffer);
  chunks.push(Buffer.from(crlf + "--" + boundary + "--" + crlf));
  return { body: Buffer.concat(chunks), contentType: "multipart/form-data; boundary=" + boundary };
}

// mautrix-meta (SendMercuryUploadRequest) retries a Mercury upload when the
// response cannot be parsed, and treats error 1357004 (please reload page) as a
// stale-session signal the connector recovers from with a full reconnect before
// retrying. Text sends ride the Lightspeed socket and keep working while the
// cached bootstrap tokens (fb_dtsg/lsd) go stale, so uploads are the first
// thing to break: the upload query carries the stale lsd, the server rejects
// it, and without this recovery every later upload fails. Mirror that here.
async function uploadAttachment(client, attachment, threadID) {
  const buffer = Buffer.isBuffer(attachment) ? attachment : await streamToBuffer(attachment);
  const filename = attachment.filename || attachment.name || deriveFilename(attachment) || "upload";
  const mimeType = attachment.mimeType || guessMime(filename);
  const multipart = buildMercuryMultipart({ buffer, filename, mimeType });

  let lastErr = null;
  for (let attempt = 1; attempt <= MAX_UPLOAD_ATTEMPTS; attempt++) {
    // Rebuild the query on every attempt: mautrix does the same so a retry
    // after a token refresh carries the fresh fb_dtsg/lsd instead of the stale
    // ones that caused the rejection.
    const query = new URLSearchParams(client.newHTTPQuery()).toString();
    const url = client.getEndpoint("media_upload") + query;
    const headers = client.http.buildHeaders({ withCookies: true });
    headers["content-type"] = multipart.contentType;
    headers["origin"] = client.getEndpoint("base_url");
    headers["referer"] = client.getEndpoint("thread") + String(threadID) + "/";
    // mautrix SendMercuryUploadRequest sets these explicitly; the priority hint
    // and same-origin fetch metadata are required by the upload endpoint.
    headers["priority"] = "u=1, i";
    headers["sec-fetch-dest"] = "empty";
    headers["sec-fetch-mode"] = "cors";
    headers["sec-fetch-site"] = "same-origin";

    const res = await client.http.request(url, { method: "POST", headers, body: multipart.body });
    const json = parseJSON(stripAntiJS(res.body));
    const metadata = extractMetadata(json);
    if (metadata) return metadata;

    // mautrix-meta parseMercuryResponse: a consent redirect is a permanent
    // (non-retryable) signal the connector surfaces, not an upload failure.
    if (json && typeof json.redirect === "string" && json.redirect.includes("/consent/")) {
      const err = new Error("consent required: " + json.redirect);
      err.consentRequired = true;
      throw err;
    }

    if (json && STALE_SESSION_CODES.has(json.error)) {
      const err = new Error(json.error === 1357004 ? "Please reload the page." : "Not logged in.");
      err.error = err.message;
      err.errorCode = json.error;
      err.res = json;
      lastErr = err;
      // Trigger the same recovery mautrix uses for a stale bootstrap and wait
      // for it to finish (fresh fb_dtsg/lsd + cookies) before retrying.
      if (typeof client.refreshStaleSession === "function") {
        await client.refreshStaleSession().catch(() => {});
      } else {
        if (typeof client.onStaleSession === "function") client.onStaleSession(err);
        await delay(2000);
      }
      continue;
    }

    const detail = res.body ? res.body.toString("utf8").slice(0, 200) : "empty response";
    lastErr = new Error("failed to upload attachment: " + detail);
    if (attempt < MAX_UPLOAD_ATTEMPTS) await delay(Math.min(attempt * 3000, 10000));
  }
  throw lastErr || new Error("failed to upload attachment");
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
