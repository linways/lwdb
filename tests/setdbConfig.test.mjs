// tests/setdbConfig.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findSetdbConfig, resolveOutput } from '../server/lib/setdbConfig.mjs';

// Isolate ~/.lwdb so the home fallback is deterministic across tests.
async function withEmptyHome(fn) {
  const home = await mkdtemp(join(tmpdir(), 'lwdbhome-'));
  const prev = process.env.LWDB_HOME;
  process.env.LWDB_HOME = home;
  try { return await fn(home); }
  finally {
    if (prev === undefined) delete process.env.LWDB_HOME; else process.env.LWDB_HOME = prev;
    await rm(home, { recursive: true, force: true });
  }
}

test('findSetdbConfig walks up and merges defaults', async () => {
  await withEmptyHome(async () => {
    const base = await mkdtemp(join(tmpdir(), 'setdb-'));
    const sub = join(base, 'a', 'b');
    await mkdir(sub, { recursive: true });
    await writeFile(join(base, '.setdb.json'), JSON.stringify({ output: 'x.php' }), 'utf8');
    const found = await findSetdbConfig(sub);
    assert.equal(found.root, base);
    assert.equal(found.config.output, 'x.php');
    assert.equal(found.config.group, 'linways'); // default preserved
    assert.equal(found.config.verify, true);
    await rm(base, { recursive: true, force: true });
  });
});

test('findSetdbConfig returns null when no repo config and no home config', async () => {
  await withEmptyHome(async () => {
    const base = await mkdtemp(join(tmpdir(), 'setdb-none-'));
    assert.equal(await findSetdbConfig(base), null);
    await rm(base, { recursive: true, force: true });
  });
});

test('findSetdbConfig falls back to ~/.lwdb/setdb.json', async () => {
  await withEmptyHome(async (home) => {
    await writeFile(join(home, 'setdb.json'), JSON.stringify({ output: '/abs/active-db.php', group: 'linways' }), 'utf8');
    const base = await mkdtemp(join(tmpdir(), 'setdb-nohome-'));
    const found = await findSetdbConfig(base);
    assert.equal(found.root, home);
    assert.equal(found.config.output, '/abs/active-db.php');
    await rm(base, { recursive: true, force: true });
  });
});

test('resolveOutput: absolute wins, bare name joins root', () => {
  assert.equal(resolveOutput({ output: '/abs/active-db.php' }, '/anything'), '/abs/active-db.php');
  assert.equal(resolveOutput({ output: 'active-db.php' }, '/repo'), '/repo/active-db.php');
});
