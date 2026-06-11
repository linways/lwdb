import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

import { openDb } from '../server/lib/db.mjs';

function runCli(args, env) {
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      ['--no-warnings=ExperimentalWarning', 'bin/lwdb.mjs', ...args],
      { env: { ...process.env, LW_DB_NO_DAEMON: '1', ...env }, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let stdout = '';
    child.stdout.on('data', (c) => { stdout += c; });
    child.on('exit', (code) => resolve({ code, stdout }));
  });
}

test('secure status reports the key source and an encrypted password count', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'lwdb-seccli-'));
  const sqlite = join(dir, 'lwdb.sqlite');
  const env = { LW_DB_SQLITE: sqlite, LW_DB_KEY: randomBytes(32).toString('base64') };
  try {
    await runCli(['conn-add', '--label=Prod', '--host=db', '--user=root', '--password=secret'], env);

    // Stored column must be ciphertext, not the plaintext.
    const db = await openDb(sqlite);
    const raw = db.prepare('SELECT password FROM connections LIMIT 1').get().password;
    db.close();
    assert.ok(raw.startsWith('enc:1:'), `expected ciphertext at rest, got: ${raw}`);
    assert.ok(!raw.includes('secret'));

    const { code, stdout } = await runCli(['secure', 'status'], env);
    assert.equal(code, 0, stdout);
    const status = JSON.parse(stdout);
    assert.equal(status.keySource, 'env');
    assert.equal(status.encrypted, 1);
    assert.equal(status.plaintext, 0);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('secure migrate re-encrypts a legacy plaintext row', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'lwdb-seccli-'));
  const sqlite = join(dir, 'lwdb.sqlite');
  const env = { LW_DB_SQLITE: sqlite, LW_DB_KEY: randomBytes(32).toString('base64') };
  try {
    // Seed a legacy plaintext row directly (simulating a pre-encryption DB).
    const db = await openDb(sqlite);
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO connections (id, label, kind, host, port, user, password, sort_order, write_protected, created_at, updated_at)
       VALUES ('old','Old','remote','db',3306,'root','plainpw',0,0,?,?)`,
    ).run(now, now);
    db.close();

    let { stdout } = await runCli(['secure', 'status'], env);
    assert.equal(JSON.parse(stdout).plaintext, 1);

    ({ stdout } = await runCli(['secure', 'migrate'], env));
    assert.equal(JSON.parse(stdout).migrated, 1);

    ({ stdout } = await runCli(['secure', 'status'], env));
    const after = JSON.parse(stdout);
    assert.equal(after.plaintext, 0);
    assert.equal(after.encrypted, 1);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
