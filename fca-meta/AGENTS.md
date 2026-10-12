# fca-meta

by @lazyneoaz (https://github.com/lazyneoaz)

A from-scratch, CommonJS Facebook Messenger chat API that is drop-in
compatible with the `fb-chat-api` interface consumed by Goat-Bot-V2.
It speaks the current Meta Lightspeed/DGW protocol instead of the legacy
MQTT endpoint, so it avoids the logout/suspend issues of older packages.

## Layout

- `index.js` — public `login` factory and `buildApi` (fb-chat-api surface).
- `src/client.js` — `Client`; bootstrap, connection loop, `sendTasks`.
- `src/http.js` — undici HTTP client with retries/proxy/DTSG refresh.
- `src/eventFormatter.js` — Lightspeed table -> fb-chat-api event objects.
- `src/listen.js` — `listenMqtt` wrapper and stop/reconnect handles.
- `src/tasks.js` — Lightspeed task factories and `TaskManager`.
- `src/api/threadGraphql.js` — bounded GraphQL `getThreadList`/`getThreadInfo`.
- `src/lightspeed/` — generated decoders (`decoders.js` is generated).
- `src/socket/` — DGW frame codec and websocket client.
- `src/api/` — per-domain API implementations.

## Thread info / list

`getThreadList` and `getThreadInfo` talk to the GraphQL batch endpoint
(`MessengerGraphQLThreadlistFetcher` / `MessengerGraphQLThreadFetcher`) in a
single request each. They intentionally do NOT enumerate every parent thread
key or recurse through the socket sync databases — that floods the account and
hangs bot startup. `getThreadInfo(id)` is fetched per-id on demand, matching what
Goat-Bot-V2 calls from `threadsData.create`/`refreshInfo`. Socket sync
recursion in `src/client.js` is capped by `MAX_SYNC_RECURSION`.

## Generators

`tools/gen-tables.js` reads Go structs into `tools/tables-spec.json`;
`tools/gen-decoders.js` turns that spec into `src/lightspeed/decoders.js`.
Regenerate both together; do not hand-edit generated output.

## Conventions

- No comments in source unless the code is genuinely non-obvious.
- Keep the event object field names identical to legacy `fb-chat-api`
  (`senderID`, `threadID`, `messageID`, `logMessageType`,
  `logMessageData`, `messageReply`, ...). Goat-Bot-V2 reads these.
- `processTable` snapshots thread state before `absorb` so admin add/remove
  events can be derived from the pre-update admin list.

## Live account testing

- The account cookie array lives in `.tmp-account.json` (gitignored).
  Load a real `Client` with `cookiesFromAppState(require("./.tmp-account.json"))`.
- `tools/live-test.js` is the end-to-end self-test: one login against
  `.tmp-account.json`, then identity, `getSessionID`, `getCookies`/`getAppState`,
  effects, `listenMqtt` (real DGW event stream), thread list/info/history,
  send/edit/react/poll/typing/markAsRead/getUserInfo, cleanup, and logout.
  Run `node tools/live-test.js`. It is safe/isolated: no
  comments, minimal sends, and it cleans up after itself.
- `sendMessage` before `listenMqtt` works: `Client.sendTasks` lazily starts
  the socket via `_ensureConnectStarted()`. Do not remove that call.
- Send-message ids come back through `LSReplaceOptimsiticMessage` in the
  publish response, not `LSUpsertMessage`.
- Two legacy endpoints are dead (return 404 / error 1357004):
  `ajax/messaging/attachments/sharedphotos.php` (`getThreadPictures`) and
  `mercury/attachments/photo` (`resolvePhotoUrl`). Both match current
  fb-chat-api behaviour; leave as-is.

## Testing

`npm test` runs `test/smoke.js` (no network). It covers the frame codec,
LS decoding, task payloads, event formatting, listen dispatch, and the
music search scoring/ranking logic.

## AI themes and music search

- `api.createAITheme(prompt)` -> `{ id, accessibilityLabel, backgroundImage, ... }`
  via the `useGenerateAIThemeMutation` GraphQL doc (doc_id `23873748445608673`).
- `api.setThreadTheme(threadID, themeID)` / alias `api.setTheme(...)` sends the
  `thread_theme` task (label `"43"`) with `{ thread_key, theme_fbid, source,
  sync_group, payload }`. A single label-43 task is enough; the multi-task
  payload some references use adds no effect.
- `api.changeTheme(prompt, threadID)` generates a theme from a prompt and applies
  it in one call.
- `api.searchMusic(query, options)` runs
  `useMWInboxTrayMusicNoteTypeaheadDataSourceQuery` (doc_id `24439058322365411`,
  product `FB_NOTES`) with `variables.params.search_text`. This is the
  Messenger "note music" typeahead, the same catalogue the music-sticker picker
  uses. The picker is fuzzy and returns unrelated tracks first, so results are
  re-ranked by a weighted query/title/artist/album token score (`src/api/music.js`)
  and filtered to real matches by default (`exact: false` returns everything,
  `limit` caps the count). Each result is
  `{ id, songId, title, artist, album, duration, image, url, isSaved, tags, score }`;
  the returned array also carries `cursor` / `hasMore`. Tag containers (e.g.
  "For you") are flattened from their `sub_items`.
- The search catalogue ids are **not** sticker ids: `id`/`display_id` is the
  picker/audio-asset id and the server rejects it on send, while `song_id` is
  the note/sticker id the server accepts. Always send the `songId`.
- `api.sendMusicSticker(track, threadID, callback)` sends a music sticker. The
  track may be a `searchMusic` result or `{ songId, title, artist, startTime }`;
  a bare string/number is treated as the `songId`. It sends the label-46 task
  with `send_type: 2` and
  `metadata_dataclass = {"xma_music_sticker_message_metadata":{"song_id",
  "start_time","song_title","song_subtitle","is_explicit"}}`; the server renders
  the XMA card itself (no text/attachment/URL). Returns
  `{ messageID, threadID, timestamp, songID }`.
- The GraphQL music search (`searchMusic`, themes, thread info) starts failing
  once the bootstrap `fb_dtsg`/`lsd` go stale, well before the socket drops.
  `searchMusicRequest` calls `client.musicTokensStale()` /
  `client.refreshMusicSession()`: a stale (or error-enveloped) request triggers
  one `refreshTokens()` (re-reads `fb_dtsg`/`jazoest`/`lsd` from
  `facebook.com/messages`, `/`, `m.facebook.com/`) and a single retry.
  `options.tokenTTLMs` (default 10 min) tunes the staleness window,
  `options.retryOnStale: false` disables the retry.

## Message retrieval (GraphQL)

`src/api/messageGraphql.js` handles single-message and history fetches over the
same `/api/graphqlbatch/` endpoint used by the thread queries:

- `api.getMessage(threadID, messageID)` (or `api.getMessage(messageID)` when the
  thread is already tracked in `client._messageThreadMap`) uses doc_id
  `1768656253222505` with `query_params.thread_and_message_id`.
- `api.getThreadHistory(threadID, amount, timestamp)` uses doc_id
  `1498317363570230` with `query_params.{id, message_limit, load_messages: 1,
  before}` and returns messages oldest-first.
- Responses are already normalized by GraphQL (`__typename` per node), so the
  formatter maps `UserMessage`, `ThreadNameMessage`, `ThreadImageMessage`,
  `ParticipantsAddedMessage`, `ParticipantLeftMessage`, `GenericAdminTextMessage`,
  and the call messages directly into the legacy `fb-chat-api` shape.

## Admin / system event classification

The Lightspeed table does not carry a usable rendering-type discriminator, so
`EventFormatter` classifies admin messages by shape and text:

- `RENDERING_TYPE` maps a rendering type to a `log:*` type when present.
- `_classifyAdminText(text)` is the primary classifier and is ordered so broad
  patterns cannot shadow specific ones (e.g. "named the group X" must resolve to
  `log:thread-name` before any image/emoji pattern).
- Pending admin ops (`queueAdminOp` / `_takeAdminOp`) supply exact values that
  text parsing cannot recover (theme id, image url, emoji). Matching searches the
  whole queue for the requested type and returns nothing when absent, so a stale
  op of another type never absorbs a later event.

Verified legacy shapes Goat-Bot-V2 consumes:

- `log:thread-name` -> `{ name }`
- `log:user-nickname` -> `{ nickname, participant_id, participant_name }`
- `log:thread-color` -> `{ theme_id, theme_color, theme_emoji }`
- `log:thread-icon` -> `{ thread_icon, thread_icon_url, thread_icon_id }`
- `log:thread-image` -> `{ url }`
- `log:thread-admins` -> `{ TARGET_ID, THREAD_CATEGORY, ADMIN_EVENT, participant_name }`
- `log:subscribe` -> `{ addedParticipants: [{ userFbId, fullName }] }`
- `log:unsubscribe` -> `{ leftParticipantFbId, participant_name }`

## Bump messages

`api.bumpMessage(messageID, [threadID])` re-surfaces an existing message at the
top of its thread by sending an **empty** message that is a "reply type 1" to the
target. The wire task (label 46) is:

- `thread_id`: target thread, `send_type: 1`, `source: 0`, `initiating_source: 1`
- no `text` field at all (a textless reply is valid with `reply_type: 1`)
- `reply_metadata = { reply_source_id: <messageID>, reply_source_type: 1, reply_type: 1 }`

`reply_type: 1` is what distinguishes a bump from a normal reply (`reply_type: 0`).
`sendMessageTask` accepts `replyType` and `powerUpStyle` for this. `api.bumpThread`
is the same but resolves the last message in a thread when no messageID is given.

The task result arrives as `LSReplaceOptimsiticMessage` (server "replace optimistic
message"), not `LSInsertMessage`; `src/api/bumpMessage.js` reads all four of
`LSUpsertMessage` / `LSInsertMessage` / `LSDeleteThenInsertMessage` /
`LSReplaceOptimsiticMessage` to extract the new id.

An earlier reply-resend variant (re-sending the original body) was wrong and has
been replaced.

## Editing messages (`api.editMessage`)

`api.editMessage(text, messageID, [callback])` — **no threadID required**. The
thread is not needed because the Lightspeed `EditMessageTask` (label `742`,
`queue_name: "edit_message"`) carries only `{ message_id, text }`:

```
payload = JSON.stringify({ message_id: "mid.$...", text: "new text" })
```

The server replies with an `LSEditMessage` step decoded to
`{ MessageID, AuthorityLevel, Text, EditCount }`. `editMessage` validates that
`MessageID` matches the target and that `Text` equals what was sent; on a
mismatch it throws `The message is too old or not from you!` rather than
silently succeeding. On success it returns `{ messageID, body, editCount }`.

An earlier stub sent the task and discarded the response, so a rejected/too-old
edit looked successful. That is fixed; edits are covered in `test/smoke.js`.

## Wire parity with mautrix-meta (no extra behaviour)

The library intentionally adds nothing on top of what the reference Go client
(`mautrix-meta`) does. There is **no** safety/throttling layer, no reconnect
jitter, no periodic token refresh and no keep-alive tasks: all of those were
removed because they are automation tells that the reference client does not
send. Payloads, sync, reconnect backoff and shutdown match mautrix-meta.

- The only human-like signal left is a typing indicator: `api.sendMessage`
  sends `sendTypingIndicator(threadID, true)` before a text send, waits a
  length-proportional (capped) delay, then sends `false`, then the message. It
  uses `sendStatelessTask`, so it never consumes or blocks the message queue and
  a typing failure never breaks the send. Set `options.typingIndicator: false`
  to skip it.
- Reconnect uses mautrix-meta's exact backoff: 1s doubling to a 5-minute cap,
  reset to immediate after a connection that lasted more than 2 minutes.
- Socket sync does a single pass over databases 1/2/95/104 (no retry loop);
  a failed sync surfaces as a connection error, matching mautrix.

## Full / periodic reconnect (`Client.fullReconnect`)

Long-lived sessions keep their bootstrap config (`fb_dtsg`, LSD token, version
id) and sync cursors forever, which mautrix-meta treats as a logout risk. It
therefore force-reconnects on a timer and this client mirrors that:

- `Client.connect()` arms `_schedulePeriodicReconnect()`, exactly where mautrix
  starts `go m.periodicReconnect()`. The timer fires `fullReconnect()` after
  `options.forceRefreshIntervalMs` (default 20h, `ForceRefreshIntervalSeconds`);
  set it to `0` to disable.
- `fullReconnect()` is mautrix `MetaClient.FullReconnect`: it clears
  `socketWasSynced`, tears the connection down (`reset()`), re-runs
  `loadMessagesPage()` for fresh tokens and reconnects. It is gated by
  `canReconnect()` / `options.minFullReconnectMs` (default 1h,
  `MinFullReconnectIntervalSeconds`) so overlapping refreshes cannot thrash.
- A permanent error (websocket close 4003, or any drop when
  `options.autoReconnect === false`) sets `permanentErrored`, which stops the
  force-refresh loop. `api.fullReconnect()` / `api.canReconnect()` expose it.
- `disconnect()` and `reset()` clear the timer so a stopped client never
  reconnects itself. The timer is `unref()`d, so it never keeps the process
  alive on its own.

## Session persistence (removed)

fca-meta does **not** back up or reuse cookies from disk. Each login uses exactly
the appState it was given (`account.txt`), so a redeploy always starts from the
current committed session. There is no `sessionStore`, no `options.store`, and no
`api.persistSession()` / `api.getDeviceID()`.

- Cookie-rotation handling is removed entirely: `Cookies.updateFromResponse`,
  `Client._onCookieRotation` and `src/sessionStore.js` are gone, along with
  `options.store`. `Set-Cookie` responses are ignored; the in-memory jar keeps
  the appState values.
- The bootstrap `MqttWebDeviceID.clientID` is used as-is (a fresh one only when
  absent); there is no persisted device id to override it.
- `api.logout()` just disconnects now that there is nothing to clear.

Use a stable residential/mobile proxy per account — a datacenter IP alone can
still get a fresh session flagged.

## Effects (text power-ups and avatar effects)

`power_up_style` on the label-46 send task selects a Messenger effect. Confirmed
independently against `YMGPwcca/Messenger.TS` (`Effect` enum):

```
LOVE=1, GIFT_BOX=2, CONFETTI=3, FIRE=4,
AVATAR_LOVE=1000, AVATAR_ANGRY=1001, AVATAR_LAUGH=1002, AVATAR_CRY=1003
```

- `api.sendEffect(name, message, threadID)` sends text with `power_up_style` set.
- `api.sendAvatarEffect(name, message, threadID)` uploads a bundled GIF
  (`assets/avatar/*.gif`) then sends it as media (`send_type: 3`) with the matching
  avatar `power_up_style` (1000-1003).
- `api.listEffects`, `api.listAvatarEffects`, `api.isAvatarSupported` expose metadata.
- `src/api/effects/core.js` holds the effect table + avatar table and asset paths;
  `src/api/effects/sender.js` builds the payload by delegating to the shared
  `sendMessageTask` (so an effect send is byte-identical to a normal send apart
  from `power_up_style`) and extracts the new message id.

The avatar GIFs live in `assets/avatar/` (`avatar_love.gif`, `avatar_anger.gif`,
`avatar_laugh.gif`, `avatar_cry.gif`). Facebook requires a fresh upload id each
time an avatar GIF is sent, so the file is re-uploaded on every call rather than
reusing a cached id. `ASSETS_DIR` resolves as `src/api/effects/../../..`+/assets.

Legacy HTTP helpers `getUserID`, `getFriendsList`, `getThreadPictures` and
`api.httpGet` target endpoints (`/ajax/typeahead/search.php`,
`/chat/user_info_all`, `/ajax/messaging/attachments/sharedphotos.php`) that now
return empty bodies or 404 server-side; the Lightspeed equivalents
(`searchUserTask`, `getContactsTask`) also return no rows. They are not fixable
without a new server API.




## Goat-Bot-V2 drop-in verification (fca-meta)

`fca-meta` is vendored into `/workspace/goat-bot-v2/fca-meta` by deleting the
`fb-chat-api/` directory and adding `fca-meta/`. `bot/login/login.js` does
`require(global.config.facebookAccount?.fcaApiPath || "fca-meta")`, so the legacy
`modify` command still overrides the API path under the same `fcaApiPath` key.

- Legacy api surface parity: all 52 `apiFuncNames` from `fb-chat-api/index.js`
  are exposed by `index.js`. `getThreadInfo` returns `null` (not a throw) when
  there is no `message_thread`, matching legacy; callers must null-check.
- `listenMqtt` returns the legacy `msgEmitter` shape (`stopListening(cb)` /
  `stopListeningAsync()`); the default no-op `api.stopListening` is replaced by
  the handle on first `listenMqtt` call, matching legacy.
- `uploadAttachment` accepts `fs.ReadStream` and `Buffer`. Rapid repeated
  uploads trigger empty 200 responses for a short cooldown; that is server-side,
  not an encoder bug.
- `msg.location` is accepted in ALLOWED_PROPERTIES but is NOT transmitted:
  every Lightspeed `location_data` payload variant tried is rejected
  server-side with `LSUpdateSubscriptErrorMessage: "Couldn't send."` while
  plain text succeeds. Do not add an unverified `location_data` path.
- `api.sendMessage(msg, threadID, callback, replyToMessage, isGroup)` arg order
  matches legacy exactly; `replyToMessage` maps to `ReplySourceId` and the bot
  gets `type: "message_reply"` with `event.messageReply`.
- `api.sendMessage` emits a typing indicator before a text send via
  `sendStatelessTask`; it never consumes or blocks the message queue.
- Never write live cookies into the tracked (committed empty) `account.txt`;
  test appstate lives in gitignored `tools/.tmp-account.json`.

## Goat-Bot-V2 `customFeatures` (handler-level, no fca changes)

- Config lives in `config.json -> customFeatures`:
  - `unsendOnReaction`: `{ enable, reactions: ["😠","😡"] }` — when a bot
    admin (role 2) reacts with one of `reactions` on a bot-sent message, the
    bot unsends it. Emojis are normalized (strips U+FE0F).
  - `noPrefix`: `{ enable }` — when on, role-2 admins may run a command with
    no prefix, but ONLY when the first word exactly matches a command
    name/alias. Normal chat never triggers a command.
- Toggles: `scripts/cmds/noprefix.js` (`np`) and
  `scripts/cmds/unsendonreaction.js` (`uor`), both `role: 2`.
- `bot/custom.js` wraps `api.sendMessage` to add sent messageIDs to
  `global.GoatBot.botSentMessages` (Set, capped 3000) — the source of truth
  for "is this a bot message".
- Handler hooks in `bot/handler/handlerEvents.js`: `onStart` has the
  noPrefix branch; `handleCustomReaction()` runs at the top of `onReaction`
  (gated by `unsendOnReaction.enable`), with a 4s duplicate-reaction guard.
- If a feature adds config the bot writes at runtime (like these), make sure
  the config template is updated too, otherwise first write drops the keys.

## Goat-Bot-V2 owner/info commands (ported from imneoazbro/bot-)

`scripts/cmds/`: `wl.js` (whitelist, aliases wl/whitelistmode), `sl.js`
(selflisten, sl/selflistenmode), `pending.js`, `shell.js` (sh/exec/run),
`uptime.js` (up/runtime/sysinfo). All `role: 2` except `uptime` (`role: 0`).

- `wl` and `sl` write to `config.json` (`whiteListMode`, `whiteListModeThread`,
  `optionsFca.selfListen`) and the enforcement lives in `bot/login/login.js`.
  `Goat.js` stringifies `whiteListMode.whiteListIds`, so string uids from
  commands still match `event.senderID`.
- `sl` applies selfListen live: after persisting `optionsFca.selfListen` it calls
  `global.GoatBot.fcaApi.setOptions({ selfListen })`, which re-applies the flag
  to the running `EventFormatter` (`index.js` `buildApi` -> `formatter.selfListen`).
  No restart is needed. `wl` still needs a restart because `whiteListMode` is
  read in `bot/login/login.js` at load time.
- `pending` relies on `api.getThreadList(..., ["PENDING"])`,
  `api.handleMessageRequest`, `api.removeUserFromGroup`, `api.changeNickname`,
  and registers `GoatBot.onReply`.
- `shell` uses `api.editMessage` when available, else replies; output capped
  at 3500 chars.
- `uptime` sends its report with `api.sendAvatarEffect(name, { body,
  replyToMessageID }, threadID)` using a random name from
  `["love","anger","laugh","cry"]`; `global.GoatBot.startTime` supplies uptime.
  The vendored `fca-meta/assets/avatar/*.gif` are required for this to work —
  keep them in sync with the source repo.

## Goat-Bot-V2 commands: `sing`, `effect` and `music`

- `sing` and `effect` live in `/workspace/goat-bot-v2/scripts/cmds/` (author
  `Neoaz 🐊`, `en` only). `sing` sends an actual audio file (`-c <count>` shows a
  picker) and no longer owns the `music` alias.
- `music` (`scripts/cmds/music.js`) sends a Messenger **music sticker**: it runs
  `api.searchMusic`, keeps tracks that have a `songId`, and calls
  `api.sendMusicSticker(track, threadID)`. `-c <count>` shows the same picker /
  `onReply` choose flow as `sing`. Only tracks with a `songId` are listed, since
  the catalogue `id` is rejected by the sticker endpoint.
- They must not post progress/processing text. React to the invoking message
  (`message.reaction(emoji, event.messageID)`) with `⏳` / `✅` / `❌` instead.
- `sing` uses `api.searchMusic(query, { limit, exact: false })`; only tracks with
  a non-null `url` are playable and are filtered before listing/sending.
- `effect` sends via `api.sendEffect(alias, body, threadID)` and
  `api.sendAvatarEffect(name, body, threadID)`; avatar effects use `avatar_`.
  There is intentionally NO `-c` count option: each invocation sends once
  (repeated sends are a spam signal).
- `shortcut` and `translate` are admin-gated (`role: 2`).

## Anti-suspension invariants (Goat-Bot-V2 side)

- `bot/login/checkLiveCookie.js` must never use the deprecated `mbasic`
  subdomain; it probes `https://www.facebook.com/` and treats missing essential
  cookies (`c_user` + `xs`) as the only hard "invalid" signal, so a transient
  anti-bot redirect cannot trigger a spurious re-login/logout.
- The listen-error re-login poll in `bot/login/login.js` is bounded to 5 minutes
  (`reloginDeadline`); it must not poll `checkLiveCookie` forever every 5s.
- `fca-meta/tools/live-test.js` only calls `api.logout()` when
  `FCA_LIVE_LOGOUT=1`. Never auto-logout on a normal test run.
- Do not add any code path that calls `api.logout()` automatically; the only
  logout in the bot is the dashboard session (`dashboard/app.js`, unrelated).

## Goat-Bot-V2 runtime requirements (Node 20+, prebuilt canvas)

- `package.json` engines are `node >=20`. Node 16 is EOL and cannot load
  `cheerio@1.2.0`'s nested `undici@7`, which references the `ReadableStream`
  global (`ReferenceError: ReadableStream is not defined`). Render reads the
  engine range and installs a current runtime.
- Canvas is the prebuilt, maintained `@napi-rs/canvas` (no node-gyp/native
  build). It is installed under the `canvas` name via the npm alias
  `"canvas": "npm:@napi-rs/canvas@^0.1.80"`, so commands keep
  `require("canvas")` unchanged. There is no `func/canvasCompat.js` shim.
- `@napi-rs/canvas` has no `registerFont(path, { family })`; register fonts
  with `Canvas.GlobalFonts.registerFromPath(path, family)` (`moon`, `weather`,
  `rank`).
- `scripts/cmds/*` that only need `createCanvas` / `loadImage` are unchanged:
  those names exist on `@napi-rs/canvas`.
- `sqlite3@5.1.7` ships napi-v6 prebuilds that load on Node 20+; no rebuild.
- npm scripts no longer use the Windows-only `set NODE_ENV=…`; `dev`/`prod`
  use `cross-env`.
- `account.txt` (upstream) is a tracked credentials file. Do not add it to a
  new remote or print its contents; treat it as secret-bearing.

## Port binding (Render / PaaS)

- Render runs the bot as a web service and requires the process to bind a port.
  `bot/healthServer.js` starts a tiny HTTP server on `$PORT` (returns `200 OK`)
  whenever `PORT` is set and no other server will bind. It is skipped when
  `dashBoard.enable` or `serverUptime.enable` is true, and on Replit/Glitch
  (which supply their own web server). Locally `PORT` is unset, so nothing
  changes.
- `dashboard/app.js`, `bot/login/login.js`, and `bot/autoUptime.js` resolve
  their port as `process.env.PORT || <configured port> || 3001`. The PaaS
  `$PORT` must win over the default `3001` from `config.json`, otherwise the
  service fails to detect the open port.

## Reply / event bug fixes (message.reply, duplicate events)

- `api.sendMessage(msg, threadID, callback, replyToMessage, isGroup)`: the 3rd argument is treated as `replyToMessage` only when it is a string (the legacy `(msg, threadID, replyToMessage)` overload). `message.reply` calls `api.sendMessage(form, threadID, callback, event.messageID)`; when a command omits the callback (the common case) the 3rd arg is `undefined`, so the reply target lives in the 4th argument and must not be overwritten. `msg.replyToMessage` is also accepted for callers that pass the target inside the message object.
- `api.setMessageReaction(reaction, messageID, threadID, callback, forceCustomReaction)`: `threadID` is optional. Legacy/dongdev bots call `setMessageReaction(reaction, messageID)` and the handler looks the thread up from `_messageThreadMap`; Lightspeed does not need `thread_key` (mautrix tags it `omitempty`). When the thread is unknown the field is omitted rather than sent as `0`. Any Unicode emoji is accepted (`src/api/messageActions.js` `isEmojiReaction` uses `\p{Extended_Pictographic}` + `\p{Emoji_Component}`), the reaction is sent as `reaction_style: null` (the plain Messenger reaction), and an empty string removes the reaction. There is no force-custom path. The `forceCustomReaction` argument is still parsed for call-signature compatibility but ignored, so bots that pass it (e.g. Goat-Bot-V2 `utils.js` `setMessageReaction(emoji, id, cb, true)`) keep working.
- `EventFormatter.processTable` deduplicates messages and reactions by id (`_isDuplicateMessage` / `_isDuplicateReaction`). Lightspeed sync databases and the socket can redeliver the same row, which made Goat-Bot-V2 fire `log:subscribe` (welcome) multiple times and run commands repeatedly. The message window is 60s; reactions 3s. Reaction dedupe keys normalize away U+FE0F so a V1 `❤` and a V2 `❤️` for the same actor/message collapse into one `message_reaction`; V2 rows are only emitted when `ViewerIsReactor` is set (the sync row for the peer's own reaction carries no reactor id).
- `DEFAULT_SAFETY` typing/pacing was lowered (`typingMsPerChar` 20, `typingMaxMs` 1500, `minActionDelayMs` 250, `maxActionDelayMs` 800) so a normal text reply is not delayed by up to 5s of simulated typing.
- `Client.sendStatelessTask` serializes with `stringifyBigInt`, not `JSON.stringify`. Typing/presence tasks carry `thread_key`; for int64 thread ids beyond `Number.MAX_SAFE_INTEGER` the value is a `BigInt` and raw `JSON.stringify` throws `Do not know how to serialize a BigInt`. `simulateTyping` swallows errors, so the symptom was a missing typing indicator on exactly the large-ID threads the bot had just started working in. `sendTasks` was already safe via `TaskManager.finalizePayload` (`stringifyBigInt`).
- `event.messageReply.attachments` is populated, not hardcoded `[]`. It prefers the cached attachments of `ReplySourceId` (full `PlayableUrl`/`PreviewUrl` from `LSInsertAttachment`), else synthesizes one attachment from the inline reply media fields (`ReplyAttachmentType`, `ReplyAttachmentId`, `ReplyMediaUrl`, `ReplyMediaUrlMimeType`, `ReplyMediaPreviewWidth/Height`), and returns `[]` for a text-only reply. `_attachmentType` is reused so a reply sticker maps to `sticker` with `stickerID`.

## Replayed history on (re)connect (bot re-runs an old command after restart)

On every socket (re)connect the Lightspeed sync re-sends the recent history of
databases 1/2/95/104 as ordinary tables. fca-meta delivers those rows through
the same path as live rows, so a message the bot already answered before the
restart is seen again and its command re-executes (e.g. the bot re-sends a song
after a restart). It is not a send/duplicate bug: the same `MessageId` is
delivered as a *new* event.

`listenMqtt` gates this in `src/listen.js`: until the sync completes (`ready`)
it drops `message`/`message_reply` **and `event`** (admin/log) rows whose
`timestamp` is more than `replayClockSkewMs` (default 10s) older than the moment
listening started. Gating `event` matters too: a replayed `log:subscribe` /
`log:unsubscribe` otherwise re-triggers the bot's welcome/goodbye handlers. A
`replayGraceMs` timeout (default 20s) opens the gate if `ready` never arrives.
The skew window lets a message the user sends during the sync still get through,
and the gate does not apply to reactions/presence/typing. `api.listenMqtt`
forwards `options.replayGraceMs` / `options.replayClockSkewMs`. This also covers
the in-process hourly `restartListenMqtt`, which calls `stopListening` +
`listenMqtt` and previously replayed the last ~hour of messages on each cycle.


## Message-request accept (pending command)

`api.handleMessageRequest(threadID, true)` must send the `AcceptMessageRequestTask`
(label `"66"`) with `sync_group: 95`. Message-request threads live in the contact
sync database 95 (see mautrix `connector/handlematrix.go`
`HandleMatrixAcceptMessageRequest` and `messagix/configs.go`, which syncs
`{1, 2, 95}`). Using `sync_group: 1` makes Facebook return success without
ever moving the thread out of the request folder.

Declining (`accept === false`) cannot use the LS task: it moves the thread back
to the "other"/filtered folder through the Mercury endpoint
`/ajax/mercury/move_thread.php` with `other[i]=threadID` (legacy fb-chat-api and
dongdev `moveThreadsViaMercury`). `acceptMessageRequestTask` is only sent when
`accept` is truthy.
