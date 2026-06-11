import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { detectDaemon } from '../server/lib/daemonClient.mjs';

/**
 * Minimal fake daemon: routes is a map of 'METHOD /path' → { status, body }.
 * Records every request so tests can assert what was (not) called.
 */
function startFakeDaemon(routes) {
  return new Promise((resolve) => {
    const requests = [];
    const server = createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => { raw += c; });
      req.on('end', () => {
        const key = `${req.method} ${req.url.split('?')[0]}`;
        requests.push({ key, body: raw ? JSON.parse(raw) : null });
        const route = routes[key];
        if (!route) {
          res.writeHead(404, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: { code: 'NOT_FOUND', message: `no route: ${key}` } }));
          return;
        }
        res.writeHead(route.status || 200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(route.body));
      });
    });
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        port,
        baseUrl: `http://127.0.0.1:${port}`,
        requests,
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}

const HEALTH_OK = { ok: true, version: '0.0.0-test', connections: 1, uptimeSec: 1 };

test('detectDaemon returns null when nothing is listening', async () => {
  // Grab a port that is definitely free, then close it again.
  const probe = await startFakeDaemon({});
  await probe.close();
  const result = await detectDaemon(probe.baseUrl, { timeoutMs: 300 });
  assert.equal(result, null);
});

test('detectDaemon returns health info for a running lwdb server', async () => {
  const fake = await startFakeDaemon({ 'GET /api/health': { body: HEALTH_OK } });
  try {
    const result = await detectDaemon(fake.baseUrl);
    assert.equal(result.ok, true);
    assert.equal(result.version, '0.0.0-test');
  } finally {
    await fake.close();
  }
});

test('detectDaemon returns null when the port is held by a non-lwdb app', async () => {
  const fake = await startFakeDaemon({ 'GET /api/health': { body: { hello: 'world' } } });
  try {
    assert.equal(await detectDaemon(fake.baseUrl), null);
  } finally {
    await fake.close();
  }
});

// ---------- CLI forwarding ----------

function runCli(args, env) {
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      ['--no-warnings=ExperimentalWarning', 'bin/lwdb.mjs', ...args],
      { env: { ...process.env, LW_DB_NO_DAEMON: '', ...env }, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => { stdout += c; });
    child.stderr.on('data', (c) => { stderr += c; });
    child.on('exit', (code) => resolve({ code, stdout, stderr }));
  });
}

async function withFakeDaemon(routes, fn) {
  const dir = await mkdtemp(join(tmpdir(), 'lwdb-daemon-'));
  const fake = await startFakeDaemon({ 'GET /api/health': { body: HEALTH_OK }, ...routes });
  const env = {
    LW_DB_HOST: '127.0.0.1',
    LW_DB_PORT: String(fake.port),
    LW_DB_SQLITE: join(dir, 'lwdb.sqlite'), // empty local registry — local fallback knows no servers
  };
  try {
    await fn(fake, env);
  } finally {
    await fake.close();
    await rm(dir, { recursive: true, force: true });
  }
}

test('CLI forwards `dbs` through a running daemon', async () => {
  await withFakeDaemon({
    'GET /api/servers/X/databases': { body: { databases: ['fake_db_one', 'zeta'] } },
  }, async (fake, env) => {
    const { code, stdout } = await runCli(['dbs', 'X'], env);
    assert.equal(code, 0, stdout);
    assert.deepEqual(JSON.parse(stdout), [{ name: 'fake_db_one' }, { name: 'zeta' }]);
    assert.ok(fake.requests.some((r) => r.key === 'GET /api/servers/X/databases'));
  });
});

test('CLI --no-daemon skips the daemon and runs locally', async () => {
  await withFakeDaemon({
    'GET /api/servers/X/databases': { body: { databases: ['fake_db_one'] } },
  }, async (fake, env) => {
    const { code, stdout } = await runCli(['dbs', 'X', '--no-daemon'], env);
    assert.notEqual(code, 0);
    assert.match(JSON.parse(stdout).error.message, /Unknown server/);
    assert.equal(fake.requests.length, 0, 'daemon must not be contacted with --no-daemon');
  });
});

test('CLI forwards `query` and emits the daemon result envelope', async () => {
  const envelope = {
    sql: 'SELECT 1 LIMIT 500', verb: 'SELECT', writable: false, elapsedMs: 3,
    rowCount: 1, fields: [{ name: '1', type: 8 }], rows: [{ 1: 1 }],
    meta: null, limited: true, appliedLimit: 500,
  };
  await withFakeDaemon({
    'POST /api/query': { body: envelope },
  }, async (fake, env) => {
    const { code, stdout } = await runCli(['query', 'X', 'SELECT 1'], env);
    assert.equal(code, 0, stdout);
    assert.deepEqual(JSON.parse(stdout), envelope);
    const q = fake.requests.find((r) => r.key === 'POST /api/query');
    assert.deepEqual(q.body.server, 'X');
    assert.deepEqual(q.body.sql, 'SELECT 1');
    assert.equal(q.body.writable, false);
  });
});

test('CLI write gate still blocks before forwarding to the daemon', async () => {
  await withFakeDaemon({
    'GET /api/preferences': { body: { preferences: {} } },
  }, async (fake, env) => {
    const { code, stdout } = await runCli(['query', 'X', 'DELETE FROM t', '--yes'], env);
    assert.notEqual(code, 0);
    assert.match(JSON.parse(stdout).error.message, /AGENT_WRITES_DISABLED/);
    assert.ok(!fake.requests.some((r) => r.key === 'POST /api/query'), 'blocked write must never reach the daemon');
  });
});

