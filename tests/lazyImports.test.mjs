import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const TRACKER = join(process.cwd(), 'tests', 'fixtures', 'import-tracker.mjs');

function runCli(args, env) {
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      ['--no-warnings=ExperimentalWarning', '--import', TRACKER, 'bin/lwdb.mjs', ...args],
      { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => { stdout += c; });
    child.stderr.on('data', (c) => { stderr += c; });
    child.on('exit', (code) => resolve({ code, stdout, stderr }));
  });
}

test('lwdb --help loads neither mysql2 nor the SQLite registry', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'lwdb-lazy-'));
  const importLog = join(dir, 'imports.log');
  const sqlitePath = join(dir, 'lwdb.sqlite');
  try {
    const { code, stdout } = await runCli(['--help'], {
      LWDB_IMPORT_LOG: importLog,
      LW_DB_SQLITE: sqlitePath,
    });
    assert.equal(code, 0);
    assert.match(stdout, /lwdb CLI/);
    const imports = await readFile(importLog, 'utf8');
    assert.ok(!imports.includes('mysql2'), `--help must not load mysql2; imports were:\n${imports}`);
    assert.equal(existsSync(sqlitePath), false, '--help must not open the SQLite registry');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('mysql2 still loads when a command actually needs MySQL (tracker positive control)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'lwdb-lazy-'));
  const importLog = join(dir, 'imports.log');
  try {
    // conn-test against a dead port: the connect fails, but mysql2 must have loaded.
    await runCli(['conn-test', '--host=127.0.0.1', '--port=1', '--user=x'], {
      LWDB_IMPORT_LOG: importLog,
      LW_DB_SQLITE: join(dir, 'lwdb.sqlite'),
      LW_DB_NO_DAEMON: '1',
    });
    const imports = await readFile(importLog, 'utf8');
    assert.ok(imports.includes('mysql2'), `conn-test should load mysql2; imports were:\n${imports}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
