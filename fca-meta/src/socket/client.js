"use strict";

const { EventEmitter } = require("events");
const crypto = require("crypto");
const WebSocket = require("ws");
const {
  FRAME_TYPE,
  MAX_STREAM_ID,
  decodeFrame,
  encodePing,
  encodePong,
  encodeAck,
  encodeEndOfData,
  encodeEstablishStream,
  encodeDataFrame,
} = require("./frames");

const ACK_TIMEOUT = 5000;
const PING_INTERVAL = 10000;
const PONG_TIMEOUT = 30000;
const WRITE_TIMEOUT = 20000;

class OneOffStream {
  constructor(socket, streamID, noAckOrData) {
    this.socket = socket;
    this.streamID = streamID;
    this.noAck = noAckOrData;
    this.noData = noAckOrData;
    this.established = false;
    this.acked = false;
    this.received = false;
    this.closed = false;
    this.data = null;
    this.establishError = null;
    this._resolve = null;
    this._reject = null;
  }

  waitFor() {
    return new Promise((resolve, reject) => {
      this._resolve = resolve;
      this._reject = reject;
    });
  }

  _settle() {
    if (this.closed) return;
    this.closed = true;
    if (this.establishError) {
      this._reject(new Error("dgw: establish error: " + this.establishError));
      return;
    }
    if (this.data === null) {
      if (this.noData) {
        this._resolve(null);
        return;
      }
      this._reject(new Error("dgw: data is unexpectedly nil"));
      return;
    }
    this._resolve(this.data);
  }

  onEstablish(params) {
    let code = 200;
    try {
      const parsed = JSON.parse(params.toString("utf8"));
      code = parsed && parsed.code !== undefined ? parsed.code : 200;
    } catch (_) {
      code = 200;
    }
    if (code !== 200) this.establishError = "code " + code;
    this.established = true;
    this._maybeSettle();
  }

  onAck(ackID) {
    if (ackID === 0) this.acked = true;
    this._maybeSettle();
  }

  onData(frame) {
    if (this.data === null) {
      this.data = frame.payload;
      this.received = true;
      this.socket._send(encodeAck(this.streamID, frame.ackID));
      this.socket._send(encodeEndOfData(this.streamID));
    }
    this._maybeSettle();
  }

  _maybeSettle() {
    if (this.establishError) {
      this._settle();
      return;
    }
    if (!this.established) return;
    if (!this.noAck && !this.acked) return;
    if (!this.noData && !this.received) return;
    this._settle();
  }

  onClose() {
    if (this.closed) return;
    this.closed = true;
    if (this.establishError) {
      this._reject(new Error("dgw: establish error: " + this.establishError));
    } else if (this.data === null && !this.noData) {
      this._reject(new Error("dgw: stream closed before data"));
    } else {
      this._resolve(this.noData ? null : this.data);
    }
  }
}

class PersistentStream {
  constructor(socket, streamID, frameHandler, onClose) {
    this.socket = socket;
    this.streamID = streamID;
    this.frameHandler = frameHandler;
    this.onCloseCallback = onClose;
    this.nextAckID = 0;
    this.pendingAcks = new Map();
    this.closed = false;
    this.established = false;
    this.establishError = null;
  }

  onEstablish(params) {
    let code = 200;
    try {
      const parsed = JSON.parse(params.toString("utf8"));
      code = parsed && parsed.code !== undefined ? parsed.code : 200;
    } catch (_) {
      code = 200;
    }
    if (code !== 200) this.establishError = "code " + code;
    this.established = true;
  }

