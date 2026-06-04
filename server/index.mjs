/**
 * HTTP API + static SPA host. Mirrors all CLI capabilities so a Web UI and
 * external integrations can use the same surface.
 */
import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

import { buildRegistry } from './lib/registry.mjs';
import { safeConnection } from './lib/connectionStore.mjs';
import { listDatabases, listTables, describeTable, fetchSchema, closeAll, poolStats, pingConnection } from './lib/pool.mjs';
import { runQuery } from './lib/runQuery.mjs';
import { bindParams, extractParams } from './lib/snippets.mjs';
import {
  backupSqlite, backupJson, restoreJson, defaultBackupPath,
} from './lib/backup.mjs';
import { appError, Codes, statusForCode } from './lib/errors.mjs';
import { child } from './lib/log.mjs';
import {
  required, ensureString, ensureArray, ensureObject, clampInt,
} from './lib/validate.mjs';

const registry = await buildRegistry();
const log = child('http');

const app = Fastify({
  bodyLimit: registry.config.bodyLimitBytes,
  disableRequestLogging: true,
  genReqId: () => randomUUID(),
});

app.addHook('onResponse', (req, reply, done) => {
  log.info('req', {
    id: req.id,
    method: req.method,
    url: req.url,
    status: reply.statusCode,
    ms: reply.elapsedTime?.toFixed?.(0),
  });
  done();
});

function replyError(reply, err) {
  const code = err.code || Codes.DB_ERROR;
  const status = statusForCode(code);
  if (status >= 500) log.error(err.message, { code, stack: err.stack });
  else log.warn(err.message, { code });
  reply.code(status).send({
    error: {
      code,
      message: err.message,
      ...(err.verb ? { verb: err.verb } : {}),
    },
  });
}

function asyncRoute(handler) {
  return async (req, reply) => {
    try { return await handler(req, reply); }
    catch (err) { return replyError(reply, err); }
  };
}

// ---------- meta ----------

const packageMeta = JSON.parse(await readFile(join(registry.projectRoot, 'package.json'), 'utf8'));

app.get('/api/health', async () => ({
  ok: true,
  version: packageMeta.version,
  connections: registry.listConnections().length,
  pools: poolStats(),
  uptimeSec: Math.round(process.uptime()),
}));

app.get('/api/version', async () => ({ name: packageMeta.name, version: packageMeta.version }));

// ---------- servers / dbs / tables ----------

app.get('/api/servers', async () => ({
  servers: registry.listConnections().map(safeConnection),
  health: registry.connectionHealth.snapshot(),
}));

app.get('/api/servers/health', async () => ({
  health: registry.connectionHealth.snapshot(),
}));

// ---------- connections (CRUD) ----------

app.get('/api/connections', async () => ({
  connections: registry.connectionStore.all().map(safeConnection),
}));

app.post('/api/connections', asyncRoute(async (req) => {
  const body = ensureObject(req.body, 'body');
  required(body, ['label', 'host', 'user']);
  return { connection: safeConnection(registry.connectionStore.create(body)) };
}));

app.put('/api/connections/:id', asyncRoute(async (req) => {
  const body = ensureObject(req.body || {}, 'body');
  const conn = registry.connectionStore.update(req.params.id, body);
  if (!conn) throw appError(Codes.NOT_FOUND, 'Connection not found');
  return { connection: safeConnection(conn) };
}));

app.delete('/api/connections/:id', asyncRoute(async (req) => {
  const ok = registry.connectionStore.delete(req.params.id);
  if (!ok) throw appError(Codes.NOT_FOUND, 'Connection not found');
  return { ok: true };
}));

app.post('/api/connections/test', asyncRoute(async (req) => {
  const body = ensureObject(req.body || {}, 'body');
  // Test a saved connection (by id) or an ad-hoc one (inline host/user/...).
  const conn = body.id ? registry.connectionStore.get(body.id) : body;
  if (!conn || !conn.host) throw appError(Codes.BAD_REQUEST, 'host required (or a valid id)');
  return await pingConnection(conn, { timeoutMs: 5000 });
}));

