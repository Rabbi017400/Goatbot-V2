"use strict";

const { EventEmitter } = require("events");
const { reportAppStateTask } = require("./tasks");

function makeStopHandle(emitter, client) {
  return {
    stopListening(callback) {
      callback = callback || (() => {});
      emitter.emit("stop_listen");
      emitter.removeAllListeners();
      callback([]);
    },
    async stopListeningAsync() {
      return new Promise((resolve) => {
        emitter.stopListening(resolve);
      });
    },
  };
}

function listenMqtt(client, formatter, callback, options) {
  options = options || {};
  const emitter = new EventEmitter();
  let stopped = false;
  let permanentErrorSent = false;
  let globalCallback = (err, event) => {
    if (err) {
      if (emitter.listenerCount("error") > 0) emitter.emit("error", err);
      return;
    }
    emitter.emit("message", event);
  };
  if (typeof callback === "function") globalCallback = callback;

  // On every (re)connect the Lightspeed sync replays the recent history of the
  // databases as ordinary tables. Those rows are delivered through the same
  // path as live rows, so a command the bot already answered before the restart
  // is seen again and re-executed, and a replayed log:subscribe/log:unsubscribe
  // re-triggers welcome/goodbye handlers. Until the sync finishes ("ready") only
  // clearly old message and admin events are dropped, so a message the user
  // sends right after the restart still gets through. The timeout is a fallback
  // in case "ready" never arrives; clock skew keeps a live event from being
  // misjudged.
  const listenStartedAt = Date.now();
  const replayGraceMs = options.replayGraceMs === undefined ? 20000 : Number(options.replayGraceMs);
  const replayClockSkewMs = options.replayClockSkewMs === undefined ? 10000 : Number(options.replayClockSkewMs);
  let replayGateOpen = false;
  const openReplayGate = () => {
    if (replayGateOpen) return;
    replayGateOpen = true;
    clearTimeout(replayGateTimer);
  };
  const replayGateTimer = setTimeout(openReplayGate, replayGraceMs);
  if (replayGateTimer.unref) replayGateTimer.unref();

  const isReplay = (event) => {
    if (replayGateOpen) return false;
    if (!event) return false;
    const gated = event.type === "message" || event.type === "message_reply" || event.type === "event";
    if (!gated) return false;
    const ts = Number(event.timestamp);
    return Number.isFinite(ts) && ts > 0 && ts < listenStartedAt - replayClockSkewMs;
  };
  const deliver = (event) => {
    if (isReplay(event)) return;
    globalCallback(null, event);
  };

  const onTable = (table) => {
    if (stopped) return;
    const events = formatter.processTable(table);
    for (const event of events) {
      if (event.type === "message" || event.type === "message_reply" || event.type === "message_unsend") {
        if (client._trackMessageThread) client._trackMessageThread(event.messageID, event.threadID, event.timestamp);
        else client._messageThreadMap.set(String(event.messageID), event.threadID);
      }
      deliver(event);
    }
  };
  const onReady = () => {
    openReplayGate();
    if (stopped || !options.emitReady) return;
    globalCallback(null, { type: "ready", error: null });
  };
  const onPermanentError = (err) => {
    if (stopped || permanentErrorSent) return;
    permanentErrorSent = true;
    globalCallback({ error: err && err.message ? err.message : err, type: "error" });
  };

  client.on("ls-table", onTable);
  client.on("ready", onReady);
  client.on("permanent-error", onPermanentError);

  client.connect().catch((err) => {
    if (!stopped) onPermanentError(err);
  });

  // Mark the session as foreground so typing/presence flows (unless disabled).
  if (client.safety && client.safety.presence) {
    client.sendTasks([reportAppStateTask(1)]).catch(() => {});
  }

  // Keep fb_dtsg/jazoest fresh for long-running bot accounts. Facebook rejects
  // stale tokens with "Please try closing and re-opening your browser window".
  const refreshMs = options.refreshIntervalMs || 12 * 60 * 60 * 1000;
  let refreshTimer = null;
  if (typeof client.refreshTokens === "function") {
    refreshTimer = setInterval(() => {
      client.refreshTokens().catch(() => {});
    }, refreshMs);
    if (refreshTimer.unref) refreshTimer.unref();
  }

  const handle = makeStopHandle(emitter, client);
  const result = emitter;
  result.stopListening = (cb) => {
    stopped = true;
    if (refreshTimer) clearInterval(refreshTimer);
    client.removeListener("ls-table", onTable);
    client.removeListener("ready", onReady);
    client.removeListener("permanent-error", onPermanentError);
    const finish = () => handle.stopListening(cb || (() => {}));
    const reset = client.reset ? client.reset() : Promise.resolve(client.disconnect());
    reset.then(finish, finish);
  };
  result.stopListeningAsync = () =>
    new Promise((resolve) => {
      result.stopListening(resolve);
    });
  result.forceReconnect = () => client.forceReconnect();
  return result;
}

module.exports = { listenMqtt };
