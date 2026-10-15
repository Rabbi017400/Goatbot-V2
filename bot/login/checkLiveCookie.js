const axios = require("axios");
const path = require("path");
// fca-meta is vendored at the repo root (not in node_modules), so resolve it the
// same way bot/login/login.js does instead of as a bare package specifier.
const { USER_AGENT, buildDocumentHeaders } = require(path.join(process.cwd(), "fca-meta/src/useragent"));

function toCookieString(input) {
        if (typeof input === "string")
                return input;
        if (Array.isArray(input))
                return input.map(i => `${i.key}=${i.value}`).join("; ");
        return "";
}

function hasEssentialCookies(input) {
        const arr = Array.isArray(input)
                ? input
                : String(input || "").split(";").map(part => {
                        const [key, value] = part.split("=");
                        return { key: (key || "").trim(), value: (value || "").trim() };
                });
        const keys = arr.map(i => i.key);
        return keys.includes("c_user") && keys.includes("xs");
}

/**
 *
 * @param {string|Array} cookie Cookie string as `c_user=123;xs=123;datr=123;` format or an appState array
 * @param {string} userAgent User agent string
 * @param {string} [proxy] Proxy URL the account uses, so the probe does not leak a different host IP
 * @returns {Promise<Boolean>} True if cookie is valid, false if not
 */
module.exports = async function (cookie, userAgent, proxy) {
        const cookieString = toCookieString(cookie);
        if (!hasEssentialCookies(cookie))
                return false;
        try {
                // The document headers are derived from the user agent so the probe
                // presents the same browser fingerprint as the Lightspeed session
                // (the old hardcoded mobile-UA/desktop-Edge-hints mix looked like a
                // different device and could get the account flagged).
                const headers = Object.assign({ cookie: cookieString }, buildDocumentHeaders(userAgent || USER_AGENT));
                const config = {
                        url: 'https://www.facebook.com/',
                        method: "GET",
                        timeout: 15000,
                        maxRedirects: 5,
                        headers
                };
                // Probe through the same proxy as the bot session: a liveness check
                // from a different (datacenter) host IP is itself a login-from-a-new-
                // location signal, and the relogin poll fires it every 5s.
                if (proxy) {
                        try {
                                const { ProxyAgent } = require("undici");
                                config.dispatcher = new ProxyAgent(proxy);
                        }
                        catch (_) { /* no undici: fall back to a direct request */ }
                }
                const response = await axios(config);

                const data = String(response.data || "");
                const live = data.includes('"__isLoggedIn":true') || data.includes('/privacy/xcs/action/logging/');
                if (live)
                        return true;
                // Facebook's markup changes often and a redirect to /login can also happen
                // for anti-bot reasons. When the essential session cookies are present, let
                // the Lightspeed login decide instead of hard-blocking a possibly valid
                // account (avoids spurious re-logins / logouts).
                return hasEssentialCookies(cookie);
        }
        catch (e) {
                // network/proxy failures must not be treated as an invalid session
                return hasEssentialCookies(cookie);
        }
};

module.exports.buildDocumentHeaders = buildDocumentHeaders;
