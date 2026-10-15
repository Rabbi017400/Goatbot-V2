"use strict";

const { EventEmitter } = require("events");
const { HTTPClient, RedirectedError, parseJSON, stripAntiJS, errors, accountVerificationPath } = require("./http");
const { parseLossless } = require("./bigjson");
const { Cookies, cookiesFromAppState, appStateFromCookies } = require("./cookies");
const { parseBootstrap, findVersionInJS } = require("./moduleParser");
const { DgwSocket } = require("./socket/client");
const { decodeLSData } = require("./lightspeed");
const { TaskManager } = require("./tasks");
const { FacebookEndpoints, MessengerEndpoints } = require("./endpoints");
const { USER_AGENT, ASBD_ID } = require("./useragent");
const { generateSessionID, stringifyBigInt } = require("./utils");
const { getDoc } = require("./graphql");

const BASE_SYNC_DATABASES = [1, 2, 95, 104];
const RECURSE_DATABASES = new Set([1, 2, 95, 104]);
const SYNC_RESPONSE_TIMEOUT = 30000;
const MAX_SYNC_RECURSION = 50;
const MAX_CONNECT_BACKOFF = 5 * 60 * 1000;
// mautrix-meta defaults: force a full reconnect every 20h, but never sooner
// than 1h apart (pkg/connector/example-config.yaml).
const DEFAULT_FORCE_REFRESH_MS = 72000 * 1000;
const DEFAULT_MIN_FULL_RECONNECT_MS = 3600 * 1000;

function formatFloat(value) {
  if (value === undefined || value === null || value === "") return "1";
  const n = Number(value);
  if (!Number.isFinite(n)) return "1";
  return String(n);
}

class Client extends EventEmitter {
  constructor(options = {}) {
    super();
    this.options = options;
    this.endpoints = options.host === "messenger.com" ? MessengerEndpoints : FacebookEndpoints;
    this.userAgent = options.userAgent || USER_AGENT;
    this.cookies = options.cookies instanceof Cookies ? options.cookies : cookiesFromAppState(options.appState || []);
    this.iUserID = this.cookies.get("i_user") || "";
    this.http = new HTTPClient({ cookies: this.cookies, userAgent: this.userAgent, proxy: options.proxy });
    this.configs = null;
    this.lsTable = null;
    this.socket = null;
    this.connected = false;
    this.packetsSent = 0;
    this.lsRequests = 0;
    this.graphQLRequests = 1;
    this.nextTaskID = 0;
    this.taskID = 0;
    this.syncStore = this._defaultSyncStore();
    this.keyStore = this._defaultKeyStore();
    this.syncWaiters = new Map();
    this.syncManager = null;
    this.socketWasSynced = false;
    this.canSendMessages = false;
    this._loggedIn = false;
    this._connectPromise = null;
    this._messageThreadMap = new Map();
    this._messageThreadTimestamps = new Map();
    this._stopping = false;
    this._socketWasConnected = false;
    this._connectResolve = null;
    this._connectReject = null;
    this._canSendMessagesWaiters = [];
    this._firstConnectSettled = false;
    this._lastFullReconnect = 0;
    this._periodicReconnectTimer = null;
    this._staleReconnectPending = false;
    this.permanentErrored = false;
  }

  _ensureConnectStarted() {
    if (!this._connectPromise && !this._stopping && this._loggedIn) {
      this.connect().catch(() => {});
    }
  }

  waitUntilCanSendMessages(timeout) {
    if (this.canSendMessages) return Promise.resolve();
    const ms = timeout === undefined ? 15000 : timeout;
    return new Promise((resolve, reject) => {
      const waiter = { resolve, reject, timer: null };
      waiter.timer = setTimeout(() => {
        const idx = this._canSendMessagesWaiters.indexOf(waiter);
        if (idx !== -1) this._canSendMessagesWaiters.splice(idx, 1);
        reject(new Error("timeout waiting for canSendMessages"));
      }, ms);
      if (waiter.timer.unref) waiter.timer.unref();
      this._canSendMessagesWaiters.push(waiter);
    });
  }

  _setCanSendMessages(value) {
    this.canSendMessages = value;
    if (value) {
      const waiters = this._canSendMessagesWaiters;
      this._canSendMessagesWaiters = [];
      for (const waiter of waiters) {
        clearTimeout(waiter.timer);
        waiter.resolve();
      }
    }
  }

