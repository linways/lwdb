import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('lwdb serve starts the HTTP server and stops on SIGTERM', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'lwdb-serve-'));
  const port = 4399;
  const child = spawn(
    process.execPath,
    ['--no-warnings=ExperimentalWarning', 'bin/lwdb.mjs', 'serve'],
    { env: { ...process.env, LW_DB_SQLITE: join(dir, 'lwdb.sqlite'), LW_DB_PORT: String(port), LW_DB_LOG_LEVEL: 'warn' }, stdio: 'ignore' },
  );
  try {
    let ok = false;
    for (let i = 0; i < 60; i++) {
      try {
        const r = await fetch(`http://127.0.0.1:${port}/api/health`);
        if (r.ok) { const j = await r.json(); ok = j.ok === true; break; }
      } catch { /* not up yet */ }
      await new Promise((res) => setTimeout(res, 100));
    }
    assert.equal(ok, true, 'server responded ok on /api/health');
  } finally {
    child.kill('SIGTERM');
    await new Promise((res) => child.on('exit', res));
    await rm(dir, { recursive: true, force: true });
  }
});
