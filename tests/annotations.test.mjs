import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openDb } from '../server/lib/db.mjs';
import { AnnotationStore } from '../server/lib/annotations.mjs';
import { buildContext } from '../server/lib/context.mjs';

async function freshStore() {
  const dir = await mkdtemp(join(tmpdir(), 'lwdb-ann-'));
  const db = await openDb(join(dir, 'lwdb.sqlite'));
  return { store: new AnnotationStore(db), cleanup: () => rm(dir, { recursive: true, force: true }) };
}

test('upsert creates a table annotation and updates it on the same target', async () => {
  const { store, cleanup } = await freshStore();
  try {
    const a = store.upsert({ server: 'S', db: 'D', tbl: 'students', note: 'one row per enrolled student' });
    assert.equal(a.tbl, 'students');
    assert.equal(a.col, null);
    assert.equal(a.note, 'one row per enrolled student');

    const b = store.upsert({ server: 'S', db: 'D', tbl: 'students', note: 'updated note', source: 'agent' });
    assert.equal(b.id, a.id, 'same target upserts in place');
    assert.equal(b.note, 'updated note');
    assert.equal(store.list({ server: 'S', db: 'D' }).length, 1);
  } finally { await cleanup(); }
});

test('column annotations are separate targets from their table', async () => {
  const { store, cleanup } = await freshStore();
  try {
    store.upsert({ server: 'S', db: 'D', tbl: 'students', note: 'table note' });
    store.upsert({ server: 'S', db: 'D', tbl: 'students', col: 'status', note: '1=active 2=archived' });
    const list = store.list({ server: 'S', db: 'D', tbl: 'students' });
    assert.equal(list.length, 2);
  } finally { await cleanup(); }
});

test('list filters by server/db and remove deletes', async () => {
  const { store, cleanup } = await freshStore();
  try {
    store.upsert({ server: 'S', db: 'D', tbl: 't1', note: 'n1' });
    store.upsert({ server: 'S', db: 'OTHER', tbl: 't2', note: 'n2' });
    assert.equal(store.list({ server: 'S', db: 'D' }).length, 1);
    assert.equal(store.list({ server: 'S' }).length, 2);

    const ok = store.remove({ server: 'S', db: 'D', tbl: 't1' });
    assert.equal(ok, true);
    assert.equal(store.list({ server: 'S' }).length, 1);
    assert.equal(store.remove({ server: 'S', db: 'D', tbl: 'missing' }), false);
  } finally { await cleanup(); }
});

test('upsert validates required fields', async () => {
  const { store, cleanup } = await freshStore();
  try {
    assert.throws(() => store.upsert({ server: 'S', db: 'D', tbl: 'students', note: '' }), /note/);
    assert.throws(() => store.upsert({ server: 'S', db: 'D', note: 'x' }), /tbl/);
  } finally { await cleanup(); }
});

// ---------- context merge ----------

test('buildContext merges table and column annotations as comments', () => {
  const ctx = buildContext({
    server: 'S', db: 'D',
    tables: [{ name: 'students', rowsApprox: 10, comment: 'engine comment' }],
    columns: [
      { tbl: 'students', name: 'status', type: 'tinyint', nullable: 'NO', keyKind: '', defaultValue: null, extra: '', comment: '' },
    ],
    fks: [],
    annotations: [
      { server: 'S', db: 'D', tbl: 'students', col: null, note: 'one row per enrolled student' },
      { server: 'S', db: 'D', tbl: 'students', col: 'status', note: '1=active 2=archived' },
    ],
  });
  assert.equal(ctx.tables.students.comment, 'engine comment; one row per enrolled student');
  assert.deepEqual(ctx.tables.students.columns, ['status tinyint nn // 1=active 2=archived']);
});
