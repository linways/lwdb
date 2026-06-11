import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { presentedToken, isAuthorized } from '../server/lib/auth.mjs';
import { detectDaemon } from '../server/lib/daemonClient.mjs';

async function withTokenServer(token, fn) {
  const dir = await mkdtemp(join(tmpdir(), 'lwdb-auth-'));
  const port = 4480;
  const child = spawn(
    process.execPath,
    ['--no-warnings=ExperimentalWarning', 'bin/lwdb.mjs', 'serve'],
    { env: { ...process.env, LW_DB_SQLITE: join(dir, 'lwdb.sqlite'), LW_DB_PORT: String(port), LW_DB_TOKEN: token, LW_DB_LOG_LEVEL: 'silent' }, stdio: 'ignore' },
  );
  const base = `http://127.0.0.1:${port}`;
  try {
    for (let i = 0; i < 60; i++) {
      try { const r = await fetch(`${base}/api/health`, { headers: { authorization: `Bearer ${token}` } }); if (r.ok) break; } catch { /* not up */ }
      await new Promise((res) => setTimeout(res, 100));
    }
    await fn(base);
  } finally {
    child.kill('SIGTERM');
    await new Promise((res) => child.on('exit', res));
    await rm(dir, { recursive: true, force: true });
  }
}

test('presentedToken reads a Bearer header (case-insensitive)', () => {
  assert.equal(presentedToken({ headers: { authorization: 'Bearer s3cret' } }), 's3cret');
  assert.equal(presentedToken({ headers: { Authorization: 'bearer s3cret' } }), 's3cret');
});

test('presentedToken falls back to a ?token= query param (browser first-load)', () => {
  assert.equal(presentedToken({ query: { token: 'fromurl' } }), 'fromurl');
});

test('presentedToken returns null when nothing is presented', () => {
  assert.equal(presentedToken({ headers: {}, query: {} }), null);
  assert.equal(presentedToken({}), null);
});

test('isAuthorized: when no token is configured, everything is allowed (auth disabled)', () => {
  assert.equal(isAuthorized({ headers: {} }, null), true);
  assert.equal(isAuthorized({ headers: {} }, ''), true);
});

test('isAuthorized: when a token is configured, the presented value must match', () => {
  const cfg = 's3cret';
  assert.equal(isAuthorized({ headers: { authorization: 'Bearer s3cret' } }, cfg), true);
  assert.equal(isAuthorized({ query: { token: 's3cret' } }, cfg), true);
  assert.equal(isAuthorized({ headers: { authorization: 'Bearer wrong' } }, cfg), false);
  assert.equal(isAuthorized({ headers: {}, query: {} }, cfg), false);
});

test('a token-protected server rejects unauthenticated requests and accepts the token', async () => {
  await withTokenServer('topsecret', async (base) => {
    const noAuth = await fetch(`${base}/api/health`);
    assert.equal(noAuth.status, 401);
    assert.equal((await noAuth.json()).error.code, 'UNAUTHORIZED');

    const bearer = await fetch(`${base}/api/health`, { headers: { authorization: 'Bearer topsecret' } });
    assert.equal(bearer.status, 200);
    assert.equal((await bearer.json()).ok, true);

    const query = await fetch(`${base}/api/health?token=topsecret`);
    assert.equal(query.status, 200, 'browser first-load ?token= is accepted');

    const wrong = await fetch(`${base}/api/health`, { headers: { authorization: 'Bearer nope' } });
    assert.equal(wrong.status, 401);
  });
});

test('detectDaemon authenticates with LW_DB_TOKEN from the environment', async () => {
  await withTokenServer('topsecret', async (base) => {
    const saved = process.env.LW_DB_TOKEN;
    try {
      process.env.LW_DB_TOKEN = 'topsecret';
      assert.ok(await detectDaemon(base), 'with the token, the daemon is detected');
      process.env.LW_DB_TOKEN = '';
      assert.equal(await detectDaemon(base), null, 'without the token, health is 401 → treated as no daemon');
    } finally {
      if (saved === undefined) delete process.env.LW_DB_TOKEN; else process.env.LW_DB_TOKEN = saved;
    }
  });
});
