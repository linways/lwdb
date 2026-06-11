import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function runCli(args, env) {
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      ['--no-warnings=ExperimentalWarning', 'bin/lwdb.mjs', ...args],
      { env: { ...process.env, LW_DB_NO_DAEMON: '1', ...env }, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => { stdout += c; });
    child.stderr.on('data', (c) => { stderr += c; });
    child.on('exit', (code) => resolve({ code, stdout, stderr }));
  });
}

test('annotate creates, lists, and removes a note via the CLI (local store)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'lwdb-annc-'));
  const env = { LW_DB_SQLITE: join(dir, 'lwdb.sqlite') };
  try {
    const add = await runCli(['annotate', 'S', 'D', 'students', '--note=one row per enrolled student'], env);
    assert.equal(add.code, 0, add.stdout + add.stderr);
    assert.equal(JSON.parse(add.stdout).note, 'one row per enrolled student');

    const addCol = await runCli(['annotate', 'S', 'D', 'students', 'status', '--note=1=active 2=archived'], env);
    assert.equal(addCol.code, 0, addCol.stdout + addCol.stderr);

    const list = await runCli(['annotations', 'S', 'D'], env);
    assert.equal(list.code, 0);
    assert.equal(JSON.parse(list.stdout).length, 2);

    const rm = await runCli(['annotate', 'S', 'D', 'students', '--rm'], env);
    assert.equal(rm.code, 0, rm.stdout + rm.stderr);

    const list2 = await runCli(['annotations', 'S', 'D'], env);
    assert.equal(JSON.parse(list2.stdout).length, 1, 'table note removed, column note remains');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('annotate without --note or --rm is an error', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'lwdb-annc-'));
  try {
    const { code, stdout } = await runCli(['annotate', 'S', 'D', 'students'], { LW_DB_SQLITE: join(dir, 'lwdb.sqlite') });
    assert.notEqual(code, 0);
    assert.match(JSON.parse(stdout).error.message, /note/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
