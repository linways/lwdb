import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openDb } from '../server/lib/db.mjs';
import { HistoryStore } from '../server/lib/history.mjs';

async function freshHistory() {
  const dir = await mkdtemp(join(tmpdir(), 'lwdb-hist-'));
  const db = await openDb(join(dir, 'lwdb.sqlite'));
  return { history: new HistoryStore(db), cleanup: () => rm(dir, { recursive: true, force: true }) };
}

test('record stores the actor and recent returns it', async () => {
  const { history, cleanup } = await freshHistory();
  try {
    history.record({ server: 'S', sql: 'SELECT 1', verb: 'SELECT', actor: 'cli' });
    const [entry] = history.recent({ limit: 10 });
    assert.equal(entry.actor, 'cli');
  } finally { await cleanup(); }
});

test('actor defaults to "unknown" when not provided', async () => {
  const { history, cleanup } = await freshHistory();
  try {
    history.record({ server: 'S', sql: 'SELECT 1', verb: 'SELECT' });
    assert.equal(history.recent({ limit: 1 })[0].actor, 'unknown');
  } finally { await cleanup(); }
});

test('recent filters by actor', async () => {
  const { history, cleanup } = await freshHistory();
  try {
    history.record({ server: 'S', sql: 'SELECT 1', verb: 'SELECT', actor: 'ui' });
    history.record({ server: 'S', sql: 'SELECT 2', verb: 'SELECT', actor: 'mcp' });
    history.record({ server: 'S', sql: 'SELECT 3', verb: 'SELECT', actor: 'mcp' });
    const mcp = history.recent({ limit: 10, actor: 'mcp' });
    assert.equal(mcp.length, 2);
    assert.ok(mcp.every((e) => e.actor === 'mcp'));
    assert.equal(history.recent({ limit: 10, actor: 'ui' }).length, 1);
  } finally { await cleanup(); }
});
