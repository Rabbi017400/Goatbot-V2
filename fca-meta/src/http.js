"use strict";

const {
  USER_AGENT,
  DPR,
  ASBD_ID,
  parseUserAgent,
  buildClientHints,
} = require("./useragent");
const { delay } = require("./utils");
const { parseLossless } = require("./bigjson");

const ANTI_JS_PREFIX = Buffer.from("for (;;);");
const MAX_RETRIES = 5;

class RedirectedError extends Error {
  constructor(type, url) {
    super(`${type.message}: redirected to ${url}`);
    this.type = type;
    this.url = url;
  }
}

const errors = {
  tokenInvalidated: new Error("access token is no longer valid"),
  challengeRequired: new Error("challenge required"),
  checkpointRequired: new Error("checkpoint required"),
  consentRequired: new Error("consent required"),
  accountSuspended: new Error("account suspended"),
  rateLimited: new Error("server returned unexpected HTTP status 429"),
  maxRetries: new Error("maximum retries reached"),
};

function stripAntiJS(body) {
  if (Buffer.isBuffer(body) && body.length >= ANTI_JS_PREFIX.length && body.slice(0, ANTI_JS_PREFIX.length).equals(ANTI_JS_PREFIX)) {
    return body.slice(ANTI_JS_PREFIX.length);
  }
  return body;
}

function accountVerificationPath(pathname) {
  const p = "/" + String(pathname || "").replace(/^\/+|\/+$/g, "") + "/";
  return {
    challenge: p.includes("/challenge/") || p.includes("/auth_platform/"),
    checkpoint: p.includes("/checkpoint/"),
  };
}

function isPermanentError(err) {
  return (
    err === errors.tokenInvalidated ||
    err === errors.challengeRequired ||
    err === errors.checkpointRequired ||
    err === errors.consentRequired ||
    err === errors.accountSuspended ||
    err === errors.rateLimited
  );
}