app.post('/api/connections/import', asyncRoute(async (req) => {
  const body = req.body;
  const items = Array.isArray(body) ? body : (body?.connections || []);
  ensureArray(items, 'connections');
  if (!items.length) throw appError(Codes.BAD_REQUEST, 'No connections in payload');
  const result = registry.connectionStore.bulkUpsert(items);
  return { count: result.length, result };
}));

app.get('/api/connections/export', async () => registry.connectionStore.exportAll());

app.get('/api/servers/:id/databases', asyncRoute(async (req) => {
  const conn = registry.getConnection(req.params.id);
  return { databases: await listDatabases(conn) };
}));

app.get('/api/servers/:id/databases/:db/tables', asyncRoute(async (req) => {
  const conn = registry.getConnection(req.params.id);
  return { tables: await listTables(conn, req.params.db) };
}));

app.get('/api/servers/:id/databases/:db/tables/:table', asyncRoute(async (req) => {
  const conn = registry.getConnection(req.params.id);
  return await describeTable(conn, req.params.db, req.params.table);
}));

app.get('/api/servers/:id/databases/:db/schema', asyncRoute(async (req) => {
  const conn = registry.getConnection(req.params.id);
  return await fetchSchema(conn, req.params.db);
}));

// ---------- query ----------

app.post('/api/query', asyncRoute(async (req) => {
  const body = ensureObject(req.body, 'body');
  required(body, ['server', 'sql']);
  ensureString(body.sql, 'sql');
  const conn = registry.getConnection(body.server);
  return await runQuery({
    connection: conn,
    db: body.db || null,
    sql: body.sql,
    args: Array.isArray(body.args) ? body.args : [],
    writable: !!body.writable,
    limit: body.limit,
    history: registry.history,
    config: registry.config,
  });
}));

// ---------- snippets ----------

app.get('/api/snippets', async () => ({ snippets: registry.snippets.list() }));

app.post('/api/snippets', asyncRoute(async (req) => {
  const body = ensureObject(req.body, 'body');
  required(body, ['name', 'sql']);
  return { snippet: registry.snippets.create(body) };
}));

app.put('/api/snippets/:id', asyncRoute(async (req) => {
  const snippet = registry.snippets.update(req.params.id, ensureObject(req.body || {}, 'body'));
  if (!snippet) throw appError(Codes.NOT_FOUND, 'Snippet not found');
  return { snippet };
}));

app.delete('/api/snippets/:id', asyncRoute(async (req) => {
  const ok = registry.snippets.remove(req.params.id);
  if (!ok) throw appError(Codes.NOT_FOUND, 'Snippet not found');
  return { ok: true };
}));

app.post('/api/snippets/push', asyncRoute(async (req) => {
  const body = req.body || {};
  const items = Array.isArray(body) ? body : (body.snippets || []);
  ensureArray(items, 'snippets');
  if (!items.length) throw appError(Codes.BAD_REQUEST, 'No snippets in payload');
  return { count: items.length, result: registry.snippets.bulkUpsert(items) };
}));

app.post('/api/snippets/:id/run', asyncRoute(async (req) => {
  const snippet = registry.snippets.get(req.params.id);
  if (!snippet) throw appError(Codes.NOT_FOUND, 'Snippet not found');
  const body = ensureObject(req.body || {}, 'body');
  const params = body.params || {};
  const ops = body.ops || {};
  const targetServer = body.server || snippet.defaultServer;
  const targetDb = body.db || snippet.defaultDb;
  if (!targetServer) throw appError(Codes.BAD_REQUEST, 'server required (no defaultServer on snippet)');
  const { sql: boundSql, args } = bindParams(snippet.sql, params, ops);
  const conn = registry.getConnection(targetServer);
  const result = await runQuery({
    connection: conn, db: targetDb, sql: boundSql, args,
    writable: !!body.writable, limit: body.limit,
    history: registry.history, snippetId: snippet.id,
    config: registry.config,
  });
  return { ...result, snippet: { id: snippet.id, name: snippet.name, params: extractParams(snippet.sql) } };
}));

