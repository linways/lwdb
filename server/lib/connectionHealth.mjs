/**
 * Per-server connection health tracker.
 *
 * Keeps an EWMA of successful connect times so subsequent attempts can use a
 * tighter (or looser) timeout than the global default. Also tracks consecutive
 * failures for surfacing a "this server keeps failing" hint in the UI.
 *
 * No persistence — health is per-process. Resets on restart.
 */

const TRANSIENT_ERROR_CODES = new Set([
  'ECONNRESET',
  'PROTOCOL_CONNECTION_LOST',
  'ETIMEDOUT',
  'EAI_AGAIN',
  'TIMEOUT', // our own appError code
]);

export function isTransientError(err) {
  if (!err) return false;
  if (TRANSIENT_ERROR_CODES.has(err.code)) return true;
  if (err.cause && TRANSIENT_ERROR_CODES.has(err.cause.code)) return true;
  return false;
}

export class ConnectionHealth {
  constructor({ baseTimeoutMs = 4000, minTimeoutMs = 1500, maxTimeoutMs = 12_000, alpha = 0.3 } = {}) {
    this.baseTimeoutMs = baseTimeoutMs;
    this.minTimeoutMs = minTimeoutMs;
    this.maxTimeoutMs = maxTimeoutMs;
    this.alpha = alpha;
    this.state = new Map(); // id -> { ewmaMs, lastOk, lastFail, consecutiveFailures, lastError, attempts }
  }

  _entry(id) {
    if (!this.state.has(id)) {
      this.state.set(id, {
        ewmaMs: null,
        lastOk: null,
        lastFail: null,
        consecutiveFailures: 0,
        lastError: null,
        attempts: 0,
      });
    }
    return this.state.get(id);
  }

  recordSuccess(id, durationMs) {
    const e = this._entry(id);
    e.attempts++;
    e.lastOk = new Date().toISOString();
    e.consecutiveFailures = 0;
    e.lastError = null;
    e.ewmaMs = e.ewmaMs === null
      ? durationMs
      : Math.round(this.alpha * durationMs + (1 - this.alpha) * e.ewmaMs);
  }

  recordFailure(id, err) {
    const e = this._entry(id);
    e.attempts++;
    e.lastFail = new Date().toISOString();
    e.consecutiveFailures++;
    e.lastError = err?.message || String(err);
  }

  /**
   * Compute the timeout to use for the next attempt against this server.
   * Strategy: base when we know nothing, otherwise 2.5x the EWMA clamped to [min, max].
   * If the server has been failing repeatedly, give it a longer window so we don't
   * pile up failures on transient issues.
   */
  timeoutFor(id) {
    const e = this.state.get(id);
    if (!e || e.ewmaMs === null) return this.baseTimeoutMs;
    let timeout = Math.round(e.ewmaMs * 2.5);
    if (e.consecutiveFailures > 0) {
      timeout = Math.max(timeout, this.baseTimeoutMs * (1 + Math.min(e.consecutiveFailures, 3) * 0.5));
    }
    return Math.min(this.maxTimeoutMs, Math.max(this.minTimeoutMs, timeout));
  }

  shouldRetry(id) {
    const e = this.state.get(id);
    // First failure → retry. After 2+ failures in a row, don't auto-retry to avoid pile-up.
    return !e || e.consecutiveFailures <= 1;
  }

  snapshot() {
    const out = {};
    for (const [id, e] of this.state) {
      out[id] = {
        ...e,
        nextTimeoutMs: this.timeoutFor(id),
      };
    }
    return out;
  }
}