  async establish(initPayload) {
    const frames = [encodeEstablishStream(this.streamID, {})];
    let ackID;
    if (initPayload) {
      ackID = this._addAck();
      frames.push(encodeDataFrame(this.streamID, initPayload, { requiresAck: true, ackID }));
    }
    this.socket._send(Buffer.concat(frames));
    const deadline = Date.now() + ACK_TIMEOUT;
    while (!this.established && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 10));
    }
    if (!this.established) throw new Error("dgw: ack timed out for establish frame");
    if (this.establishError) throw new Error("dgw: establish error: " + this.establishError);
    if (ackID !== undefined) {
      const acked = await this._waitAck(ackID, deadline);
      if (!acked) throw new Error("dgw: ack timed out for init payload");
    }
  }

  _addAck() {
    const id = this.nextAckID;
    this.nextAckID = (this.nextAckID + 1) & 0x7fff;
    const waiter = { acked: false, resolve: null, timer: null, promise: null };
    waiter.promise = new Promise((resolve) => {
      waiter.resolve = resolve;
    });
    this.pendingAcks.set(id, waiter);
    return id;
  }

  _waitAck(ackID, deadline) {
    const waiter = this.pendingAcks.get(ackID);
    if (!waiter) return Promise.resolve(false);
    if (waiter.acked) {
      this.pendingAcks.delete(ackID);
      return Promise.resolve(true);
    }
    return new Promise((resolve) => {
      const remaining = Math.max(0, deadline - Date.now());
      waiter.timer = setTimeout(() => {
        this.pendingAcks.delete(ackID);
        resolve(false);
      }, remaining);
      waiter.promise.then((acked) => {
        if (waiter.timer) clearTimeout(waiter.timer);
        this.pendingAcks.delete(ackID);
        resolve(acked);
      });
    });
  }

  receiveAck(ackID) {
    const waiter = this.pendingAcks.get(ackID);
    if (!waiter) return false;
    waiter.acked = true;
    if (waiter.timer) clearTimeout(waiter.timer);
    if (waiter.resolve) waiter.resolve(true);
    return true;
  }

  onData(frame) {
    if (this.frameHandler) this.frameHandler(frame.payload);
    if (frame.requiresAck) this.socket._send(encodeAck(this.streamID, frame.ackID));
  }

  async sendData(payload) {
    if (this.closed) throw new Error("dgw: stream already closed");
    const ackID = this._addAck();
    this.socket._send(encodeDataFrame(this.streamID, payload, { requiresAck: true, ackID }));
    const acked = await this._waitAck(ackID, Date.now() + ACK_TIMEOUT);
    if (!acked) throw new Error("dgw: ack timed out");
  }

  sendDataNoAck(payload) {
    if (this.closed) throw new Error("dgw: stream already closed");
    this.socket._send(encodeDataFrame(this.streamID, payload));
  }

  onClose(endOfData) {
    if (this.closed) return;
    this.closed = true;
    for (const [, waiter] of this.pendingAcks) {
      if (waiter.timer) clearTimeout(waiter.timer);
      if (waiter.resolve) waiter.resolve(false);
    }
    this.pendingAcks.clear();
    if (endOfData && this.onCloseCallback) this.onCloseCallback();
  }
}

class DgwSocket extends EventEmitter {
  constructor(options) {
    super();
    this.getCookies = options.getCookies;
    this.onConnect = options.onConnect;
    this.origin = options.origin;
    this.wsURL = options.wsURL;
    this.appID = options.appID || "";
    this.userID = options.userID || "";
    this.deviceID = options.deviceID || crypto.randomUUID();
    this.loggingID = options.loggingID !== false;
    this.userAgent = options.userAgent;
    this.proxy = options.proxy;
    this._agent = null;
    if (this.proxy) {
      try {
        const { HttpsProxyAgent } = require("https-proxy-agent");
        this._agent = new HttpsProxyAgent(this.proxy);
      } catch (_) {
        this._agent = null;
      }
    }

    this.ws = null;
    this.streams = new Map();
    this.nextStreamID = 0;
    this.stopping = false;
    this.connected = false;
    this.deauthed = false;
    this._closeEmitted = false;
    this._closeError = null;
    this.lastPong = 0;
    this.pingTimer = null;
    this.pongTimer = null;
    this._buffered = Buffer.alloc(0);
  }

  isConnected() {
    return this.connected;
  }

