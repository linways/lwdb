import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

import { loadMasterKey } from '../server/lib/masterKey.mjs';

async function withEnv(env, fn) {
  const saved = {};
  for (const k of Object.keys(env)) { saved[k] = process.env[k]; if (env[k] === undefined) delete process.env[k]; else process.env[k] = env[k]; }
  try { return await fn(); }
  finally { for (const k of Object.keys(env)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } }
}

test('generates a 32-byte key and persists it 0600 when the file is absent', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'lwdb-key-'));
  const keyFile = join(dir, 'key');
  try {
    await withEnv({ LW_DB_KEY: undefined, LW_DB_KEY_FILE: keyFile }, async () => {
      const { key, source, path, created } = loadMasterKey();
      assert.equal(key.length, 32);
      assert.equal(source, 'file');
      assert.equal(path, keyFile);
      assert.equal(created, true);
      assert.ok(existsSync(keyFile));
      const mode = (await stat(keyFile)).mode & 0o777;
      assert.equal(mode, 0o600, `key file must be 0600, got ${mode.toString(8)}`);
    });
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('reuses an existing key file (stable across calls)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'lwdb-key-'));
  const keyFile = join(dir, 'key');
  try {
    await withEnv({ LW_DB_KEY: undefined, LW_DB_KEY_FILE: keyFile }, async () => {
      const first = loadMasterKey().key;
      const onDisk = (await readFile(keyFile, 'utf8')).trim();
      const second = loadMasterKey();
      assert.equal(second.created, undefined);
      assert.ok(first.equals(second.key));
      assert.equal(second.key.toString('base64'), onDisk);
    });
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('an inline LW_DB_KEY (base64) wins and touches no file', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'lwdb-key-'));
  const keyFile = join(dir, 'key');
  const inline = randomBytes(32).toString('base64');
  try {
    await withEnv({ LW_DB_KEY: inline, LW_DB_KEY_FILE: keyFile }, () => {
      const { key, source } = loadMasterKey();
      assert.equal(source, 'env');
      assert.equal(key.toString('base64'), inline);
      assert.equal(existsSync(keyFile), false, 'env key must not create a file');
    });
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('a malformed LW_DB_KEY is rejected', async () => {
  await withEnv({ LW_DB_KEY: 'not-32-bytes', LW_DB_KEY_FILE: undefined }, () => {
    assert.throws(() => loadMasterKey(), /32 bytes/);
  });
});
