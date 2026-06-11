import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

import { openDb } from '../server/lib/db.mjs';
import { ConnectionStore } from '../server/lib/connectionStore.mjs';
import { makeCodec, isEncrypted } from '../server/lib/secret.mjs';

async function freshDb() {
  const dir = await mkdtemp(join(tmpdir(), 'lwdb-enc-'));
  const db = await openDb(join(dir, 'lwdb.sqlite'));
  return { db, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

function rawPassword(db, id) {
  return db.prepare('SELECT password FROM connections WHERE id = ?').get(id).password;
}

test('passwords are ciphertext at rest but plaintext through the API', async () => {
  const { db, cleanup } = await freshDb();
  try {
    const store = new ConnectionStore(db, { secret: makeCodec(randomBytes(32)) });
    const c = store.create({ id: 'prod', label: 'Prod', host: 'db', user: 'root', password: 'hunter2' });
    assert.ok(isEncrypted(rawPassword(db, 'prod')), 'stored column is encrypted');
    assert.ok(!rawPassword(db, 'prod').includes('hunter2'));
    assert.equal(c.password, 'hunter2', 'returned object is decrypted for the pool');
    assert.equal(store.get('prod').password, 'hunter2');
  } finally { await cleanup(); }
});

test('an empty password is stored empty, not encrypted', async () => {
  const { db, cleanup } = await freshDb();
  try {
    const store = new ConnectionStore(db, { secret: makeCodec(randomBytes(32)) });
    store.create({ id: 'noauth', label: 'NoAuth', host: 'db', user: 'root' });
    assert.equal(rawPassword(db, 'noauth'), '');
  } finally { await cleanup(); }
});

test('default store (no codec) keeps the pre-encryption plaintext behavior', async () => {
  const { db, cleanup } = await freshDb();
  try {
    const store = new ConnectionStore(db);
    store.create({ id: 'legacy', label: 'L', host: 'db', user: 'root', password: 'plain' });
    assert.equal(rawPassword(db, 'legacy'), 'plain');
    assert.equal(store.get('legacy').password, 'plain');
  } finally { await cleanup(); }
});

test('legacy plaintext rows are readable, and migrate re-encrypts only them', async () => {
  const { db, cleanup } = await freshDb();
  try {
    const key = randomBytes(32);
    // Write a legacy plaintext row with the no-codec store, then reopen with a codec.
    new ConnectionStore(db).create({ id: 'old', label: 'Old', host: 'db', user: 'root', password: 'plainpw' });
    const store = new ConnectionStore(db, { secret: makeCodec(key) });
    store.create({ id: 'new', label: 'New', host: 'db', user: 'root', password: 'newpw' });

    assert.equal(store.get('old').password, 'plainpw', 'legacy row still readable');

    const before = store.auditEncryption();
    assert.equal(before.plaintext, 1);
    assert.equal(before.encrypted, 1);

    const { migrated } = store.migrateEncryption();
    assert.equal(migrated, 1, 'only the plaintext row is migrated');
    assert.ok(isEncrypted(rawPassword(db, 'old')));
    assert.equal(store.get('old').password, 'plainpw', 'still decrypts to the same value');

    const after = store.auditEncryption();
    assert.equal(after.plaintext, 0);
    assert.equal(after.encrypted, 2);
  } finally { await cleanup(); }
});

test('exportAll yields decrypted (portable) passwords', async () => {
  const { db, cleanup } = await freshDb();
  try {
    const store = new ConnectionStore(db, { secret: makeCodec(randomBytes(32)) });
    store.create({ id: 'e', label: 'E', host: 'db', user: 'root', password: 'portme' });
    const doc = store.exportAll();
    assert.equal(doc.connections.find((c) => c.id === 'e').password, 'portme');
  } finally { await cleanup(); }
});
