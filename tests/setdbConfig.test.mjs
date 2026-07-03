// tests/setdbConfig.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findSetdbConfig } from '../server/lib/setdbConfig.mjs';

test('findSetdbConfig walks up and merges defaults', async () => {
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

test('findSetdbConfig returns null when absent', async () => {
  const base = await mkdtemp(join(tmpdir(), 'setdb-none-'));
  assert.equal(await findSetdbConfig(base), null);
  await rm(base, { recursive: true, force: true });
});
