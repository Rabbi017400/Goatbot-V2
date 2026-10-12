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

- Device id is persisted and reused across logins, so the account is not seen as
  a new device every restart.
- Server-rotated cookies are persisted and replayed correctly, while a freshly
  re-exported `appState` always wins.
- `sec-ch-ua` client hints are derived from the active user agent, so the
  fingerprint never disagrees with itself.
- Wire behaviour matches the reference client (mautrix-meta) with nothing added
  on top: no throttling layer, no reconnect jitter and no keep-alive tasks. The
  only human-like signal is a typing indicator sent before a text message.
- The connection is force-refreshed on a timer like mautrix-meta's
  `periodicReconnect`: every 20h (configurable with `forceRefreshIntervalMs`,
  `0` to disable) the client re-runs the bootstrap and reconnects, so the
  session tokens and sync cursors never go stale on a long-running bot.

Session state lives in `~/.fca-meta/<key>.json` and can be overridden with
`options.store` (`{ dir, key, file }`, or `false` to disable).

## Tests

```bash
npm test        # offline unit + integration tests
npm run test:live   # one live login against .tmp-account.json
```

## License

MIT
