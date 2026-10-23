// Browser fingerprint helpers for the local (non-hosted) Facebook requests the
// bot still makes itself: the cookie-liveness probe and the email/password
// login flow. The fca-meta npm package is a hosted client and does not ship
// these, so they live here to keep both flows presenting the same desktop
// Chrome fingerprint as the Lightspeed session.
"use strict";

const DPR = "1";
const BROWSER_NAME = "Chrome";
const CHROME_VERSION = "141";
const CHROME_VERSION_FULL = CHROME_VERSION + ".0.7390.122";
const USER_AGENT =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/" +
  CHROME_VERSION +
  ".0.0.0 Safari/537.36";
const SEC_CH_UA = `"Chromium";v="${CHROME_VERSION}", "Google Chrome";v="${CHROME_VERSION}", "Not-A.Brand";v="99"`;
const SEC_CH_UA_FULL_VERSION_LIST = `"Chromium";v="${CHROME_VERSION_FULL}", "Google Chrome";v="${CHROME_VERSION_FULL}", "Not-A.Brand";v="99.0.0.0"`;
const OS_NAME = "Linux";
const OS_VERSION = "";
const SEC_CH_PLATFORM = `"${OS_NAME}"`;
const SEC_CH_PLATFORM_VERSION = `"${OS_VERSION}"`;
const SEC_CH_MOBILE = "?0";
const SEC_CH_MODEL = `""`;
const SEC_CH_PREFERS_COLOR_SCHEME = "light";

const ASBD_ID = "359341";

const FB_APP_ID = "1443096165982425";

function chromeHintProfile(version, versionFull) {
  const platform = "Linux";
  return {
    browserName: BROWSER_NAME,
    chromeVersion: String(version),
    chromeVersionFull: String(versionFull),
    osName: platform,
    osVersion: "",
    platform,
    mobile: false,
    model: "",
    prefersColorScheme: SEC_CH_PREFERS_COLOR_SCHEME,
  };
}

function parseUserAgent(userAgent) {
  const ua = String(userAgent || "");
  const chrome = /Chrome\/(\d+)(?:\.\d+){0,3}/.exec(ua);
  const version = chrome ? chrome[1] : CHROME_VERSION;
  const fullMatch = /Chrome\/(\d+\.\d+\.\d+\.\d+)/.exec(ua);
  let versionFull;
  if (version === CHROME_VERSION) {
    versionFull = CHROME_VERSION_FULL;
  } else if (fullMatch && !/\.0\.0\.0$/.test(fullMatch[1])) {
    versionFull = fullMatch[1];
  } else {
    versionFull = version + ".0.0.0";
  }
  let platform = OS_NAME;
  if (/Windows/i.test(ua)) platform = "Windows";
  else if (/Macintosh|Mac OS X/i.test(ua)) platform = "macOS";
  else if (/Android/i.test(ua)) platform = "Android";
  else if (/iPhone|iPad|iPod/i.test(ua)) platform = "iOS";
  const mobile = /Mobile|Android|iPhone|iPad/i.test(ua);
  return {
    browserName: /Edg\//.test(ua) ? "Edge" : /Firefox\//.test(ua) ? "Firefox" : BROWSER_NAME,
    chromeVersion: version,
    chromeVersionFull: versionFull,
    osName: platform,
    osVersion: "",
    platform,
    mobile,
    model: "",
    prefersColorScheme: SEC_CH_PREFERS_COLOR_SCHEME,
  };
}

function buildClientHints(profile) {
  const p = profile || chromeHintProfile(CHROME_VERSION, CHROME_VERSION_FULL);
  const brand = p.browserName === "Edge" ? "Microsoft Edge" : p.browserName === "Firefox" ? "Firefox" : "Google Chrome";
  const chromium = `"Chromium";v="${p.chromeVersion}"`;
  const full = `"${brand}";v="${p.chromeVersion}"`;
  return {
    "sec-ch-ua": `${chromium}, ${full}, "Not-A.Brand";v="99"`,
    "sec-ch-ua-full-version-list": `"Chromium";v="${p.chromeVersionFull}", "${brand}";v="${p.chromeVersionFull}", "Not-A.Brand";v="99.0.0.0"`,
    "sec-ch-ua-platform": `"${p.platform}"`,
    "sec-ch-ua-platform-version": `"${p.osVersion || ""}"`,
    "sec-ch-ua-mobile": p.mobile ? "?1" : "?0",
    "sec-ch-ua-model": `"${p.model || ""}"`,
    "sec-ch-prefers-color-scheme": p.prefersColorScheme || SEC_CH_PREFERS_COLOR_SCHEME,
  };
}

// Full document-navigation header set for a given UA. Used by the cookie-liveness
// probe and the email/password login flow so their fingerprint matches the
// Lightspeed session instead of a different (hardcoded) browser.
function buildDocumentHeaders(userAgent) {
  const ua = userAgent || USER_AGENT;
  const hints = buildClientHints(parseUserAgent(ua));
  return {
    "user-agent": ua,
    accept:
      "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7",
    "accept-language": "en-US,en;q=0.9",
    "sec-ch-prefers-color-scheme": hints["sec-ch-prefers-color-scheme"],
    "sec-ch-ua": hints["sec-ch-ua"],
    "sec-ch-ua-full-version-list": hints["sec-ch-ua-full-version-list"],
    "sec-ch-ua-mobile": hints["sec-ch-ua-mobile"],
    "sec-ch-ua-model": hints["sec-ch-ua-model"],
    "sec-ch-ua-platform": hints["sec-ch-ua-platform"],
    "sec-ch-ua-platform-version": hints["sec-ch-ua-platform-version"],
    "sec-fetch-dest": "document",
    "sec-fetch-mode": "navigate",
    "sec-fetch-site": "none",
    "sec-fetch-user": "?1",
    "upgrade-insecure-requests": "1",
  };
}

module.exports = {
  DPR,
  BROWSER_NAME,
  CHROME_VERSION,
  CHROME_VERSION_FULL,
  USER_AGENT,
  SEC_CH_UA,
  SEC_CH_UA_FULL_VERSION_LIST,
  OS_NAME,
  OS_VERSION,
  SEC_CH_PLATFORM,
  SEC_CH_PLATFORM_VERSION,
  SEC_CH_MOBILE,
  SEC_CH_MODEL,
  SEC_CH_PREFERS_COLOR_SCHEME,
  ASBD_ID,
  FB_APP_ID,
  parseUserAgent,
  buildClientHints,
  buildDocumentHeaders,
  chromeHintProfile,
};
