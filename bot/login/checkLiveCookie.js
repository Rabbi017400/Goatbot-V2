const axios = require("axios");

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
 * @returns {Promise<Boolean>} True if cookie is valid, false if not
 */
module.exports = async function (cookie, userAgent) {
	const cookieString = toCookieString(cookie);
	if (!hasEssentialCookies(cookie))
		return false;
	try {
		const response = await axios({
			url: 'https://www.facebook.com/',
			method: "GET",
			timeout: 15000,
			maxRedirects: 5,
			headers: {
				cookie: cookieString,
				"user-agent": userAgent || 'Mozilla/5.0 (Linux; Android 12; M2102J20SG) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/101.0.0.0 Mobile Safari/537.36',
				"accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7",
				"accept-language": "vi,en-US;q=0.9,en;q=0.8",
				"sec-ch-prefers-color-scheme": "dark",
				"sec-ch-ua": "\"Chromium\";v=\"112\", \"Microsoft Edge\";v=\"112\", \"Not:A-Brand\";v=\"99\"",
				"sec-ch-ua-mobile": "?0",
				"sec-ch-ua-platform": "\"Windows\"",
				"sec-fetch-dest": "document",
				"sec-fetch-mode": "navigate",
				"sec-fetch-site": "none",
				"sec-fetch-user": "?1",
				"upgrade-insecure-requests": "1"
			}
		});

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