// ---------- history ----------

app.get('/api/history', async (req) => {
  const limit = clampInt(req.query.limit, { min: 1, max: 500, fallback: 50 });
  return { history: registry.history.recent({ limit, server: req.query.server || null, db: req.query.db || null }) };
});

app.delete('/api/history', async () => {
  registry.history.clear();
  return { ok: true };
});

// ---------- preferences ----------

app.get('/api/preferences', async () => ({ preferences: registry.preferences.all() }));
app.put('/api/preferences/:key', asyncRoute(async (req) => {
  const body = ensureObject(req.body || {}, 'body');
  registry.preferences.set(req.params.key, body.value);
  return { ok: true };
}));

// ---------- backup / restore ----------

app.post('/api/backup', asyncRoute(async (req) => {
  const body = req.body || {};
  const kind = body.kind === 'sqlite' ? 'sqlite' : 'json';
  const outPath = body.path || defaultBackupPath(registry.dataDir, kind);
  return kind === 'sqlite'
    ? await backupSqlite(registry, outPath)
    : await backupJson(registry, outPath);
}));

app.get('/api/backup/download', asyncRoute(async (_req, reply) => {
  const info = await backupJson(registry, defaultBackupPath(registry.dataDir, 'json'));
  const filename = info.path.split('/').pop();
  reply.header('content-type', 'application/json');
  reply.header('content-disposition', `attachment; filename="${filename}"`);
  return await readFile(info.path, 'utf8');
}));

app.post('/api/restore', asyncRoute(async (req) => {
  const body = ensureObject(req.body || {}, 'body');
  if (!body.backup) throw appError(Codes.BAD_REQUEST, 'backup payload required');
  return await restoreJson(registry, body.backup, { merge: !!body.merge });
}));

// ---------- static / SPA ----------

const distDir = join(registry.projectRoot, 'dist');
if (existsSync(distDir)) {
  await app.register(fastifyStatic, { root: distDir });
  app.setNotFoundHandler((req, reply) => {
    if (req.url.startsWith('/api/')) {
      reply.code(404).send({ error: { code: Codes.NOT_FOUND, message: 'Route not found' } });
      return;
    }
    reply.sendFile('index.html');
  });
} else {
  app.setNotFoundHandler((req, reply) => {
    if (req.url.startsWith('/api/')) {
      reply.code(404).send({ error: { code: Codes.NOT_FOUND, message: 'Route not found' } });
      return;
    }
    reply.code(404).send({
      error: {
        code: Codes.NOT_FOUND,
        message: 'SPA not built. Run `npm run build` or `npm run dev` (Vite dev server on :5173).',
      },
    });
  });
}

// ---------- shutdown ----------

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info('shutdown', { signal });
  try { await app.close(); } catch (err) { log.warn('close error', { err: err.message }); }
  try { await closeAll(); } catch (err) { log.warn('pool close error', { err: err.message }); }
  try { registry.db.close(); } catch (err) { log.warn('sqlite close error', { err: err.message }); }
  process.exit(0);
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('unhandledRejection', (err) => log.error('unhandledRejection', { err: err?.message || String(err) }));
process.on('uncaughtException', (err) => log.error('uncaughtException', { err: err?.message || String(err) }));

try {
  await app.listen({ port: registry.port, host: registry.host });
  log.info('listening', {
    url: `http://${registry.host}:${registry.port}`,
    connections: registry.listConnections().length,
    sqlite: registry.dbPath,
    spaBuilt: existsSync(distDir),
  });
} catch (err) {
  log.error('listen failed', { err: err.message });
  process.exit(1);
}
