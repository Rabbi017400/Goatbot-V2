"use strict";

const { delay } = require("./utils");
const { typingTask } = require("./tasks");

const DEFAULT_SAFETY = {
  enabled: true,
  warmupMs: 3000,
  minActionDelayMs: 400,
  maxActionDelayMs: 1200,
  windowMs: 60000,
  maxActionsPerWindow: 25,
  maxBurstPerThreadPerWindow: 12,
  typing: true,
  typingMsPerChar: 45,
  typingMinMs: 350,
  typingMaxMs: 5000,
  presence: true,
  reconnectJitter: 0.3,
  circuitBreakerThreshold: 5,
  circuitBreakerCooldownMs: 120000,
};

const RATE_LIMIT_PATTERN = /limit|too (often|fast|many)|slow down|try again later|rate limit|temporar/i;

class Safety {
  constructor(client, options) {
    this.client = client;
    this.options = Object.assign({}, DEFAULT_SAFETY, options || {});
    this._tail = Promise.resolve();
    this._lastAction = 0;
    this._history = [];
    this._threadHistory = new Map();
    this._readyAt = this.options.enabled ? Date.now() + this.options.warmupMs : 0;
    this._breakerUntil = 0;
    this._rateLimitUntil = 0;
    this._consecutiveErrors = 0;
    this._stats = { actions: 0, waits: 0, rateLimited: 0, breakerTrips: 0, typing: 0 };
  }

  get enabled() {
    return this.options.enabled === true;
  }

  get presence() {
    return this.options.presence === true;
  }

  update(options) {
    const wasEnabled = this.enabled;
    Object.assign(this.options, options || {});
    if (!wasEnabled && this.enabled) this._readyAt = Date.now() + this.options.warmupMs;
    if (!this.enabled) {
      this._readyAt = 0;
      this._breakerUntil = 0;
      this._rateLimitUntil = 0;
      this._history = [];
      this._threadHistory.clear();
    }
    return this.options;
  }

  stats() {
    return Object.assign({}, this._stats, { breakerOpen: Math.max(this._breakerUntil, this._rateLimitUntil) > Date.now() });
  }

  acquire(threadID) {
    if (!this.enabled) return Promise.resolve();
    const label = threadID === undefined || threadID === null ? "" : String(threadID);
    const run = this._tail.then(() => this._gate(label));
    this._tail = run.then(() => undefined, () => undefined);
    return run;
  }

  async _gate(threadID) {
    await this._waitWarmup();
    await this._waitBreaker();
    await this._waitWindow(threadID);
    await this._waitPacing();
    const now = Date.now();
    this._lastAction = now;
    this._history.push(now);
    this._recordThread(threadID, now);
    this._stats.actions += 1;
  }

  async _waitWarmup() {
    if (!this._readyAt) return;
    const wait = this._readyAt - Date.now();
    if (wait > 0) {
      this._stats.waits += 1;
      await delay(wait);
    }
    this._readyAt = 0;
  }

  async _waitBreaker() {
    const wait = Math.max(this._breakerUntil, this._rateLimitUntil) - Date.now();
    if (wait > 0) {
      this._stats.waits += 1;
      await delay(wait);
      this._breakerUntil = 0;
      this._rateLimitUntil = 0;
      this._consecutiveErrors = 0;
    }
  }

  _pruneHistory(list, now) {
    const cutoff = now - this.options.windowMs;
    while (list.length && list[0] < cutoff) list.shift();
  }

  async _waitWindow(threadID) {
    const limit = this.options.maxActionsPerWindow;
    if (limit > 0) {
      for (;;) {
        const now = Date.now();
        this._pruneHistory(this._history, now);
        if (this._history.length < limit) break;
        const wait = this._history[0] + this.options.windowMs - now + 1;
        this._stats.waits += 1;
        this._stats.rateLimited += 1;
        await delay(Math.max(wait, 1));
      }
    }
    const perThread = this.options.maxBurstPerThreadPerWindow;
    if (perThread > 0 && threadID) {
      let list = this._threadHistory.get(threadID);
      if (!list) {
        list = [];
        this._threadHistory.set(threadID, list);
      }
      for (;;) {
        const now = Date.now();
        this._pruneHistory(list, now);
        if (list.length < perThread) break;
        const wait = list[0] + this.options.windowMs - now + 1;
        this._stats.waits += 1;
        this._stats.rateLimited += 1;
        await delay(Math.max(wait, 1));
      }
    }
  }

  async _waitPacing() {
    if (this._lastAction === 0) return;
    const min = this.options.minActionDelayMs;
    const max = Math.max(min, this.options.maxActionDelayMs);
    const gap = min + Math.floor(Math.random() * (max - min + 1));
    const wait = this._lastAction + gap - Date.now();
    if (wait > 0) {
      this._stats.waits += 1;
      await delay(wait);
    }
  }

  _recordThread(threadID, now) {
    if (!threadID) return;
    let list = this._threadHistory.get(threadID);
    if (!list) {
      list = [];
      this._threadHistory.set(threadID, list);
    }
    list.push(now);
  }

  async simulateTyping(threadID, text, isGroup) {
    if (!this.enabled || !this.options.typing) return;
    await this._waitWarmup();
    await this._waitBreaker();
    const length = String(text || "").length;
    let duration = this.options.typingMinMs + length * this.options.typingMsPerChar;
    duration = Math.min(this.options.typingMaxMs, Math.max(this.options.typingMinMs, duration));
    try {
      await this.client.sendStatelessTask(typingTask(Number(threadID), true, Boolean(isGroup)));
      this._stats.typing += 1;
      await delay(duration);
      await this.client.sendStatelessTask(typingTask(Number(threadID), false, Boolean(isGroup)));
    } catch (_) {
      /* typing is best-effort and must never break a send */
    }
  }

  noteResult(error) {
    if (!this.enabled) return;
    if (!error) {
      this._consecutiveErrors = 0;
      return;
    }
    const message = String((error && error.message) || error || "");
    if (RATE_LIMIT_PATTERN.test(message) || (error && error.status === 429)) {
      this._consecutiveErrors += 1;
      this._stats.rateLimited += 1;
      if (this._consecutiveErrors >= this.options.circuitBreakerThreshold) this._tripBreaker();
    }
  }

  noteRateLimit(retryAfterMs) {
    if (!this.enabled) return;
    const cooldown = this.options.circuitBreakerCooldownMs;
    const backoff = retryAfterMs > 0 ? Math.min(retryAfterMs, cooldown) : cooldown;
    this._rateLimitUntil = Math.max(this._rateLimitUntil, Date.now() + backoff);
  }

  _tripBreaker() {
    this._breakerUntil = Date.now() + this.options.circuitBreakerCooldownMs;
    this._consecutiveErrors = 0;
    this._stats.breakerTrips += 1;
  }

  jitterReconnect(ms) {
    if (!this.enabled) return ms;
    const factor = 1 + Math.random() * this.options.reconnectJitter;
    return Math.round(ms * factor);
  }
}

module.exports = { Safety, DEFAULT_SAFETY };
