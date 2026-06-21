/**
 * HTTP API + static SPA host. Mirrors all CLI capabilities so a Web UI and
 * external integrations can use the same surface.
 */
import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import fastifyRateLimit from '@fastify/rate-limit';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';

import { buildRegistry } from './lib/registry.mjs';
import { safeConnection } from './lib/connectionStore.mjs';
import { listDatabases, listTables, describeTable, fetchSchema, closeAll, poolStats, pingConnection } from './lib/pool.mjs';
import { runQuery } from './lib/runQuery.mjs';
import { fetchContext } from './lib/context.mjs';
import { profileTable } from './lib/profile.mjs';
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

// Rate limiting is opt-in per route (global: false) — applied only to the
// endpoints that reach outside the process (spawn a browser, call GitHub) so
// they can't be hammered. Normal query traffic is unaffected.
await app.register(fastifyRateLimit, { global: false });
const RATE_LIMIT = { max: 30, timeWindow: '1 minute' };

// Local-only hardening. This server binds to loopback and has no user auth, so
// the realistic threat is a web page in the user's browser reaching it (CSRF /
// DNS-rebinding) — including the SQL and open-external routes. Fail closed:
// reject any request whose Host or (browser-supplied) Origin is not loopback.
// Non-browser callers (CLI, the Tauri health check) send no Origin and pass;
// the app itself is loopback in every mode (prod 127.0.0.1:4321, dev via the
// vite proxy on localhost), so it's unaffected.
const LOOPBACK = /^(127\.0\.0\.1|localhost|\[::1\]|::1)(:\d+)?$/i;
app.addHook('onRequest', (req, reply, done) => {
  if (!LOOPBACK.test(req.headers.host || '')) {
    reply.code(403).send({ error: { code: 'FORBIDDEN', message: 'non-loopback Host rejected' } });
    return;
  }
  const origin = req.headers.origin;
  if (origin) {
    let host = null;
    try { host = new URL(origin).host; } catch (_) { /* malformed → reject */ }
    if (!host || !LOOPBACK.test(host)) {
      reply.code(403).send({ error: { code: 'FORBIDDEN', message: 'cross-origin request rejected' } });
      return;
    }
  }
  done();
});
log.warn('API is loopback-only with no user auth — do not expose to a network', {});

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

// ---------- update check (GitHub latest release) ----------
function cmpSemver(a, b) {
  const pa = String(a).replace(/^v/, '').split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b).replace(/^v/, '').split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i += 1) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0);
  return 0;
}
// Releases are published under the linways org, not the personal fork that
// package.json points at — so this is configurable (LW_DB_RELEASES_REPO).
const REPO_SLUG = registry.config.releasesRepo;
let updateCache = { at: 0, data: null };

app.get('/api/update-check', { config: { rateLimit: RATE_LIMIT } }, async (req, reply) => {
  const current = packageMeta.version;
  if (!REPO_SLUG) return { current, hasUpdate: false, error: 'no GitHub repo configured' };
  // Cache 10 min so opening About repeatedly doesn't hit GitHub's rate limit.
  if (updateCache.data && Date.now() - updateCache.at < 600_000 && !req.query.force) {
    return { ...updateCache.data, current, cached: true };
  }
  try {
    const r = await fetch(`https://api.github.com/repos/${REPO_SLUG}/releases/latest`, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'lwdb-updater' },
      signal: AbortSignal.timeout(8000),
    });
    // 404 = repo has no published release yet — not an error, just nothing to update to.
    if (r.status === 404) {
      const data = { latest: '', hasUpdate: false, noReleases: true, body: '', htmlUrl: `https://github.com/${REPO_SLUG}/releases` };
      updateCache = { at: Date.now(), data };
      return { ...data, current };
    }
    if (!r.ok) { reply.code(502); return { current, hasUpdate: false, error: `GitHub responded ${r.status}` }; }
    const rel = await r.json();
    const latest = String(rel.tag_name || rel.name || '').replace(/^v/, '');
    const data = {
      latest,
      hasUpdate: latest ? cmpSemver(latest, current) > 0 : false,
      name: rel.name || rel.tag_name || latest,
      body: rel.body || '',
      htmlUrl: rel.html_url || `https://github.com/${REPO_SLUG}/releases`,
      publishedAt: rel.published_at || null,
    };
    updateCache = { at: Date.now(), data };
    return { ...data, current };
  } catch (e) {
    reply.code(502);
    return { current, hasUpdate: false, error: e.message };
  }
});

