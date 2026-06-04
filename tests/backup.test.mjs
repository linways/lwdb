import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openDb } from '../server/lib/db.mjs';
import { SnippetStore } from '../server/lib/snippets.mjs';
import { HistoryStore } from '../server/lib/history.mjs';
import { PreferenceStore } from '../server/lib/preferences.mjs';
import { backupJson, backupSqlite, restoreJson } from '../server/lib/backup.mjs';

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'lwdb-bk-'));
  const dbPath = join(dir, 'lwdb.sqlite');
  const db = await openDb(dbPath);
  const snippets = new SnippetStore(db);
  const history = new HistoryStore(db);
  const preferences = new PreferenceStore(db);
  snippets.create({ name: 'a', sql: 'SELECT 1' });
  preferences.set('theme', 'dark');
  return {
    dir, dbPath, db,
    registry: { dataDir: dir, dbPath, db, snippets, history, preferences },
    cleanup: async () => { db.close(); await rm(dir, { recursive: true, force: true }); },
  };
}

test('backupJson + restoreJson round-trip', async () => {
  const fx = await fixture();
  try {
    const info = await backupJson(fx.registry, join(fx.dir, 'b.json'));
    assert.ok(existsSync(info.path));

    // mutate state
    const snippets = fx.registry.snippets;
    snippets.create({ name: 'b', sql: 'SELECT 2' });
    assert.equal(snippets.list().length, 2);

    const { default: fs } = await import('node:fs/promises');
    const payload = JSON.parse(await fs.readFile(info.path, 'utf8'));
    await restoreJson(fx.registry, payload, { merge: false });

    assert.equal(snippets.list().length, 1);
    assert.equal(snippets.list()[0].name, 'a');
  } finally {
    await fx.cleanup();
  }
});

test('backupJson merge preserves existing snippets', async () => {
  const fx = await fixture();
  try {
    const info = await backupJson(fx.registry, join(fx.dir, 'b.json'));
    fx.registry.snippets.create({ name: 'b', sql: 'SELECT 2' });

    const { default: fs } = await import('node:fs/promises');
    const payload = JSON.parse(await fs.readFile(info.path, 'utf8'));
    await restoreJson(fx.registry, payload, { merge: true });

    // 'a' and 'b' both present (merge adds backup's 'a' on top, but it already exists)
    const names = fx.registry.snippets.list().map((s) => s.name).sort();
    assert.deepEqual(names, ['a', 'b']);
  } finally {
    await fx.cleanup();
  }
});

test('backupSqlite produces a valid sqlite file', async () => {
  const fx = await fixture();
  try {
    const out = join(fx.dir, 'snap.sqlite');
    const info = await backupSqlite(fx.registry, out);
    assert.ok(existsSync(info.path));
    assert.ok(info.bytes > 0);

    // open the snapshot and verify content
    const snap = await openDb(out);
    const row = snap.prepare('SELECT name FROM snippets WHERE name = ?').get('a');
    assert.equal(row.name, 'a');
    snap.close();
  } finally {
    await fx.cleanup();
  }
});

test('restoreJson rejects non-lwdb payloads', async () => {
  const fx = await fixture();
  try {
    await assert.rejects(restoreJson(fx.registry, { tool: 'not-lwdb' }), /Not a lwdb backup/);
  } finally {
    await fx.cleanup();
  }
});
