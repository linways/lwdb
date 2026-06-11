/**
 * Client for an already-running lwdb HTTP server (the "daemon" — usually the
 * desktop app or `lwdb serve`). When one is up, the CLI forwards MySQL-touching
 * commands to it and reuses its warm connection pools instead of paying a fresh
 * SQLite open + MySQL connect on every invocation.
 */

import { appError, Codes } from './errors.mjs';

/**
 * Probe baseUrl for a healthy lwdb server. Returns the /api/health payload
 * when it answers like lwdb (ok === true), otherwise null — including when
 * the port is closed, slow, or held by some other app.
 */
export async function detectDaemon(baseUrl, { timeoutMs = 250 } = {}) {
  try {
    const res = await fetch(`${baseUrl}/api/health`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return null;
    const body = await res.json();
    return body?.ok === true ? body : null;
  } catch {
    return null;
  }
}

async function request(baseUrl, path, { method = 'GET', body } = {}) {
  let res;
  try {
    res = await fetch(baseUrl + path, {
      method,
      headers: body === undefined ? undefined : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (err) {
    // No silent local fallback mid-command: re-running locally could double-execute a write.
    throw appError(Codes.DB_ERROR, `lwdb server became unreachable mid-command (${err.message}); re-run the command`);
  }
  let payload = null;
  try { payload = await res.json(); } catch { /* non-JSON body */ }
  if (!res.ok) {
    const e = payload?.error;
    throw appError(e?.code || Codes.DB_ERROR, e?.message || `daemon request failed: ${res.status} ${method} ${path}`);
  }
  return payload;
}

/**
 * Backend with the same surface as the CLI's local backend (bin/lwdb.mjs),
 * but every call goes through the running server's HTTP API.
 */
export function createDaemonBackend(baseUrl, { actor = 'cli' } = {}) {
  const e = encodeURIComponent;
  return {
    kind: 'daemon',
    listServers: async () => (await request(baseUrl, '/api/servers')).servers,
    listDatabases: async (id) => (await request(baseUrl, `/api/servers/${e(id)}/databases`)).databases,
    listTables: async (id, db) => (await request(baseUrl, `/api/servers/${e(id)}/databases/${e(db)}/tables`)).tables,
    describeTable: (id, db, table) => request(baseUrl, `/api/servers/${e(id)}/databases/${e(db)}/tables/${e(table)}`),
    fetchSchema: (id, db) => request(baseUrl, `/api/servers/${e(id)}/databases/${e(db)}/schema`),
    fetchContext: (id, db) => request(baseUrl, `/api/servers/${e(id)}/databases/${e(db)}/context`),
    profileTable: (id, db, table, opts = {}) => {
      const qs = new URLSearchParams();
      if (opts.columns?.length) qs.set('columns', opts.columns.join(','));
      if (opts.top !== undefined) qs.set('top', String(opts.top));
      if (opts.sampleSize !== undefined) qs.set('sample', String(opts.sampleSize));
      if (opts.exact) qs.set('exact', '1');
      const suffix = qs.size ? `?${qs}` : '';
      return request(baseUrl, `/api/servers/${e(id)}/databases/${e(db)}/tables/${e(table)}/profile${suffix}`);
    },
    runQuery: ({ server, db, sql, writable, limit }) =>
      request(baseUrl, '/api/query', { method: 'POST', body: { server, db, sql, writable, limit, actor } }),
    listSnippets: async () => (await request(baseUrl, '/api/snippets')).snippets,
    saveSnippet: async (snippet) => (await request(baseUrl, '/api/snippets', { method: 'POST', body: snippet })).snippet,
    runSnippet: (snippet, { server, db, params, ops, writable, limit }) =>
      request(baseUrl, `/api/snippets/${e(snippet.id)}/run`, { method: 'POST', body: { server, db, params, ops, writable, limit, actor } }),
    testConnection: (spec) => request(baseUrl, '/api/connections/test', { method: 'POST', body: spec }),
    getAgentWrites: async () => (await request(baseUrl, '/api/preferences')).preferences?.agentWrites === true,
  };
}