function parseRetryAfter(headers) {
  if (!headers || !headers.get) return 0;
  const raw = headers.get("retry-after");
  if (!raw) return 0;
  const seconds = Number(raw);
  if (!Number.isNaN(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(raw);
  if (!Number.isNaN(date)) return Math.max(0, date - Date.now());
  return 0;
}

class HTTPClient {
  constructor({ cookies, userAgent, proxy } = {}) {
    this.cookies = cookies;
    this.userAgent = userAgent || USER_AGENT;
    this.proxy = proxy;
    this.timeout = 60000;
    this.dispatcher = null;
    this._hints = null;
    this._hintsUA = "";
    this.updateProxy(proxy);
  }

  setUserAgent(userAgent) {
    if (!userAgent || userAgent === this.userAgent) return;
    this.userAgent = userAgent;
    this._hints = null;
    this._hintsUA = "";
  }

  _clientHints() {
    if (this._hints && this._hintsUA === this.userAgent) return this._hints;
    this._hintsUA = this.userAgent;
    this._hints = buildClientHints(parseUserAgent(this.userAgent));
    return this._hints;
  }

  updateProxy(proxy) {
    this.proxy = proxy;
    this.dispatcher = null;
    if (!proxy) return;
    try {
      const { ProxyAgent } = require("undici");
      this.dispatcher = new ProxyAgent(proxy);
    } catch (_) {
      this.dispatcher = null;
    }
  }

  buildHeaders({ withCookies = true, isSecFetchDocument = false, extra } = {}) {
    const headers = {};
    if (isSecFetchDocument) {
      headers["accept"] =
        "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7";
    } else {
      headers["accept"] = "*/*";
    }
    headers["accept-language"] = "en-US,en;q=0.9";
    headers["dpr"] = DPR;
    headers["user-agent"] = this.userAgent;
    const hints = this._clientHints();
    headers["sec-ch-ua"] = hints["sec-ch-ua"];
    headers["sec-ch-ua-platform"] = hints["sec-ch-ua-platform"];
    headers["sec-ch-prefers-color-scheme"] = hints["sec-ch-prefers-color-scheme"];
    headers["sec-ch-ua-full-version-list"] = hints["sec-ch-ua-full-version-list"];
    headers["sec-ch-ua-mobile"] = hints["sec-ch-ua-mobile"];
    headers["sec-ch-ua-model"] = hints["sec-ch-ua-model"];
    headers["sec-ch-ua-platform-version"] = hints["sec-ch-ua-platform-version"];

    if (isSecFetchDocument) {
      headers["sec-fetch-dest"] = "document";
      headers["sec-fetch-mode"] = "navigate";
      headers["sec-fetch-site"] = "none";
      headers["sec-fetch-user"] = "?1";
      headers["upgrade-insecure-requests"] = "1";
    } else {
      headers["x-asbd-id"] = ASBD_ID;
      headers["sec-fetch-dest"] = "empty";
      headers["sec-fetch-mode"] = "cors";
      headers["sec-fetch-site"] = "same-origin";
    }

    if (withCookies && this.cookies) {
      const cookieStr = this.cookies.toString();
      if (cookieStr) headers["cookie"] = cookieStr;
      const [w] = this.cookies.getViewports();
      headers["viewport-width"] = w;
    }
    if (extra) Object.assign(headers, extra);
    return headers;
  }

  async fetchRaw(url, { method = "GET", headers = {}, body, redirect = "manual", signal } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeout);
    const onAbort = () => controller.abort();
    if (signal) signal.addEventListener("abort", onAbort, { once: true });
    try {
      const options = {
        method,
        headers,
        body,
        redirect,
        signal: controller.signal,
      };
      if (this.dispatcher) options.dispatcher = this.dispatcher;
      const res = await fetch(url, options);
      const arrayBuffer = await res.arrayBuffer();
      const resBody = Buffer.from(arrayBuffer);
      if (this.cookies) {
        const rotated = this.cookies.updateFromResponse(res.headers);
        if (rotated && rotated.length && this.onCookieRotation) this.onCookieRotation(rotated);
      }
      return { status: res.status, headers: res.headers, body: resBody };
    } finally {
      clearTimeout(timer);
      if (signal) signal.removeEventListener("abort", onAbort);
    }
  }

  async requestOnce(url, method, headers, body, { redirect = "manual" } = {}) {
    const { status, headers: resHeaders, body: resBody } = await this.fetchRaw(url, {
      method,
      headers,
      body,
      redirect,
    });

    const location = resHeaders.get("location");
    if (location) {
      const locationURL = new URL(location, url);
      const { challenge, checkpoint } = accountVerificationPath(locationURL.pathname);
      if (challenge) throw new RedirectedError(errors.challengeRequired, locationURL.toString());
      if (checkpoint) throw new RedirectedError(errors.checkpointRequired, locationURL.toString());
      if (locationURL.pathname === "/accounts/suspended/") {
        throw new RedirectedError(errors.accountSuspended, locationURL.toString());
      }
      if (locationURL.pathname === "/consent/" || locationURL.pathname.startsWith("/privacy/consent/")) {
        throw new RedirectedError(errors.consentRequired, locationURL.toString());
      }
    }

    const setCookies = resHeaders.getSetCookie ? resHeaders.getSetCookie() : [];
    for (const raw of setCookies) {
      const name = raw.split("=")[0].trim();
      if ((name === "xs" || name === "sessionid") && /max-age=0|expires=Thu, 01 Jan 1970/i.test(raw)) {
        throw errors.tokenInvalidated;
      }
    }

    if (status === 429) throw errors.rateLimited;
    return { status, headers: resHeaders, body: resBody };
  }

  async request(url, { method = "GET", headers, body, contentType, redirect = "manual", retries = MAX_RETRIES } = {}) {
    const finalHeaders = Object.assign({}, headers || {});
    if (contentType) finalHeaders["content-type"] = contentType;

    let attempts = 0;
    for (;;) {
      attempts++;
      try {
        const res = await this.requestOnce(url, method, finalHeaders, body, { redirect });
        if (res.status >= 400) {
          const err = new Error(`server returned unexpected HTTP status ${res.status}`);
          err.status = res.status;
          err.body = res.body;
          err.retryAfter = parseRetryAfter(res.headers);
          if (res.status === 429 && this.onRateLimit) this.onRateLimit(err.retryAfter);
          if (res.status < 500 && res.status !== 429) throw err;
          if (attempts > retries) throw err;
          await delay(err.retryAfter ? Math.min(err.retryAfter, 120000) : Math.min(attempts * 3000, 30000));
          continue;
        }
        return res;
      } catch (err) {
        if (isPermanentError(err)) throw err;
        if (attempts > retries) throw err;
        const backoff = attempts * 3000 * (err.status === 429 ? 2 : 1);
        await delay(backoff);
      }
    }
  }

  async getJSON(url, { headers, retries } = {}) {
    const res = await this.request(url, { method: "GET", headers: headers || this.buildHeaders({ withCookies: true }), retries });
    return { res, data: parseJSON(stripAntiJS(res.body)) };
  }
}

function parseJSON(buffer) {
  if (!buffer || buffer.length === 0) return null;
  try {
    return parseLossless(buffer.toString("utf8"));
  } catch (_) {
    return null;
  }
}

// GraphQL batch endpoints return several top-level objects concatenated:
//   for (;;);{"o0":{...}}\r\n{"o1":{...}}\r\n{"error_results":0,...}
// makeParsable-style split turns them into a JSON array.
function parseBatchJSON(buffer) {
  if (!buffer || buffer.length === 0) return null;
  const text = Buffer.isBuffer(buffer) ? buffer.toString("utf8") : String(buffer);
  const withoutForLoop = text.replace(/for\s*\(\s*;\s*;\s*\)\s*;/, "");
  const parts = withoutForLoop.split(/\}\r\n *\{/);
  const jsonText = parts.length === 1 ? parts[0] : "[" + parts.join("},{") + "]";
  try {
    return parseLossless(jsonText);
  } catch (_) {
    return null;
  }
}

module.exports = {
  HTTPClient,
  RedirectedError,
  errors,
  stripAntiJS,
  parseJSON,
  parseBatchJSON,
  isPermanentError,
  parseRetryAfter,
  accountVerificationPath,
  ANTI_JS_PREFIX,
};