// Open a release page in the user's default browser (local desktop app).
// Hardened: this endpoint only ever needs to open GitHub, so we lock the host
// to github.com, require https, and reject any shell/cmd metacharacter. On
// Windows we use rundll32 (not `cmd /c start`, which re-parses its arguments
// and is the classic command-injection vector). Args are passed as an array
// (no shell) on every platform.
app.post('/api/open-external', { config: { rateLimit: RATE_LIMIT } }, async (req, reply) => {
  const url = req.body?.url;
  let parsed;
  try { parsed = new URL(url); } catch (_) { reply.code(400); return { ok: false, error: 'invalid url' }; }
  const safe = parsed.protocol === 'https:'
    && /(^|\.)github\.com$/i.test(parsed.hostname)
    && !/["&|^<>%`\\\s]/.test(url); // no metacharacters / whitespace
  if (!safe) { reply.code(400); return { ok: false, error: 'url not allowed' }; }
  const [cmd, args] = process.platform === 'darwin'
    ? ['open', [url]]
    : process.platform === 'win32'
      ? ['rundll32', ['url.dll,FileProtocolHandler', url]]
      : ['xdg-open', [url]];
  try {
    spawn(cmd, args, { detached: true, stdio: 'ignore' }).unref();
    return { ok: true };
  } catch (e) {
    reply.code(500);
    return { ok: false, error: e.message };
  }
});

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

app.get('/api/servers/:id/databases/:db/context', asyncRoute(async (req) => {
  const conn = registry.getConnection(req.params.id);
  const annotations = registry.annotations.list({ server: req.params.id, db: req.params.db });
  return await fetchContext(conn, req.params.db, { annotations });
}));

app.get('/api/servers/:id/databases/:db/tables/:table/profile', asyncRoute(async (req) => {
  const conn = registry.getConnection(req.params.id);
  return await profileTable(conn, req.params.db, req.params.table, {
    columns: req.query.columns ? String(req.query.columns).split(',').map((s) => s.trim()).filter(Boolean) : null,
    top: clampInt(req.query.top, { min: 1, max: 50, fallback: 5 }),
    sampleSize: clampInt(req.query.sample, { min: 100, max: 1_000_000, fallback: 10_000 }),
    exact: req.query.exact === '1' || req.query.exact === 'true',
  });
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
    actor: body.actor || 'ui',
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
    history: registry.history, snippetId: snippet.id, actor: body.actor || 'ui',
    config: registry.config,
  });
  return { ...result, snippet: { id: snippet.id, name: snippet.name, params: extractParams(snippet.sql) } };
}));

// ---------- history ----------

app.get('/api/history', async (req) => {
  const limit = clampInt(req.query.limit, { min: 1, max: 500, fallback: 50 });
  return { history: registry.history.recent({ limit, server: req.query.server || null, db: req.query.db || null, actor: req.query.actor || null }) };
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

// ---------- annotations ----------

app.get('/api/annotations', async (req) => ({
  annotations: registry.annotations.list({
    server: req.query.server || undefined,
    db: req.query.db || undefined,
    tbl: req.query.table || undefined,
  }),
}));

app.post('/api/annotations', asyncRoute(async (req) => {
  const body = ensureObject(req.body, 'body');
  required(body, ['server', 'db', 'table', 'note']);
  return {
    annotation: registry.annotations.upsert({
      server: body.server, db: body.db, tbl: body.table,
      col: body.column || null, note: body.note, source: body.source || 'human',
    }),
  };
}));

app.delete('/api/annotations', asyncRoute(async (req) => {
  const body = ensureObject(req.body || {}, 'body');
  required(body, ['server', 'db', 'table']);
  const ok = registry.annotations.remove({
    server: body.server, db: body.db, tbl: body.table, col: body.column || null,
  });
  if (!ok) throw appError(Codes.NOT_FOUND, 'Annotation not found');
  return { ok: true };
}));

// ---------- interactive write approvals ----------

// An agent requests approval for one specific write; a human approves THAT exact
// SQL (in the desktop app or any client), and it executes server-side once.
app.post('/api/approvals', asyncRoute(async (req) => {
  const body = ensureObject(req.body, 'body');
  required(body, ['server', 'sql']);
  ensureString(body.sql, 'sql');
  registry.getConnection(body.server); // 404 early if the server is unknown
  return { approval: registry.approvals.create({ server: body.server, db: body.db || null, sql: body.sql }) };
}));

app.get('/api/approvals', async () => ({ approvals: registry.approvals.list() }));

app.get('/api/approvals/:id', asyncRoute(async (req) => {
  const approval = registry.approvals.get(req.params.id);
  if (!approval) throw appError(Codes.NOT_FOUND, 'Approval not found');
  return { approval };
}));

app.post('/api/approvals/:id/resolve', asyncRoute(async (req) => {
  const body = ensureObject(req.body || {}, 'body');
  const decision = body.decision;
  // On approve the write runs through the normal chokepoint: writable=true, but
  // a write-protected connection still refuses (READONLY_BLOCKED) inside runQuery.
  const runner = (item) => runQuery({
    connection: registry.getConnection(item.server),
    db: item.db,
    sql: item.sql,
    writable: true,
    history: registry.history,
    actor: 'approved',
    config: registry.config,
  });
  return { approval: await registry.approvals.resolve(req.params.id, decision, runner) };
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
