import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { createInterface } from 'node:readline';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const HEALTH_OK = { ok: true, version: '0.0.0-test', connections: 1, uptimeSec: 1 };

function startFakeDaemon(routes) {
  return new Promise((resolve) => {
    const requests = [];
    const server = createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => { raw += c; });
      req.on('end', () => {
        const key = `${req.method} ${req.url.split('?')[0]}`;
        requests.push({ key, body: raw ? JSON.parse(raw) : null });
        const route = routes[key] || { 'GET /api/health': { body: HEALTH_OK } }[key];
        if (!route) { res.writeHead(404, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: { code: 'NOT_FOUND', message: key } })); return; }
        res.writeHead(route.status || 200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(route.body));
      });
    });
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ port, requests, close: () => new Promise((r) => server.close(r)) });
    });
  });
}

/** Spawn `lwdb mcp`, talk JSON-RPC over stdio, collect responses by id. */
function startMcp(env) {
  const child = spawn(
    process.execPath,
    ['--no-warnings=ExperimentalWarning', 'bin/lwdb.mjs', 'mcp'],
    { env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'inherit'] },
  );
  const waiters = new Map();
  const rl = createInterface({ input: child.stdout });
  rl.on('line', (line) => {
    const t = line.trim();
    if (!t) return;
    const msg = JSON.parse(t);
    if (msg.id != null && waiters.has(msg.id)) { waiters.get(msg.id)(msg); waiters.delete(msg.id); }
  });
  let nextId = 1;
  return {
    request(method, params) {
      const id = nextId++;
      return new Promise((resolve) => {
        waiters.set(id, resolve);
        child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
      });
    },
    notify(method, params) {
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
    },
    stop() { child.stdin.end(); child.kill('SIGTERM'); },
  };
}

async function withMcp(routes, fn) {
  const dir = await mkdtemp(join(tmpdir(), 'lwdb-mcp-'));
  const daemon = await startFakeDaemon(routes);
  const env = { LW_DB_HOST: '127.0.0.1', LW_DB_PORT: String(daemon.port), LW_DB_SQLITE: join(dir, 'lwdb.sqlite') };
  const mcp = startMcp(env);
  try {
    await fn({ mcp, daemon });
  } finally {
    mcp.stop();
    await daemon.close();
    await rm(dir, { recursive: true, force: true });
  }
}

const parse = (callResult) => JSON.parse(callResult.result.content[0].text);

test('MCP handshake: initialize advertises tools, then tools/list returns the lwdb surface', async () => {
  await withMcp({}, async ({ mcp }) => {
    const init = await mcp.request('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 't', version: '1' } });
    assert.equal(init.result.protocolVersion, '2025-11-25');
    assert.ok(init.result.capabilities.tools);
    assert.equal(init.result.serverInfo.name, 'lwdb');
    mcp.notify('notifications/initialized');

    const list = await mcp.request('tools/list', {});
    const names = list.result.tools.map((t) => t.name);
    for (const expected of ['list_servers', 'get_context', 'run_query', 'profile_table', 'run_snippet']) {
      assert.ok(names.includes(expected), `tools/list missing ${expected}`);
    }
  });
});

test('MCP get_context forwards to the daemon and returns the brief', async () => {
  const ctx = { server: 'X', db: 'D', tableCount: 1, columnCount: 2, groups: {}, tables: { students: { rows: 5, columns: ['id int pk ai'] } }, notes: [] };
  await withMcp({ 'GET /api/servers/X/databases/D/context': { body: ctx } }, async ({ mcp, daemon }) => {
    await mcp.request('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 't', version: '1' } });
    const res = await mcp.request('tools/call', { name: 'get_context', arguments: { server: 'X', db: 'D' } });
    assert.equal(res.result.isError, false);
    assert.deepEqual(parse(res), ctx);
    assert.ok(daemon.requests.some((r) => r.key === 'GET /api/servers/X/databases/D/context'));
  });
});

test('MCP run_query forwards a read-only SELECT', async () => {
  const envelope = { sql: 'SELECT 1 LIMIT 500', verb: 'SELECT', rows: [{ 1: 1 }], rowCount: 1, elapsedMs: 1, fields: [] };
  await withMcp({ 'POST /api/query': { body: envelope } }, async ({ mcp, daemon }) => {
    await mcp.request('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 't', version: '1' } });
    const res = await mcp.request('tools/call', { name: 'run_query', arguments: { server: 'X', sql: 'SELECT 1' } });
    assert.equal(res.result.isError, false);
    assert.deepEqual(parse(res), envelope);
    const q = daemon.requests.find((r) => r.key === 'POST /api/query');
    assert.equal(q.body.writable, false);
  });
});

test('MCP run_query blocks a write when agentWrites is off — never reaches the daemon', async () => {
  await withMcp({ 'GET /api/preferences': { body: { preferences: {} } } }, async ({ mcp, daemon }) => {
    await mcp.request('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 't', version: '1' } });
    const res = await mcp.request('tools/call', { name: 'run_query', arguments: { server: 'X', sql: 'DELETE FROM t', writable: true } });
    assert.equal(res.result.isError, true);
    assert.equal(parse(res).error.code, 'AGENT_WRITES_DISABLED');
    assert.ok(!daemon.requests.some((r) => r.key === 'POST /api/query'), 'blocked write must not reach the daemon');
  });
});