  _getConnURL() {
    const query = new URLSearchParams();
    query.set("x-dgw-appid", this.appID);
    query.set("x-dgw-appversion", "0");
    query.set("x-dgw-authtype", "1:0");
    query.set("x-dgw-version", "5");
    query.set("x-dgw-uuid", this.userID);
    query.set("x-dgw-tier", "prod");
    if (this.loggingID) query.set("x-dgw-loggingid", crypto.randomUUID());
    query.set("x-dgw-deviceid", this.deviceID);
    return this.wsURL + "?" + query.toString();
  }

  _getConnHeaders() {
    const headers = {
      cookie: this.getCookies ? this.getCookies() : "",
      "user-agent": this.userAgent,
      origin: this.origin,
      "sec-fetch-dest": "empty",
      "sec-fetch-mode": "websocket",
      "sec-fetch-site": "same-site",
    };
    return headers;
  }

  _tlsOptions() {
    try {
      return require("../tls").chromeConnectOptions();
    } catch (_) {
      return {};
    }
  }

  connect() {
    return new Promise((resolve, reject) => {
      if (this.stopping) return resolve();
      let settled = false;
      const wsOptions = {
        headers: this._getConnHeaders(),
        followRedirects: true,
      };
      Object.assign(wsOptions, this._tlsOptions());
      if (this._agent) wsOptions.agent = this._agent;
      this.ws = new WebSocket(this._getConnURL(), wsOptions);
      this.ws.binaryType = "nodebuffer";

      this.ws.on("open", async () => {
        this.connected = true;
        this.lastPong = Date.now();
        this._startTimers();
        try {
          if (this.onConnect) await this.onConnect();
          settled = true;
          resolve();
        } catch (err) {
          settled = true;
          reject(err);
          this.close();
        }
      });

      this.ws.on("message", (data) => this._onMessage(data));
      this.ws.on("ping", () => this._send(encodePong()));
      this.ws.on("pong", () => {
        this.lastPong = Date.now();
      });
      this.ws.on("error", (err) => {
        if (!settled) {
          settled = true;
          reject(err);
        }
      });
      this.ws.on("close", (code) => {
        // A deauth frame means the session was revoked; report it as an
        // unauthorized (4003) close so the caller stops reconnecting.
        this._emitCloseOnce(this.deauthed ? 4003 : code);
        if (!settled) {
          settled = true;
          reject(this._closeError);
        }
      });
    });
  }

  // Emit "close" exactly once, whether the underlying websocket closed or a
  // deauth frame revoked the session. The code is the websocket close code, or
  // 4003 for a deauth (mautrix maps deauth to ErrUnauthorized).
  _emitCloseOnce(code) {
    if (this._closeEmitted) return;
    this._closeEmitted = true;
    this.connected = false;
    this._stopTimers();
    const err = new Error("dgw: socket closed (code " + code + ")");
    err.closeCode = code;
    this._closeError = err;
    for (const stream of this.streams.values()) stream.onClose(false);
    this.streams.clear();
    this.emit("close", err);
    if (this.ws) {
      try {
        this.ws.close();
      } catch (_) { /* ignore */ }
    }
  }

  _startTimers() {
    this._stopTimers();
    this.pingTimer = setInterval(() => {
      if (this.connected) this._send(encodePing());
    }, PING_INTERVAL);
    this.pongTimer = setInterval(() => {
      if (this.connected && Date.now() - this.lastPong > PONG_TIMEOUT) {
        this.emit("error", new Error("dgw: pong timeout"));
        this.forceReconnect();
      }
    }, 5000);
    if (this.pingTimer.unref) this.pingTimer.unref();
    if (this.pongTimer.unref) this.pongTimer.unref();
  }

  _stopTimers() {
    if (this.pingTimer) clearInterval(this.pingTimer);
    if (this.pongTimer) clearInterval(this.pongTimer);
    this.pingTimer = null;
    this.pongTimer = null;
  }

  _onMessage(data) {
    this._buffered = Buffer.concat([this._buffered, data]);
    for (;;) {
      if (this._buffered.length === 0) break;
      const before = this._buffered;
      const { frame, rest } = decodeFrame(before);
      if (!frame) break;
      this._buffered = rest;
      this._handleFrame(frame);
    }
  }

