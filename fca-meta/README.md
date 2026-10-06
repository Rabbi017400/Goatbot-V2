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
- A default-on safety layer paces outgoing actions, jitters reconnects and
  opens a circuit breaker on rate limits (`429`) instead of retry-storming.

Session state lives in `~/.fca-meta/<key>.json` and can be overridden with
`options.store` (`{ dir, key, file }`, or `false` to disable).

## Tests

```bash
npm test        # offline unit + integration tests
npm run test:live   # one live login against .tmp-account.json
```

## License

MIT