test('CLI forwards `context` through a running daemon', async () => {
  const ctx = {
    server: 'X', db: 'D', tableCount: 1, columnCount: 2,
    groups: {}, tables: { students: { rows: 5, columns: ['id int pk ai', 'name varchar(10) nn'] } },
    notes: ['Row counts are storage-engine estimates, not exact.'],
  };
  await withFakeDaemon({
    'GET /api/servers/X/databases/D/context': { body: ctx },
  }, async (fake, env) => {
    const { code, stdout } = await runCli(['context', 'X', 'D'], env);
    assert.equal(code, 0, stdout);
    assert.deepEqual(JSON.parse(stdout), ctx);
    assert.ok(fake.requests.some((r) => r.key === 'GET /api/servers/X/databases/D/context'));
  });
});

test('CLI `sample` builds a bounded SELECT and forwards it as a query', async () => {
  const envelope = { sql: 'SELECT * FROM `D`.`students` LIMIT 3', verb: 'SELECT', rows: [{ id: 1 }], rowCount: 1, elapsedMs: 1, fields: [] };
  await withFakeDaemon({
    'POST /api/query': { body: envelope },
  }, async (fake, env) => {
    const { code, stdout } = await runCli(['sample', 'X', 'D', 'students', '--limit=3'], env);
    assert.equal(code, 0, stdout);
    assert.deepEqual(JSON.parse(stdout), envelope);
    const q = fake.requests.find((r) => r.key === 'POST /api/query');
    assert.equal(q.body.sql, 'SELECT * FROM `D`.`students` LIMIT 3');
    assert.equal(q.body.db, 'D');
    assert.equal(q.body.writable, false);
  });
});

test('CLI forwards `profile` through a running daemon', async () => {
  const profile = { server: 'X', db: 'D', table: 'students', rowsScanned: 10, exact: false, notes: [], columns: { id: { type: 'int', nulls: 0, nullPct: 0, distinct: 10, min: 1, max: 10 } } };
  await withFakeDaemon({
    'GET /api/servers/X/databases/D/tables/students/profile': { body: profile },
  }, async (fake, env) => {
    const { code, stdout } = await runCli(['profile', 'X', 'D', 'students', '--top=7'], env);
    assert.equal(code, 0, stdout);
    assert.deepEqual(JSON.parse(stdout), profile);
    assert.ok(fake.requests.some((r) => r.key === 'GET /api/servers/X/databases/D/tables/students/profile'));
  });
});

test('CLI --approve creates an approval, waits, and emits the approved result', async () => {
  const pending = { id: 'apr_x', server: 'X', db: 'D', sql: 'UPDATE t SET a=1', status: 'pending', requestedAt: 't' };
  const approved = { ...pending, status: 'approved', result: { verb: 'UPDATE', rowCount: 1, rows: [] } };
  await withFakeDaemon({
    'POST /api/approvals': { body: { approval: pending } },
    'GET /api/approvals/apr_x': { body: { approval: approved } },
  }, async (fake, env) => {
    const { code, stdout } = await runCli(['query', 'X', 'D', 'UPDATE t SET a=1', '--approve'], env);
    assert.equal(code, 0, stdout);
    assert.deepEqual(JSON.parse(stdout), approved.result);
    const created = fake.requests.find((r) => r.key === 'POST /api/approvals');
    assert.equal(created.body.sql, 'UPDATE t SET a=1');
    assert.ok(fake.requests.some((r) => r.key === 'GET /api/approvals/apr_x'), 'CLI polled for the outcome');
  });
});

test('CLI --approve reports a write denied by the human', async () => {
  const pending = { id: 'apr_d', server: 'X', sql: 'DELETE FROM t', status: 'pending', requestedAt: 't' };
  await withFakeDaemon({
    'POST /api/approvals': { body: { approval: pending } },
    'GET /api/approvals/apr_d': { body: { approval: { ...pending, status: 'denied' } } },
  }, async (_fake, env) => {
    const { code, stdout } = await runCli(['query', 'X', 'DELETE FROM t', '--approve'], env);
    assert.notEqual(code, 0);
    assert.match(JSON.parse(stdout).error.message, /denied/i);
  });
});

test('CLI --approve on a read-only statement skips approval and just runs it', async () => {
  const envelope = { sql: 'SELECT 1 LIMIT 500', verb: 'SELECT', rows: [{ 1: 1 }], rowCount: 1, fields: [], elapsedMs: 1 };
  await withFakeDaemon({ 'POST /api/query': { body: envelope } }, async (fake, env) => {
    const { code, stdout } = await runCli(['query', 'X', 'SELECT 1', '--approve'], env);
    assert.equal(code, 0, stdout);
    assert.deepEqual(JSON.parse(stdout), envelope);
    assert.ok(!fake.requests.some((r) => r.key === 'POST /api/approvals'), 'read-only never requests approval');
  });
});

test('CLI --approve without a running server fails clearly (NO_DAEMON)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'lwdb-noappr-'));
  try {
    // No daemon: point at a closed port so detection fails and we fall back to local.
    const { code, stdout } = await runCli(['query', 'X', 'DELETE FROM t', '--approve'], {
      LW_DB_HOST: '127.0.0.1', LW_DB_PORT: '5999', LW_DB_SQLITE: join(dir, 'lwdb.sqlite'),
    });
    assert.notEqual(code, 0);
    assert.match(JSON.parse(stdout).error.message, /running lwdb server|NO_DAEMON/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('CLI surfaces daemon error envelopes (code + message)', async () => {
  await withFakeDaemon({
    'POST /api/query': { status: 404, body: { error: { code: 'UNKNOWN_SERVER', message: 'Unknown server: X' } } },
  }, async (_fake, env) => {
    const { code, stdout } = await runCli(['query', 'X', 'SELECT 1'], env);
    assert.notEqual(code, 0);
    assert.match(JSON.parse(stdout).error.message, /Unknown server: X/);
  });
});