  _clearCanSendMessagesWaiters() {
    const waiters = this._canSendMessagesWaiters;
    this._canSendMessagesWaiters = [];
    for (const waiter of waiters) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error("connection closed before messages could be sent"));
    }
  }

  _defaultSyncStore() {
    const store = {};
    for (const id of [1, 2, 5, 6, 7, 16, 26, 28, 89, 95, 104, 120, 140, 141, 142, 143, 145, 196, 197, 198, 202]) {
      store[id] = { databaseID: id, sendSyncParams: false, lastAppliedCursor: null, currentSeqID: 0, syncChannel: 0 };
    }
    store[1].syncChannel = 1;
    store[2].sendSyncParams = true;
    store[2].syncChannel = 2;
    store[95].syncChannel = 2;
    for (const id of [5, 6, 7, 16, 26, 28, 89, 104, 120, 140, 141, 142, 143, 145, 196, 197, 198, 202]) {
      store[id].sendSyncParams = true;
    }
    return store;
  }

  _defaultKeyStore() {
    return {
      1: { minThreadKey: 0, parentThreadKey: -1, minLastActivityTimestampMs: 9999999999999, hasMoreBefore: false },
      95: { minThreadKey: 0, parentThreadKey: -1, minLastActivityTimestampMs: 9999999999999, hasMoreBefore: false },
    };
  }

  get isLoggedIn() {
    return this._loggedIn;
  }

  getCurrentUserID() {
    return this.iUserID || (this.configs ? this.configs.userId : "0");
  }

  getAppState() {
    return appStateFromCookies(this.cookies);
  }

  getEndpoint(name) {
    return this.endpoints[name];
  }

  // --- Bootstrap / login --------------------------------------------------

  async loadMessagesPage() {
    const headers = this.http.buildHeaders({ withCookies: true, isSecFetchDocument: true });
    headers["referer"] = this.endpoints.base_url + "/";
    let res = await this.http.request(this.endpoints.messages, { method: "GET", headers });
    const html = await this._bootstrapPage(res);

    // mautrix-meta's ModuleParser treats a Messenger bootstrap page that
    // reports `"USER_ID":"0"` as ErrUserIDIsZero (an ErrTokenInvalidated): the
    // session was rejected even though the request succeeded. Match that rather
    // than only failing when the cookie jar also looks logged out.
    if (html.includes('"USER_ID":"0"')) {
      throw errors.tokenInvalidated;
    }
    if (html.includes("/checkpoint/block/?next")) {
      throw errors.checkpointRequired;
    }

    const { configs, lsTable } = parseBootstrap(html);
    this.configs = configs;
    this.http.configs = configs;
    this.lsTable = lsTable;
    this._loggedIn = configs.isAuthenticated();

    if (!configs.versionID && this._loggedIn) {
      await this._crawlVersion(html);
    }
    if (!configs.mqttWebDeviceID) {
      configs.mqttWebDeviceID = generateSessionID();
    }
    this.syncManager = this._newSyncManager();
    this.syncStore = this.syncManager.store;
    this.keyStore = this.syncManager.keyStore;

    const finalTable = await this._applyInitialLsTable(lsTable);
    const ptks = [];
    for (const range of (finalTable && finalTable.LSThreadsRangesQuery) || []) {
      if (range.ParentThreadKey !== undefined && !ptks.includes(range.ParentThreadKey)) ptks.push(range.ParentThreadKey);
    }
    if (ptks.length) configs.parentThreadKeys = ptks;
    return configs;
  }

  // Facebook 302-redirects /messages to the canonical thread URL
  // (e.g. /messages/e2ee/t/<id>/) which carries the bootstrap payload. Follow
  // those redirects, but bail on login/checkpoint/consent redirects.
  async _bootstrapPage(res) {
    for (let i = 0; i < 5; i++) {
      if (res.status < 300 || res.status >= 400) return res.body.toString("utf8");
      const location = res.headers.get("location");
      if (!location) return res.body.toString("utf8");
      const locationURL = new URL(location, this.endpoints.messages);
      const { challenge, checkpoint } = accountVerificationPath(locationURL.pathname);
      if (challenge) throw new RedirectedError(errors.challengeRequired, locationURL.toString());
      if (checkpoint) throw new RedirectedError(errors.checkpointRequired, locationURL.toString());
      if (locationURL.pathname === "/accounts/suspended/") {
        throw new RedirectedError(errors.accountSuspended, locationURL.toString());
      }
      if (locationURL.pathname === "/consent/" || locationURL.pathname.startsWith("/privacy/consent/")) {
        throw new RedirectedError(errors.consentRequired, locationURL.toString());
      }
      if (locationURL.pathname === "/login.php") {
        throw new RedirectedError(errors.tokenInvalidated, locationURL.toString());
      }
      const headers = this.http.buildHeaders({ withCookies: true, isSecFetchDocument: true });
      headers["referer"] = this.endpoints.base_url + "/";
      res = await this.http.request(locationURL.toString(), { method: "GET", headers });
    }
    return res.body.toString("utf8");
  }

  async refreshTokens() {
    const sources = ["https://www.facebook.com/messages", "https://www.facebook.com/", "https://m.facebook.com/"];
    for (const url of sources) {
      try {
        const headers = this.http.buildHeaders({ withCookies: true, isSecFetchDocument: true });
        headers["referer"] = this.endpoints.base_url + "/";
        const res = await this.http.request(url, { method: "GET", headers });
        const html = res.body.toString("utf8");
        const dtsgMatch =
          html.match(/name="fb_dtsg"[^>]*?value="([^"]+)"/) ||
          html.match(/value="([^"]+)"[^>]*?name="fb_dtsg"/) ||
          html.match(/"DTSGInitData"\s*,\s*\[\s*\]\s*,\s*\{\s*"token"\s*:\s*"([^"]+)"/) ||
          html.match(/"fb_dtsg"\s*:\s*"([^"]+)"/);
        if (!dtsgMatch) continue;
        const jazoestMatch = html.match(/name="jazoest"[^>]*?value="([^"]+)"/) || html.match(/value="([^"]+)"[^>]*?name="jazoest"/);
        const lsdMatch = html.match(/"LSD"\s*,\s*\[\s*\]\s*,\s*\{\s*"token"\s*:\s*"([^"]+)"/);
        this.configs.dtsg = dtsgMatch[1];
        if (jazoestMatch) this.configs.jazoest = jazoestMatch[1];
        if (lsdMatch) {
          this.configs.lsd = lsdMatch[1];
          this.http.configs.lsd = lsdMatch[1];
        }
        this._lastTokenRefresh = Date.now();
        return { fb_dtsg: this.configs.dtsg, jazoest: this.configs.jazoest };
      } catch (_) { /* try next source */ }
    }
    if (this.configs.dtsg) return { fb_dtsg: this.configs.dtsg, jazoest: this.configs.jazoest };
    throw new Error("refreshTokens: could not find fb_dtsg");
  }

  // GraphQL endpoints (searchMusic, themes, thread info) start failing once the
  // bootstrap tokens go stale, which happens well before the socket drops. The
  // cached dtsg/lsd are refreshed lazily: `musicTokensStale` reports whether the
  // last refresh is older than `options.musicTokenTTLMs`, and `refreshMusicSession`
  // re-runs the token fetch (debounced) so callers can retry once.
  musicTokensStale(ttlMs) {
    const ttl = ttlMs === undefined ? 10 * 60 * 1000 : Number(ttlMs);
    if (!this.configs || !this.configs.dtsg) return true;
    if (!this._lastTokenRefresh) return true;
    return Date.now() - this._lastTokenRefresh >= ttl;
  }

  async refreshMusicSession(force) {
    const now = Date.now();
    if (!force && this._lastTokenRefresh && now - this._lastTokenRefresh < 60000) return false;
    this._lastTokenRefresh = now;
    await this.refreshTokens();
    return true;
  }

  async _crawlVersion(html) {
    const links = html.match(/href="([^"]+\.js[^"]*)"/g) || [];
    for (const link of links) {
      const href = link.slice(6, -1);
      if (!href.startsWith("https://")) continue;
      try {
        const res = await this.http.request(href, { method: "GET", headers: this.http.buildHeaders({ withCookies: false }) });
        const version = findVersionInJS(res.body.toString("utf8"));
        if (version) {
          this.configs.versionID = version;
          return;
        }
      } catch (_) { /* ignore */ }
    }
  }

  async _applyInitialLsTable(lsTable) {
    lsTable = lsTable || {};
    const hasFinallyBlock = (lsTable.LSExecuteFinallyBlockForSyncTransaction || []).length > 0;
    if (!hasFinallyBlock) {
      // No initial transaction data in the page: prime databases 1, 2 and 95
      // over GraphQL before the socket starts.
      for (const id of [1, 2, 95]) {
        this.syncManager.store[id].sendSyncParams = true;
      }
      this.syncManager.store[1].syncChannel = 1;
      this.syncManager.store[2].syncChannel = 2;
      this.syncManager.store[95].syncChannel = 2;
      const table = await this.syncDataGraphQL([1, 2, 95]);
      return table || lsTable;
    }
    this._applyThreadRanges(lsTable);
    for (const block of this._getSyncBlocks(lsTable)) this.syncManager.applyTransaction(block);
    return lsTable;
  }

  async syncDataGraphQL(databases) {
    let result = null;
    for (const dbID of databases) {
      const db = this.syncManager.store[dbID];
      if (!db) continue;
      const variables = {
        database: dbID,
        epoch_id: 0,
        last_applied_cursor: db.lastAppliedCursor,
        version: String(this.configs.versionID),
      };
      if (db.sendSyncParams) variables.sync_params = this._getSyncParams(dbID, db.syncChannel);
      const table = await this.makeLSRequest(variables, 1);
      if (dbID === 1) result = table;
      this._updateSyncGroupCursors(table);
    }
    return result;
  }

  _newSyncManager() {
    const client = this;
    const store = this._defaultSyncStore();
    const keyStore = this._defaultKeyStore();
    return {
      store,
      keyStore,
      applyTransaction(block) {
        const db = store[block.DatabaseID];
        if (!db) return;
        db.lastAppliedCursor = block.NextCursor;
        db.sendSyncParams = block.SendSyncParams;
        db.syncChannel = block.SyncChannel;
        db.currentSeqID = block.CurrentSeqID;
      },
      getCursor(db) {
        const entry = store[db];
        return entry && entry.lastAppliedCursor ? entry.lastAppliedCursor : "";
      },
    };
  }

  // --- HTTP query builders ------------------------------------------------

  newHTTPQuery() {
    this.graphQLRequests++;
    const c = this.configs;
    const site = c.siteData || {};
    const q = {};
    q.__user = c.userId;
    q.__a = "1";
    q.__req = Number(this.graphQLRequests).toString(36);
    q.__hs = site.haste_session || "";
    q.dpr = formatFloat(site.pr !== undefined ? site.pr : 1);
    q.__ccg = c.connectionClass || "";
    q.__rev = String(site.__spin_r || "");
    q.__s = c.webSessionID || "";
    q.__hsi = site.hsi || "";
    q.__dyn = c.bitmapStr || "";
    q.__csr = c.csrBitmapStr || "";
    q.__comet_req = c.cometReq || "";
    q.fb_dtsg = c.dtsg || "";
    q.jazoest = c.jazoest || "";
    q.lsd = c.lsd || "";
    q.__spin_r = String(site.__spin_r || "");
    q.__spin_b = site.__spin_b || "";
    q.__spin_t = String(site.__spin_t || "");
    q.__aaid = "0";
    for (const key of Object.keys(q)) if (q[key] === "" || q[key] === undefined) delete q[key];
    return q;
  }

  async makeGraphQLRequest(name, variables) {
    const doc = getDoc(name);
    const payload = this.newHTTPQuery();
    payload.fb_api_caller_class = doc.callerClass || "RelayModern";
    payload.fb_api_req_friendly_name = doc.friendlyName;
    payload.variables = JSON.stringify(variables);
    payload.server_timestamps = "true";
    if (doc.clientDocID) payload.client_doc_id = doc.clientDocID;
    else payload.doc_id = doc.docID;
    if (doc.jsessw) payload.__jssesw = doc.jsessw;

    const headers = this.http.buildHeaders({ withCookies: true });
    headers["x-fb-friendly-name"] = doc.friendlyName;
    if (this.configs.lsd) headers["x-fb-lsd"] = this.configs.lsd;
    headers["origin"] = this.endpoints.base_url;
    headers["referer"] = this.endpoints.messages + "/";

    const body = new URLSearchParams(payload).toString();
    const res = await this.http.request(this.endpoints.graphql, {
      method: "POST",
      headers,
      body,
      contentType: "application/x-www-form-urlencoded",
    });
    return parseJSON(stripAntiJS(res.body));
  }

  async makeLSRequest(variables, reqType) {
    const payload = {
      deviceId: this.configs.mqttWebDeviceID,
      includeChatVisibility: false,
      requestId: this.lsRequests,
      requestPayload: JSON.stringify(variables),
      requestType: reqType,
    };
    this.lsRequests++;
    const data = await this.makeGraphQLRequest("LSPlatformGraphQLLightspeedRequestQuery", payload);
    return this._parseLSResponse(data);
  }

  _parseLSResponse(graphQLData) {
    if (!graphQLData) throw new Error("graphql request didn't return data");
    const data = graphQLData.data;
    if (!data) {
      if (graphQLData.errors) throw new Error(JSON.stringify(graphQLData.errors));
      throw new Error("graphql request didn't return data");
    }
    const ls = data.viewer && data.viewer.lightspeed_web_request;
    if (!ls) throw new Error("graphql request didn't return LS data");
    const payload = parseLossless(ls.payload);
    const depMap = {};
    for (const dep of ls.dependencies || []) {
      if (dep && dep.name) depMap[dep.name] = dep.value && dep.value.__dr !== undefined ? dep.value.__dr : dep.value;
    }
    return this._decodeWithDeps(payload, depMap);
  }

  _decodeWithDeps(payload, depMap) {
    const { LightSpeedDecoder } = require("./lightspeed");
    const table = {};
    const decoder = new LightSpeedDecoder(depMap, table);
    decoder.decode(payload.step);
    return table;
  }

  // --- Socket -------------------------------------------------------------

  async connect() {
    if (this._connectPromise) return this._connectPromise;
    this._stopping = false;
    this._firstConnectSettled = false;
    this._connectPromise = new Promise((resolve, reject) => {
      this._connectResolve = resolve;
      this._connectReject = reject;
    });
    const loop = this._runConnectionLoop();
    this._loopPromise = loop;
    loop.then(
      () => {
        if (this._loopPromise === loop) this._loopPromise = null;
        if (this._connectPromise) this._connectPromise = null;
        if (this._connectReject) {
          const reject = this._connectReject;
          this._connectReject = null;
          this._connectResolve = null;
          reject(new Error("connection closed before ready"));
        }
      },
      (err) => {
        if (this._loopPromise === loop) this._loopPromise = null;
        if (this._connectPromise) this._connectPromise = null;
        if (this._connectReject) {
          const reject = this._connectReject;
          this._connectReject = null;
          this._connectResolve = null;
          reject(err);
        }
      }
    );
    // mautrix starts the force-refresh loop right after Connect returns.
    this._schedulePeriodicReconnect();
    return this._connectPromise;
  }

  async reset() {
    this._stopping = true;
    this._stopPeriodicReconnect();
    this._wakeBackoff();
    this._clearCanSendMessagesWaiters();
    this._clearSocketSyncWaiters();
    const socket = this.socket;
    this.connected = false;
    this._setCanSendMessages(false);
    if (socket) {
      try {
        socket.close();
      } catch (_) { /* ignore */ }
    }
    if (this._loopPromise) {
      const loop = this._loopPromise;
      await Promise.race([
        loop.catch(() => {}),
        new Promise((resolve) => {
          const timer = setTimeout(resolve, 5000);
          if (timer.unref) timer.unref();
        }),
      ]);
    }
    this._connectPromise = null;
    this._stopping = false;
  }

  async _runConnectionLoop() {
    if (!this._loggedIn) throw new Error("client is not authenticated, cannot connect");
    this.permanentErrored = false;
    let connectionAttempts = 1;
    let reconnectIn = 0;
    for (;;) {
      if (this._stopping) return;
      this._setCanSendMessages(false);
      const connectStart = Date.now();
      let err = null;
      try {
        await this._openSocket();
      } catch (e) {
        err = e;
      }
      this._clearSocketSyncWaiters();
      this._setCanSendMessages(false);
      if (this._stopping) return;

      if (err && err.closeCode === 4003) {
        err.message = "Not logged in.";
        this.permanentErrored = true;
        // mautrix stops the force-refresh loop on PermanentErrorEvent; a stopped
        // client must not schedule another full reconnect for a revoked session.
        this._stopPeriodicReconnect();
        this._emitError(err);
        this.emit("permanent-error", err);
        this._clearCanSendMessagesWaiters();
        if (this._connectReject) {
          const reject = this._connectReject;
          this._connectReject = null;
          this._connectResolve = null;
          reject(err);
        }
        return;
      }

      if (!err) this._settleFirstConnect();

      this.emit("transient-disconnect", { error: err, connectionAttempts });
      if (this.options.autoReconnect === false) {
        const stopErr = err || new Error("connection closed");
        this.permanentErrored = true;
        this._stopPeriodicReconnect();
        this._emitError(stopErr);
        this.emit("permanent-error", stopErr);
        this._clearCanSendMessagesWaiters();
        if (this._connectReject) {
          const reject = this._connectReject;
          this._connectReject = null;
          this._connectResolve = null;
          reject(stopErr);
        }
        return;
      }
      if (Date.now() - connectStart > 2 * 60 * 1000 && this._socketWasConnected) {
        reconnectIn = 0;
        connectionAttempts = 0;
      } else {
        if (reconnectIn === 0) reconnectIn = 1000;
        connectionAttempts += 1;
        reconnectIn *= 2;
        if (reconnectIn > MAX_CONNECT_BACKOFF) reconnectIn = MAX_CONNECT_BACKOFF;
      }
      this.emit("reconnecting", { error: err, reconnectIn });
      await new Promise((resolve) => {
        this._backoffResolve = resolve;
        const timer = setTimeout(() => {
          this._backoffResolve = null;
          resolve();
        }, reconnectIn);
        if (timer.unref) timer.unref();
      });
      this.http.updateProxy(this.options.proxy);
    }
  }

  _wakeBackoff() {
    if (this._backoffResolve) {
      const resolve = this._backoffResolve;
      this._backoffResolve = null;
      resolve();
    }
  }

  _clearSocketSyncWaiters() {
    for (const [id, waiter] of this.syncWaiters) {
      try {
        waiter(null);
      } catch (_) { /* ignore */ }
      this.syncWaiters.delete(id);
    }
  }

  _emitError(err) {
    if (this.listenerCount("error") > 0) this.emit("error", err);
  }

  // Called when a request reveals the cached bootstrap session (fb_dtsg/lsd) is
  // stale: Meta answers with error 1357001 (token invalidated) or 1357004
  // (please reload page). mautrix-meta reacts to both with a full reconnect that
  // re-reads the bootstrap page, so the session recovers instead of every later
  // request failing. Debounced so a burst of stale responses triggers one
  // reconnect, and gated by canReconnect() so it cannot thrash.
  onStaleSession() {
    if (this.permanentErrored || this._stopping || !this._loggedIn) return;
    if (this._staleReconnectPending || this._staleRefreshPromise) return;
    this._staleReconnectPending = true;
    this._staleReconnectTimer = setTimeout(() => {
      this._staleReconnectTimer = null;
      this._staleReconnectPending = false;
      if (this._stopping || this.permanentErrored) return;
      this.refreshStaleSession().catch((e) => this._emitError(e));
    }, 1500);
    if (this._staleReconnectTimer.unref) this._staleReconnectTimer.unref();
  }

  // Awaitable stale-session recovery. mautrix re-reads the bootstrap page
  // (full reconnect) before retrying the failed request; when a full reconnect
  // is not allowed yet it at least re-fetches the dtsg/lsd tokens. Concurrent
  // callers share a single in-flight recovery so a burst of 1357001/1357004
  // responses does not start several reconnects.
  refreshStaleSession() {
    if (this._staleRefreshPromise) return this._staleRefreshPromise;
    // Cancel any debounced onStaleSession timer so an awaited recovery (e.g. the
    // upload retry) does not fire a second reconnect afterwards.
    if (this._staleReconnectTimer) {
      clearTimeout(this._staleReconnectTimer);
      this._staleReconnectTimer = null;
      this._staleReconnectPending = false;
    }
    const run = async () => {
      try {
        if (this.permanentErrored || this._stopping || !this._loggedIn) return;
        if (this.canReconnect()) await this.fullReconnect();
        else await this.refreshTokens();
      } finally {
        this._staleRefreshPromise = null;
      }
    };
    this._staleRefreshPromise = run();
    return this._staleRefreshPromise;
  }

  async _openSocket() {
    if (this.socket) {
      try {
        this.socket.close();
      } catch (_) { /* ignore */ }
    }
    const socket = new DgwSocket({
      getCookies: () => this.cookies.toString(),
      origin: this.endpoints.base_url,
      wsURL: this.endpoints.dgw_lightspeed,
      appID: this.configs.dgwWebConfig.appId || this.configs.appId,
      userID: this.configs.userId,
      deviceID: this.configs.mqttWebDeviceID,
      userAgent: this.userAgent,
      proxy: this.options.proxy,
      onConnect: () => this._onSocketConnect(),
    });
    socket.on("error", (err) => this._emitError(err));
    this.socket = socket;
    this.connected = false;
    await socket.connect();
    this.connected = true;
    this._socketWasConnected = true;
    this.emit("connected");
    // mautrix's messagix Client.Connect returns as soon as the socket is up and
    // runs the read loop in a goroutine. Resolve the connect() promise here, at
    // "ready", instead of only after the socket closes: otherwise connect()
    // never settles while the session is healthy and fullReconnect() (used by
    // the stale-session upload recovery) blocks forever.
    this._settleFirstConnect();

    // Keep the loop alive until the socket actually closes. The socket emits
    // "close" once per connection, which resolves this promise.
    let closeErr = null;
    await new Promise((resolve) => {
      const onClose = (err) => {
        socket.removeListener("close", onClose);
        closeErr = err || null;
        this.connected = false;
        this._setCanSendMessages(false);
        this.emit("disconnected", closeErr);
        resolve();
      };
      if (!socket.isConnected()) {
        onClose(null);
        return;
      }
      socket.once("close", onClose);
    });
    if (closeErr) throw closeErr;
  }

  _settleFirstConnect(err) {
    if (this._firstConnectSettled) return;
    this._firstConnectSettled = true;
    const resolve = this._connectResolve;
    const reject = this._connectReject;
    this._connectResolve = null;
    this._connectReject = null;
    if (err) {
      if (reject) reject(err);
    } else if (resolve) {
      resolve();
    }
  }

  async _onSocketConnect() {
    this._setCanSendMessages(true);
    const reconnect = this.socketWasSynced;
    if (!reconnect) {
      await this._sendInitialThreadFetch();
    }
    await this._ensureSyncedSocket(BASE_SYNC_DATABASES);
    this.socketWasSynced = true;
    this._socketWasConnected = true;
    this.emit("ready", { reconnect });
  }

  // mautrix-meta forces a full reconnect every ForceRefreshIntervalSeconds
  // (default 20h) so the bootstrap config (fb_dtsg, LSD, version id, sync
  // cursors) is re-fetched on a long-lived session instead of going stale.
  _schedulePeriodicReconnect() {
    this._stopPeriodicReconnect();
    const raw = this.options.forceRefreshIntervalMs;
    if (raw === 0) return;
    const ms = Number.isFinite(Number(raw)) && Number(raw) > 0 ? Number(raw) : DEFAULT_FORCE_REFRESH_MS;
    this._periodicReconnectTimer = setTimeout(() => {
      this._periodicReconnectTimer = null;
      this.fullReconnect().catch((err) => this._emitError(err));
    }, ms);
    if (this._periodicReconnectTimer.unref) this._periodicReconnectTimer.unref();
  }

  _stopPeriodicReconnect() {
    if (this._periodicReconnectTimer) {
      clearTimeout(this._periodicReconnectTimer);
      this._periodicReconnectTimer = null;
    }
    if (this._staleReconnectTimer) {
      clearTimeout(this._staleReconnectTimer);
      this._staleReconnectTimer = null;
      this._staleReconnectPending = false;
    }
  }

  canReconnect() {
    const raw = Number(this.options.minFullReconnectMs);
    const min = Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_MIN_FULL_RECONNECT_MS;
    return this._loggedIn && Date.now() - this._lastFullReconnect > min;
  }

  // Tear the connection down, re-run the bootstrap (fresh tokens + sync state)
  // and reconnect. Mirrors mautrix-meta's MetaClient.FullReconnect.
  async fullReconnect() {
    if (this.permanentErrored || !this._loggedIn) return;
    if (!this.canReconnect()) {
      this._schedulePeriodicReconnect();
      return;
    }
    this._lastFullReconnect = Date.now();
    this.socketWasSynced = false;
    await this.reset();
    try {
      await this.loadMessagesPage();
    } catch (err) {
      this._emitError(err);
    }
    if (this._stopping || this.permanentErrored) return;
    await this.connect().catch((err) => this._emitError(err));
    this._schedulePeriodicReconnect();
  }

  disconnect() {
    this._stopping = true;
    this._stopPeriodicReconnect();
    this._wakeBackoff();
    this._clearCanSendMessagesWaiters();
    const socket = this.socket;
    this.connected = false;
    this._setCanSendMessages(false);
    this.socketWasSynced = false;
    this._clearSocketSyncWaiters();
    if (socket) {
      socket.close();
      if (!socket.isConnected()) {
        this.socket = null;
        this.emit("disconnected", null);
      }
    }
  }

  forceReconnect() {
    if (this.socket) this.socket.forceReconnect();
  }

  _encodeLSRequest(payload, type) {
    this.packetsSent = (this.packetsSent + 1) & 0xffff;
    if (this.packetsSent === 0) this.packetsSent = 1;
    return {
      json: JSON.stringify({
        app_id: this.configs.appId,
        payload: typeof payload === "string" ? payload : payload.toString("utf8"),
        request_id: this.packetsSent,
        type,
      }),
      requestID: this.packetsSent,
    };
  }

  async _makeLSRequestViaSocket(payload, type) {
    if (!this.socket || !this.socket.isConnected()) throw new Error("socket is not connected");
    const { json } = this._encodeLSRequest(payload, type);
    const response = await this.socket.doOneOffStream(Buffer.from(json), type === 4);
    if (type === 4) return null;
    const prd = parseJSON(Buffer.from(response));
    if (!prd) throw new Error("failed to parse response payload");
    return prd;
  }

  async sendTasks(tasks, type = 3) {
    if (!this.canSendMessages) {
      this._ensureConnectStarted();
      try {
        await this.waitUntilCanSendMessages();
      } catch (_) { /* proceed and let the request fail if still disconnected */ }
    }
    const tm = new TaskManager(this);
    for (const task of tasks) tm.addTask(task.label, task.payload, task.queueName);
    const payload = tm.finalizePayload();
    return this._makeLSRequestViaSocket(payload, type);
  }

  async sendStatelessTask(task) {
    const payload = {
      label: task.label,
      payload: stringifyBigInt(task.payload),
      version: String(this.configs.versionID),
    };
    return this._makeLSRequestViaSocket(stringifyBigInt(payload), 4);
  }

  _getTaskID() {
    return this.nextTaskID++;
  }

  _trackMessageThread(messageID, threadID, timestamp) {
    if (!messageID || threadID === undefined || threadID === null || threadID === "") return;
    const key = String(messageID);
    this._messageThreadMap.set(key, String(threadID));
    if (timestamp) this._messageThreadTimestamps.set(key, Number(timestamp));
    if (this._messageThreadMap.size > 20000) {
      const oldest = this._messageThreadMap.keys().next().value;
      this._messageThreadMap.delete(oldest);
      this._messageThreadTimestamps.delete(oldest);
    }
  }

  _getMessageThread(messageID) {
    if (!messageID) return "";
    const key = String(messageID);
    const known = this._messageThreadMap.get(key);
    if (known) return known;
    if (this.formatter && this.formatter.messageThreads) {
      const fromFormatter = this.formatter.messageThreads.get(key);
      if (fromFormatter) return fromFormatter;
    }
    return "";
  }

  _getMessageTimestamp(messageID) {
    if (!messageID) return 0;
    const key = String(messageID);
    const known = this._messageThreadTimestamps.get(key);
    if (known) return known;
    const parsed = require("./utils").parseMessageIDTimestamp(key);
    return parsed || 0;
  }

  // --- Sync ---------------------------------------------------------------

  async _ensureSyncedSocket(databases) {
    await Promise.all(databases.map((db) => this._syncSocketData(db)));
  }

  async _syncSocketData(databaseID) {
    const db = this.syncManager.store[databaseID];
    if (!db) return;
    try {
      await this._recursivelySyncSocketData(databaseID, db, null, 0);
    } catch (err) {
      // mautrix-meta only lets a database-1 sync failure surface as a connection
      // error (syncSocketData sets outErr for db 1); the other databases just log.
      // The old code returned silently, so a dead socket looked "synced".
      if (databaseID === 1) throw err;
      this.emit("sync-error", { databaseID, error: err });
    }
  }

  async _recursivelySyncSocketData(databaseID, db, stream, depth) {
    if (depth > MAX_SYNC_RECURSION) return;
    const payload = {
      database: databaseID,
      last_applied_cursor: null,
      sync_params: null,
      epoch_id: require("./utils").generateEpochID(),
      version: this.configs.versionID,
      failure_count: null,
    };
    let type;
    if (db.sendSyncParams) {
      type = 1;
      payload.sync_params = this._getSyncParams(databaseID, db.syncChannel);
    } else {
      type = 2;
      payload.last_applied_cursor = db.lastAppliedCursor;
    }
    const encoded = this._encodeLSRequest(require("./utils").stringifyBigInt(payload), type);
    const ch = new Promise((resolve) => this.syncWaiters.set(encoded.requestID, resolve));

    if (!stream) {
      stream = await this.socket.establishStream({
        initPayload: Buffer.from(encoded.json),
        frameHandler: (frame) => this._handleSocketFrame(frame),
      });
    } else {
      await stream.sendData(Buffer.from(encoded.json));
    }

    const resp = await Promise.race([
      ch,
      new Promise((_, reject) => setTimeout(() => reject(new Error("timeout waiting for database sync response")), SYNC_RESPONSE_TIMEOUT)),
    ]);
    this.syncWaiters.delete(encoded.requestID);
    if (!resp) return;

    const table = this._parsePublishResponse(resp);
    this.emit("sync", table);

    const blocks = this._getSyncBlocks(table);
    if (blocks.length === 0) return;
    const block = blocks[0];
    const prevCursor = db.lastAppliedCursor;
    this._updateSyncGroupCursors(table);
    this._dispatchTable(table);

    const next = block.NextCursor;
    const current = block.CurrentCursor;
    if (next === current || next === prevCursor || next === "dummy_cursor" || !next || !RECURSE_DATABASES.has(databaseID)) {
      return;
    }
    db.lastAppliedCursor = next;
    db.sendSyncParams = block.SendSyncParams;
    db.syncChannel = block.SyncChannel;
    return this._recursivelySyncSocketData(databaseID, db, stream, depth + 1);
  }

  _getSyncBlocks(table) {
    if (table.LSExecuteFirstBlockForSyncTransactionV4 && table.LSExecuteFirstBlockForSyncTransactionV4.length) {
      return table.LSExecuteFirstBlockForSyncTransactionV4;
    }
    return table.LSExecuteFirstBlockForSyncTransaction || [];
  }

  _updateSyncGroupCursors(table) {
    for (const block of this._getSyncBlocks(table)) {
      const db = this.syncManager.store[block.DatabaseID];
      if (!db) continue;
      db.lastAppliedCursor = block.NextCursor;
      db.sendSyncParams = block.SendSyncParams;
      db.syncChannel = block.SyncChannel;
      db.currentSeqID = block.CurrentSeqID;
    }
    this._applyThreadRanges(table);
  }

  _getSyncParams(dbID, channel) {
    if (dbID === 7) return '{"mnet_rank_types":[44]}';
    const params = (this.configs && this.configs.syncParams) || {};
    if (channel === 1) return params.mailbox || JSON.stringify({ locale: "en_US" });
    if (channel === 2) return params.contact || JSON.stringify({ locale: "en_US" });
    return params.e2ee || JSON.stringify({ locale: "en_US" });
  }

  _applyThreadRanges(table) {
    for (const range of table.LSUpsertSyncGroupThreadsRange || []) {
      if (!range.HasMoreBefore) continue;
      const store = this.keyStore[range.SyncGroup];
      if (store) {
        store.hasMoreBefore = range.HasMoreBefore;
        store.minLastActivityTimestampMs = range.MinLastActivityTimestampMS;
        store.minThreadKey = range.MinThreadKey;
        store.parentThreadKey = range.ParentThreadKey;
      }
    }
  }

  async _sendInitialThreadFetch() {
    const { fetchThreadsTask } = require("./tasks");
    const tasks = [];
    let ptks = this.configs.parentThreadKeys && this.configs.parentThreadKeys.length ? this.configs.parentThreadKeys.slice() : [-1];
    if (!ptks.includes(-1)) ptks.push(-1);
    const addFetch = (parentThreadKey, referenceThreadKey, referenceActivityTimestamp, syncGroup, cursor) => {
      tasks.push(fetchThreadsTask({
        parentThreadKey,
        referenceThreadKey,
        referenceActivityTimestamp,
        syncGroup,
        cursor,
      }));
    };
    for (const tk of ptks) {
      addFetch(tk, 0, 9999999999999, 1, this.syncManager.getCursor(1));
      addFetch(tk, 0, 9999999999999, 95, undefined);
    }
    const keyStore1 = this.keyStore[1];
    if (keyStore1 && (keyStore1.parentThreadKey !== -1 || keyStore1.minThreadKey !== 0 || keyStore1.minLastActivityTimestampMs !== 9999999999999)) {
      addFetch(keyStore1.parentThreadKey, keyStore1.minThreadKey, keyStore1.minLastActivityTimestampMs, 1, this.syncManager.getCursor(1));
      addFetch(keyStore1.parentThreadKey, keyStore1.minThreadKey, keyStore1.minLastActivityTimestampMs, 95, undefined);
    }
    const tm = new TaskManager(this);
    for (const task of tasks) tm.addTask(task.label, task.payload, task.queueName);
    await this._makeLSRequestViaSocket(tm.finalizePayload(), 3);
  }

  async fetchMoreThreads(syncGroup, { dispatch = true } = {}) {
    const keyStore = this.keyStore[syncGroup];
    if (!keyStore || !keyStore.hasMoreBefore) return { keyStore, table: null };
    const { fetchThreadsTask } = require("./tasks");
    const task = fetchThreadsTask({
      parentThreadKey: keyStore.parentThreadKey,
      referenceThreadKey: keyStore.minThreadKey,
      referenceActivityTimestamp: keyStore.minLastActivityTimestampMs,
      syncGroup,
      cursor: this.syncManager.getCursor(syncGroup),
    });
    const response = await this.sendTasks([task]);
    const table = this._parsePublishResponse(response);
    this._applyThreadRanges(table);
    if (dispatch) this._dispatchTable(table);
    return { keyStore: this.keyStore[syncGroup], table };
  }

  // --- Socket frame handling ---------------------------------------------

  _handleSocketFrame(frame) {
    const prd = parseLossless(frame.toString("utf8"));
    if (!prd) return;
    const waiter = this.syncWaiters.get(prd.request_id);
    if (waiter) {
      this.syncWaiters.delete(prd.request_id);
      waiter(prd);
      return;
    }
    const table = this._parsePublishResponse(prd);
    this._applyThreadRanges(table);
    this._dispatchTable(table);
  }

  _parsePublishResponse(prd) {
    if (!prd || !prd.payload) return {};
    const lsData = parseLossless(prd.payload.toString());
    if (!lsData) return {};
    const { LightSpeedDecoder } = require("./lightspeed");
    const { spToDepMap } = require("./lightspeed/sp");
    const depMap = spToDepMap(prd.sp);
    const table = {};
    const decoder = new LightSpeedDecoder(depMap, table);
    decoder.decode(lsData.step);
    return table;
  }

  _dispatchTable(table) {
    if (!table) return;
    const hasContent = Object.keys(table).length > 0;
    if (hasContent) this.emit("ls-table", table);
  }

  // --- Public request helper ---------------------------------------------

  async sendLSRequest(variables, reqType) {
    if (this.connected) {
      const payload = {
        database: variables.database,
        last_applied_cursor: variables.lastAppliedCursor || null,
        sync_params: variables.syncParams || null,
        epoch_id: Number(variables.epochID || 0),
        version: String(this.configs.versionID),
        failure_count: null,
      };
      const prd = await this._makeLSRequestViaSocket(JSON.stringify(payload), reqType);
      if (prd) return this._parsePublishResponse(prd);
      return null;
    }
    return this.makeLSRequest(variables, reqType);
  }
}

module.exports = { Client, BASE_SYNC_DATABASES };
