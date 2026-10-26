import test from 'node:test';
import assert from 'node:assert/strict';
import { poolQuery } from '../server/lib/pool.mjs';

// A fake mysql2 pool whose query() fails `failTimes` with `code`, then succeeds.
function fakePool(code, failTimes = 1) {
  let calls = 0;
  return {
    calls: () => calls,
    query: async () => {
      calls++;
      if (calls <= failTimes) {
        const err = new Error(`fake ${code}`);
        err.code = code;
        throw err;
      }
      return [[{ ok: 1 }], []];
    },
  };
}

test('poolQuery retries once on a transient connection error (stale pooled conn)', async () => {
  // ECONNRESET is what an idle-dropped connection throws on next use.
  const pool = fakePool('ECONNRESET', 1);
  const [rows] = await poolQuery(pool, 'SHOW DATABASES');
  assert.deepEqual(rows, [{ ok: 1 }]);
  assert.equal(pool.calls(), 2, 'should have retried exactly once');
});

test('poolQuery does NOT retry a non-transient error', async () => {
  const pool = fakePool('ER_BAD_DB_ERROR', 1);
  await assert.rejects(() => poolQuery(pool, 'SHOW DATABASES'), /ER_BAD_DB_ERROR/);
  assert.equal(pool.calls(), 1, 'non-transient errors must not retry');
});

test('poolQuery retries at most once (gives up on persistent failure)', async () => {
  const pool = fakePool('ECONNRESET', 99);
  await assert.rejects(() => poolQuery(pool, 'SHOW DATABASES'));
  assert.equal(pool.calls(), 2, 'one original + one retry, then give up');
});

test('poolQuery with retry:false never retries (write-safety path)', async () => {
  const pool = fakePool('ECONNRESET', 1);
  await assert.rejects(() => poolQuery(pool, 'UPDATE t SET x=1', [], { retry: false }));
  assert.equal(pool.calls(), 1, 'writes must not auto-retry');
});
