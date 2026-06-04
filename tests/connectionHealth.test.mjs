import test from 'node:test';
import assert from 'node:assert/strict';
import { ConnectionHealth, isTransientError } from '../server/lib/connectionHealth.mjs';

test('first attempt uses base timeout', () => {
  const h = new ConnectionHealth({ baseTimeoutMs: 4000, minTimeoutMs: 1500, maxTimeoutMs: 12000 });
  assert.equal(h.timeoutFor('srv'), 4000);
});

test('EWMA tightens timeout after fast successes', () => {
  const h = new ConnectionHealth({ baseTimeoutMs: 4000, minTimeoutMs: 1500, maxTimeoutMs: 12000, alpha: 0.5 });
  h.recordSuccess('srv', 200);
  h.recordSuccess('srv', 200);
  h.recordSuccess('srv', 200);
  // 2.5x EWMA ~= 500 → clamped to min 1500
  assert.equal(h.timeoutFor('srv'), 1500);
});

test('EWMA expands timeout after slow successes', () => {
  const h = new ConnectionHealth({ baseTimeoutMs: 4000, minTimeoutMs: 1500, maxTimeoutMs: 12000, alpha: 0.5 });
  h.recordSuccess('srv', 3000);
  // 2.5x 3000 = 7500 within bounds
  assert.equal(h.timeoutFor('srv'), 7500);
});

test('consecutive failures extend timeout', () => {
  const h = new ConnectionHealth({ baseTimeoutMs: 4000, minTimeoutMs: 1500, maxTimeoutMs: 12000 });
  h.recordSuccess('srv', 500);
  h.recordFailure('srv', new Error('boom'));
  const t = h.timeoutFor('srv');
  assert.ok(t >= 6000, `expected >=6000, got ${t}`);
});

test('shouldRetry true on first failure, false after second', () => {
  const h = new ConnectionHealth();
  assert.equal(h.shouldRetry('srv'), true);
  h.recordFailure('srv', new Error('x'));
  assert.equal(h.shouldRetry('srv'), true);
  h.recordFailure('srv', new Error('y'));
  assert.equal(h.shouldRetry('srv'), false);
});

test('snapshot exposes state for diagnostics', () => {
  const h = new ConnectionHealth();
  h.recordSuccess('srv', 500);
  const snap = h.snapshot();
  assert.equal(snap.srv.ewmaMs, 500);
  assert.equal(snap.srv.consecutiveFailures, 0);
  assert.ok(snap.srv.nextTimeoutMs > 0);
});

test('isTransientError detects transient codes', () => {
  assert.equal(isTransientError({ code: 'ECONNRESET' }), true);
  assert.equal(isTransientError({ code: 'TIMEOUT' }), true);
  assert.equal(isTransientError({ code: 'ER_NO_SUCH_TABLE' }), false);
  assert.equal(isTransientError(null), false);
});
