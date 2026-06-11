import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openDb } from '../server/lib/db.mjs';
import { ConnectionStore, safeConnection } from '../server/lib/connectionStore.mjs';
import { runQuery } from '../server/lib/runQuery.mjs';

async function freshStore() {
  const dir = await mkdtemp(join(tmpdir(), 'lwdb-wp-'));
  const db = await openDb(join(dir, 'lwdb.sqlite'));
  return { store: new ConnectionStore(db), cleanup: () => rm(dir, { recursive: true, force: true }) };
}

test('connections default to not write-protected', async () => {
  const { store, cleanup } = await freshStore();
  try {
    const c = store.create({ label: 'Dev', host: 'localhost', user: 'root' });
    assert.equal(c.writeProtected, false);
    assert.equal(safeConnection(c).writeProtected, false, 'survives password stripping');
  } finally { await cleanup(); }
});

test('writeProtected round-trips through create, update, and export', async () => {
  const { store, cleanup } = await freshStore();
  try {
    const c = store.create({ id: 'V4-prod', label: 'V4 Prod', host: 'db.example.com', user: 'root', writeProtected: true });
    assert.equal(c.writeProtected, true);
    assert.equal(store.get('V4-prod').writeProtected, true);

    const cleared = store.update('V4-prod', { writeProtected: false });
    assert.equal(cleared.writeProtected, false);

    store.update('V4-prod', { writeProtected: true });
    const doc = store.exportAll();
    assert.equal(doc.connections.find((x) => x.id === 'V4-prod').writeProtected, true);
  } finally { await cleanup(); }
});

test('runQuery refuses a write on a write-protected connection even when writable=true', async () => {
  await assert.rejects(
    () => runQuery({
      connection: { id: 'V4-prod', writeProtected: true },
      sql: 'DELETE FROM students WHERE id = 1',
      writable: true,
      config: {},
    }),
    (e) => e.code === 'READONLY_BLOCKED' && /write-protected/i.test(e.message),
  );
});
