# fca-meta

by [@lazyneoaz](https://github.com/lazyneoaz)

A from-scratch, CommonJS Facebook Messenger chat API that is drop-in compatible
with the `fb-chat-api` interface consumed by [Goat-Bot-V2](https://github.com/imneoazbro/Goat-Bot-V2).
It speaks the current Meta Lightspeed/DGW protocol instead of the legacy MQTT
endpoint, so it avoids the logout/suspend issues of older packages.

## Install

```bash
npm install fca-meta
```

Requires Node.js 18 or newer.

## Usage

```js
const login = require("fca-meta");

login({ appState: require("./appstate.json") }, (err, api) => {
  if (err) return console.error(err);

  api.listenMqtt((err, event) => {
    if (err) return console.error(err);
    if (event.type === "message") {
      api.sendMessage("pong", event.threadID);
    }
  });
});
```

`appState` is the exported cookie array (same format `fb-chat-api` expects).

## Reliability

- `account.txt` is the single source of truth: fca-meta never backs up or reuses
  cookies from disk, so every redeploy logs in with exactly the committed session.
- **Cookie rotation** is applied the way mautrix-meta does
  (`Cookies.UpdateFromResponse`): every `Set-Cookie` on every HTTP response is
  written to the live in-memory jar, and a cookie the server expires
  (`Max-Age<=0` or a past `Expires`) is deleted. Meta rotates short-lived cookies
  (`fr`, `sb`) mid-session; a client that keeps sending the stale values is one of
  the signals that gets an account logged out after ~10-12h. `api.getAppState()`
  exposes the rotated values, so a bot that re-persists the appState keeps the
  fresh cookies across restarts.
- `sec-ch-ua` client hints are derived from the active user agent, so the
  fingerprint never disagrees with itself.
- Wire behaviour matches the reference client (mautrix-meta) with nothing added
  on top: no throttling layer, no reconnect jitter and no keep-alive tasks. No
  typing indicator is sent before a text message either; opt in with
  `options.typingIndicator: true` only if a caller really wants the (extra,
  unsolicited) composing signal.
- **Stale bootstrap recovery (the "text works but uploads don't" case).** The
  socket stays up on Lightspeed while the cached `fb_dtsg`/`lsd` tokens go stale,
  so text sends keep working but HTTP calls (uploads, GraphQL, Mercury) are
  rejected with error `1357001` (token invalidated) or `1357004` (please reload
  page). Those codes trigger one shared, awaitable recovery that re-reads the
  bootstrap page (`fullReconnect()`, or `refreshTokens()` when a reconnect is not
  allowed yet) and then retries the request once — including the media-upload
  path, which rebuilds its query so the retry carries the fresh tokens.
- The connection is force-refreshed on a timer like mautrix-meta's
  `periodicReconnect`: every 20h (configurable with `forceRefreshIntervalMs`,
  `0` to disable) the client re-runs the bootstrap and reconnects, so the
  session tokens and sync cursors never go stale on a long-running bot.
- A DGW **deauth** frame (the server revoking the session) is surfaced as an
  unauthorized close, so the client stops reconnecting and reports a clean
  "not logged in" instead of hammering a dead session.

Session state is never written to disk by the library; cookies live in memory for
the life of the process and are only exposed through `api.getAppState()`.

## Tests

```bash
npm test        # offline unit + integration tests
npm run test:live   # one live login against .tmp-account.json
```

## License

MIT