  _handleFrame(frame) {
    switch (frame.type) {
      case FRAME_TYPE.PING:
        this.lastPong = Date.now();
        this._send(encodePong());
        break;
      case FRAME_TYPE.PONG:
        this.lastPong = Date.now();
        break;
      case FRAME_TYPE.ACK: {
        const stream = this.streams.get(frame.streamID);
        if (stream) {
          if (typeof stream.receiveAck === "function") stream.receiveAck(frame.ackID);
          else if (typeof stream.onAck === "function") stream.onAck(frame.ackID);
        }
        break;
      }
      case FRAME_TYPE.DATA:
      case FRAME_TYPE.EXTENDED_DATA: {
        const stream = this.streams.get(frame.streamID);
        if (stream) {
          stream.onData(frame);
        } else if (frame.requiresAck) {
          this._send(encodeAck(frame.streamID, frame.ackID));
        }
        break;
      }
      case FRAME_TYPE.ESTAB_STREAM: {
        const stream = this.streams.get(frame.streamID);
        if (stream) stream.onEstablish(frame.parameters);
        break;
      }
      case FRAME_TYPE.END_OF_DATA:
      case FRAME_TYPE.END_OF_DATA_WITH_REASON: {
        const stream = this.streams.get(frame.streamID);
        if (stream) {
          this.streams.delete(frame.streamID);
          stream.onClose(true);
        }
        break;
      }
      case FRAME_TYPE.DRAIN:
        break;
      case FRAME_TYPE.DEAUTH:
        // mautrix treats a deauth frame as an unauthorized (logged-out) socket
        // and fails the connection. Surface it as a 4003 close so the connection
        // loop marks the client permanently errored instead of reconnecting.
        this.deauthed = true;
        this.emit("deauth");
        this._emitCloseOnce(4003);
        break;
      default:
        break;
    }
  }

  _send(buffer) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    try {
      this.ws.send(buffer);
    } catch (_) { /* ignore */ }
  }

  _claimStreamID() {
    for (let i = 0; i <= MAX_STREAM_ID; i++) {
      const id = this.nextStreamID;
      this.nextStreamID = (this.nextStreamID + 1) & MAX_STREAM_ID;
      if (!this.streams.has(id)) return id;
    }
    throw new Error("dgw: exhausted stream IDs");
  }

  async doOneOffStream(payload, noAckOrData) {
    if (!this.connected) throw new Error("dgw: socket is not open");
    const streamID = this._claimStreamID();
    const stream = new OneOffStream(this, streamID, noAckOrData);
    this.streams.set(streamID, stream);
    try {
      const frames = [
        encodeEstablishStream(streamID, {}),
        encodeDataFrame(streamID, payload, { requiresAck: !noAckOrData, ackID: 0 }),
      ];
      this._send(Buffer.concat(frames));
      const result = await Promise.race([
        stream.waitFor(),
        new Promise((_, reject) => setTimeout(() => reject(new Error("dgw: one-off stream timed out")), ACK_TIMEOUT * 4)),
      ]);
      return result;
    } finally {
      this.streams.delete(streamID);
      this._send(encodeEndOfData(streamID));
    }
  }

  async establishStream({ initPayload, frameHandler, onClose, logName }) {
    if (!this.connected) throw new Error("dgw: socket is not open");
    const streamID = this._claimStreamID();
    const stream = new PersistentStream(this, streamID, frameHandler, onClose);
    this.streams.set(streamID, stream);
    try {
      await stream.establish(initPayload);
    } catch (err) {
      this.streams.delete(streamID);
      throw err;
    }
    return stream;
  }

  forceReconnect() {
    if (this.ws) {
      try {
        this.ws.terminate();
      } catch (_) { /* ignore */ }
    }
  }

  close() {
    this.stopping = true;
    this._stopTimers();
    if (this.ws) {
      try {
        this.ws.close();
      } catch (_) { /* ignore */ }
    }
  }
}

module.exports = { DgwSocket, OneOffStream, PersistentStream, FRAME_TYPE };
