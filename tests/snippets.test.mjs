import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { extractParams, bindParams, SnippetStore } from '../server/lib/snippets.mjs';
import { openDb } from '../server/lib/db.mjs';

test('extractParams returns unique ordered params', () => {
  assert.deepEqual(
    extractParams('SELECT * FROM t WHERE a = :id AND b = :id AND c = :name'),
    ['id', 'name'],
  );
});

test('bindParams substitutes placeholders and binds args', () => {
  const { sql, args } = bindParams('SELECT * FROM t WHERE a = :id AND b = :name', { id: 1, name: 'x' });
  assert.equal(sql, 'SELECT * FROM t WHERE a = ? AND b = ?');
  assert.deepEqual(args, [1, 'x']);
});

test('bindParams throws when value missing', () => {
  assert.throws(() => bindParams('SELECT :a', {}), { code: 'MISSING_PARAM' });
});

test('bindParams with like_contains rewrites = to LIKE and wraps with %', () => {
  const { sql, args } = bindParams(
    'SELECT * FROM t WHERE name = :name AND trashed IS NULL',
    { name: 'foo' },
    { name: 'like_contains' },
  );
  assert.equal(sql, 'SELECT * FROM t WHERE name LIKE ? AND trashed IS NULL');
  assert.deepEqual(args, ['%foo%']);
});

test('bindParams with like keeps user-provided wildcards untouched', () => {
  const { sql, args } = bindParams(
    'SELECT * FROM t WHERE name = :name',
    { name: 'foo%' },
    { name: 'like' },
  );
  assert.equal(sql, 'SELECT * FROM t WHERE name LIKE ?');
  assert.deepEqual(args, ['foo%']);
});

test('bindParams without operator override is unchanged', () => {
  const { sql, args } = bindParams('WHERE a = :a', { a: 1 });
  assert.equal(sql, 'WHERE a = ?');
  assert.deepEqual(args, [1]);
});

test('bindParams operator override only rewrites adjacent comparison', () => {
  // The `= :other` should NOT be touched when overriding `:name`.
  const { sql, args } = bindParams(
    'WHERE name = :name AND other = :other',
    { name: 'foo', other: 42 },
    { name: 'like_contains' },
  );
  assert.equal(sql, 'WHERE name LIKE ? AND other = ?');
  assert.deepEqual(args, ['%foo%', 42]);
});

test('bindParams rejects unknown operator', () => {
  assert.throws(
    () => bindParams('WHERE a = :a', { a: 1 }, { a: 'fuzzy_match' }),
    { code: 'BAD_REQUEST' },
  );
});

async function withStore(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'lwdb-snip-'));
  const db = await openDb(join(dir, 'lwdb.sqlite'));
  const store = new SnippetStore(db);
  try { await fn(store); } finally { db.close(); await rm(dir, { recursive: true, force: true }); }
}

test('SnippetStore CRUD', async () => {
  await withStore((store) => {
    const created = store.create({ name: 'one', sql: 'SELECT :a' });
    assert.equal(created.name, 'one');
    assert.deepEqual(created.params, ['a']);

    const list = store.list();
    assert.equal(list.length, 1);

    const updated = store.update(created.id, { description: 'desc' });
    assert.equal(updated.description, 'desc');

    assert.equal(store.remove(created.id), true);
    assert.equal(store.list().length, 0);
  });
});

test('SnippetStore.bulkUpsert dedupes by name', async () => {
  await withStore((store) => {
    store.bulkUpsert([
      { name: 'q1', sql: 'SELECT 1' },
      { name: 'q2', sql: 'SELECT 2' },
    ]);
    assert.equal(store.list().length, 2);

    const second = store.bulkUpsert([
      { name: 'q1', sql: 'SELECT 100' },     // updates
      { name: 'q3', sql: 'SELECT 3' },        // creates
      { name: '',   sql: 'SELECT 4' },        // skipped (no name)
    ]);
    assert.equal(second.find((r) => r.name === 'q1').status, 'updated');
    assert.equal(second.find((r) => r.name === 'q3').status, 'created');
    assert.equal(store.list().length, 3);
    assert.equal(store.findByName('q1').sql, 'SELECT 100');
  });
});
