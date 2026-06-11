import test from 'node:test';
import assert from 'node:assert/strict';

import { ApprovalQueue } from '../server/lib/approvals.mjs';

const REQ = { server: 'V4-prod', db: 'app', sql: 'UPDATE students SET status=1 WHERE id=42' };

test('create returns a pending approval that shows up in the pending list', () => {
  const q = new ApprovalQueue();
  const a = q.create(REQ);
  assert.match(a.id, /^apr_/);
  assert.equal(a.status, 'pending');
  assert.equal(a.sql, REQ.sql);
  assert.ok(a.requestedAt);
  assert.deepEqual(q.list().map((x) => x.id), [a.id]);
});

test('approve runs the query via the injected runner and stores its result', async () => {
  const q = new ApprovalQueue();
  const a = q.create(REQ);
  const calls = [];
  const runner = async (item) => { calls.push(item); return { rowCount: 1, verb: 'UPDATE' }; };

  const resolved = await q.resolve(a.id, 'approve', runner);
  assert.equal(resolved.status, 'approved');
  assert.deepEqual(resolved.result, { rowCount: 1, verb: 'UPDATE' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].sql, REQ.sql, 'runner receives the exact approved statement');

  // resolved approvals leave the pending list; get() still returns the outcome
  assert.deepEqual(q.list(), []);
  assert.equal(q.get(a.id).status, 'approved');
  assert.deepEqual(q.get(a.id).result, { rowCount: 1, verb: 'UPDATE' });
});

test('deny marks it denied and never calls the runner', async () => {
  const q = new ApprovalQueue();
  const a = q.create(REQ);
  let called = false;
  const resolved = await q.resolve(a.id, 'deny', async () => { called = true; });
  assert.equal(resolved.status, 'denied');
  assert.equal(called, false);
  assert.equal(q.get(a.id).status, 'denied');
});

test('a runner failure is captured as status "error" with the stable code', async () => {
  const q = new ApprovalQueue();
  const a = q.create(REQ);
  const runner = async () => { throw Object.assign(new Error('connection is write-protected'), { code: 'READONLY_BLOCKED' }); };
  const resolved = await q.resolve(a.id, 'approve', runner);
  assert.equal(resolved.status, 'error');
  assert.equal(resolved.error.code, 'READONLY_BLOCKED');
  assert.match(resolved.error.message, /write-protected/);
});

test('resolving an unknown id throws NOT_FOUND', async () => {
  const q = new ApprovalQueue();
  await assert.rejects(() => q.resolve('apr_nope', 'approve', async () => {}), (e) => e.code === 'NOT_FOUND');
});

test('resolving an already-resolved approval throws CONFLICT (no double-execute)', async () => {
  const q = new ApprovalQueue();
  const a = q.create(REQ);
  await q.resolve(a.id, 'approve', async () => ({ ok: true }));
  await assert.rejects(() => q.resolve(a.id, 'approve', async () => ({ ok: true })), (e) => e.code === 'CONFLICT');
});

test('an invalid decision is rejected', async () => {
  const q = new ApprovalQueue();
  const a = q.create(REQ);
  await assert.rejects(() => q.resolve(a.id, 'maybe', async () => {}), (e) => e.code === 'BAD_REQUEST');
});
