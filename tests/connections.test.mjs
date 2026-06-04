import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openDb } from '../server/lib/db.mjs';
import {
  ConnectionStore, safeConnection, slugify, deriveKind, normalizeId,
} from '../server/lib/connectionStore.mjs';

async function freshStore() {
  const dir = await mkdtemp(join(tmpdir(), 'lwdb-conn-'));
  const db = await openDb(join(dir, 'lwdb.sqlite'));
  return { store: new ConnectionStore(db), cleanup: () => rm(dir, { recursive: true, force: true }) };
}

test('slugify lowercases and dashes non-alphanumerics', () => {
  assert.equal(slugify('V4 · Server 84'), 'v4-server-84');
  assert.equal(slugify('Local DB!!'), 'local-db');
  assert.equal(slugify(''), 'connection');
});

test('normalizeId preserves case, sanitizes invalid chars', () => {
  assert.equal(normalizeId('V4-server84'), 'V4-server84');
  assert.equal(normalizeId('V3-server63'), 'V3-server63');
  assert.equal(normalizeId('My Conn!'), 'My-Conn');
  assert.equal(normalizeId(''), 'connection');
});

test('create preserves an explicit id verbatim (case kept)', async () => {
  const { store, cleanup } = await freshStore();
  try {
    const c = store.create({ id: 'V4-server84', label: 'V4 Server 84', host: '127.0.0.1', port: 3381, user: 'merge' });
    assert.equal(c.id, 'V4-server84');     // NOT lowercased
  } finally { await cleanup(); }
});

test('create without an id slugifies the label (lowercase)', async () => {
  const { store, cleanup } = await freshStore();
  try {
    const c = store.create({ label: 'V4 Server 84', host: 'h', user: 'u' });
    assert.equal(c.id, 'v4-server-84');    // label-derived → slug
  } finally { await cleanup(); }
});

test('bulkUpsert preserves explicit ids verbatim and stays idempotent', async () => {
  const { store, cleanup } = await freshStore();
  try {
    const items = [{ id: 'V4-server84', label: 'x', host: 'h', user: 'u', password: 'p' }];
    assert.equal(store.bulkUpsert(items)[0].status, 'created');
    assert.equal(store.bulkUpsert(items)[0].status, 'updated'); // same id → update, not duplicate
    assert.equal(store.all().length, 1);
    assert.equal(store.get('V4-server84').id, 'V4-server84');
  } finally { await cleanup(); }
});

test('deriveKind: only localhost is local', () => {
  assert.equal(deriveKind('localhost'), 'local');
  assert.equal(deriveKind('127.0.0.1'), 'remote');
  assert.equal(deriveKind('db.example.com'), 'remote');
  assert.equal(deriveKind('127.0.0.1', 'local'), 'local'); // explicit override wins
});

test('safeConnection strips password', () => {
  const safe = safeConnection({ id: 'x', host: 'h', port: 1, user: 'u', password: 'pw' });
  assert.equal(safe.password, undefined);
  assert.equal(safe.hasPassword, true);
});

test('ConnectionStore.create derives id, kind, defaults', async () => {
  const { store, cleanup } = await freshStore();
  try {
    const c = store.create({ label: 'V4 Server 84', host: '127.0.0.1', port: 3384, user: 'merge', password: 'secret' });
    assert.equal(c.id, 'v4-server-84');
    assert.equal(c.kind, 'remote');
    assert.equal(c.port, 3384);
    const local = store.create({ label: 'Local', host: 'localhost', user: 'root' });
    assert.equal(local.kind, 'local');
    assert.equal(local.port, 3306); // default
  } finally { await cleanup(); }
});

test('ConnectionStore.create dedupes slug collisions', async () => {
  const { store, cleanup } = await freshStore();
  try {
    const a = store.create({ label: 'Dup', host: 'h1', user: 'u' });
    const b = store.create({ label: 'Dup', host: 'h2', user: 'u' });
    assert.equal(a.id, 'dup');
    assert.equal(b.id, 'dup-2');
  } finally { await cleanup(); }
});

test('ConnectionStore.all sorts local-first then label', async () => {
  const { store, cleanup } = await freshStore();
  try {
    store.create({ label: 'Zebra', host: 'h', user: 'u' });
    store.create({ label: 'Apple', host: 'h', user: 'u' });
    store.create({ label: 'Home', host: 'localhost', user: 'root' });
    const ids = store.all().map((c) => c.id);
    assert.deepEqual(ids, ['home', 'apple', 'zebra']);
  } finally { await cleanup(); }
});

test('ConnectionStore.update patches and preserves absent password', async () => {
  const { store, cleanup } = await freshStore();
  try {
    const c = store.create({ label: 'Edit', host: 'localhost', user: 'root', password: 'keepme' });
    const u = store.update(c.id, { label: 'Edited', host: 'remote.example' });
    assert.equal(u.label, 'Edited');
    assert.equal(u.kind, 'remote');     // host change recomputes kind
    assert.equal(u.password, 'keepme'); // password not in patch → preserved
  } finally { await cleanup(); }
});

test('ConnectionStore.delete removes the row', async () => {
  const { store, cleanup } = await freshStore();
  try {
    const c = store.create({ label: 'Bye', host: 'h', user: 'u' });
    assert.equal(store.delete(c.id), true);
    assert.equal(store.get(c.id), null);
    assert.equal(store.delete('nope'), false);
  } finally { await cleanup(); }
});

test('ConnectionStore.bulkUpsert is idempotent by id', async () => {
  const { store, cleanup } = await freshStore();
  try {
    const items = [{ id: 'server-84', label: 'S84', host: '127.0.0.1', port: 3384, user: 'm', password: 'p' }];
    const r1 = store.bulkUpsert(items);
    assert.equal(r1[0].status, 'created');
    const r2 = store.bulkUpsert(items);
    assert.equal(r2[0].status, 'updated');
    assert.equal(store.all().length, 1);
  } finally { await cleanup(); }
});

test('ConnectionStore.exportAll round-trips through bulkUpsert', async () => {
  const { store, cleanup } = await freshStore();
  try {
    store.create({ label: 'A', host: 'localhost', user: 'root', password: 'pw', color: '#e23', group: 'prod', notes: 'n' });
    const doc = store.exportAll();
    assert.equal(doc.version, 1);
    assert.equal(doc.connections[0].password, 'pw');
    assert.equal(doc.connections[0].group, 'prod');
    assert.equal(doc.connections[0].sortOrder, 0);
  } finally { await cleanup(); }
});
