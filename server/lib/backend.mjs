/**
 * The backend interface both the CLI and the MCP server consume. Two
 * implementations share one surface:
 *   - local: an in-process registry + MySQL pool (this file)
 *   - daemon: HTTP forwarding to a running `lwdb serve` (daemonClient.mjs)
 *
 * `resolveBackend()` picks the daemon when one is healthy on 127.0.0.1:port
 * (warm pools, no second SQLite handle) and falls back to local otherwise.
 */
import { safeConnection } from './connectionStore.mjs';
import { listDatabases, listTables, describeTable, fetchSchema, pingConnection } from './pool.mjs';
import { runQuery } from './runQuery.mjs';
import { bindParams } from './snippets.mjs';

export const AGENT_WRITES_KEY = 'agentWrites';

/**
 * Local backend over an in-process registry. Non-daemon callers reach the
 * SQLite stores directly via `backend.registry`. `actor` tags this interface's
 * queries in the history audit log (cli / mcp / ui).
 */
export function createLocalBackend(registry, { actor = 'cli' } = {}) {
  const backend = {
    kind: 'local',
    registry,
    listServers: async () => registry.listConnections().map(safeConnection),
    listDatabases: async (id) => listDatabases(registry.getConnection(id)),
    listTables: async (id, db) => listTables(registry.getConnection(id), db),
    describeTable: async (id, db, table) => describeTable(registry.getConnection(id), db, table),
    fetchSchema: async (id, db) => fetchSchema(registry.getConnection(id), db),
    fetchContext: async (id, db) => {
      const { fetchContext } = await import('./context.mjs');
      const annotations = registry.annotations.list({ server: id, db });
      return fetchContext(registry.getConnection(id), db, { annotations });
    },
    profileTable: async (id, db, table, opts) => {
      const { profileTable } = await import('./profile.mjs');
      return profileTable(registry.getConnection(id), db, table, opts);
    },
    runQuery: async ({ server, db, sql, args, writable, limit, snippetId }) => runQuery({
      connection: registry.getConnection(server), db, sql, args, writable, limit,
      history: registry.history, snippetId, actor, config: registry.config,
    }),
    listSnippets: async () => registry.snippets.list(),
    saveSnippet: async (snippet) => registry.snippets.create(snippet),
    runSnippet: async (snippet, { server, db, params, ops, writable, limit }) => {
      const { sql, args } = bindParams(snippet.sql, params, ops);
      const result = await backend.runQuery({ server, db, sql, args, writable, limit, snippetId: snippet.id });
      return { ...result, snippet: { id: snippet.id, name: snippet.name } };
    },
    testConnection: async (spec) => {
      const conn = spec.id ? registry.connectionStore.get(spec.id) : spec;
      if (!conn || !conn.host) throw new Error(spec.id ? `connection not found: ${spec.id}` : 'host required');
      return pingConnection(conn, { timeoutMs: 5000 });
    },
    getAgentWrites: async () => registry.preferences.get(AGENT_WRITES_KEY, false) === true,
  };
  return backend;
}

/**
 * Request human approval for one write and wait until a person resolves it in a
 * connected client (desktop app / browser). Returns the terminal approval object
 * (status approved|denied|error), or a synthetic 'timeout' if nobody answered in
 * time. Requires a daemon backend — the approval queue lives in that process.
 */
export async function awaitApproval(backend, { server, db, sql }, { timeoutMs = 120_000, pollMs = 1000, onPending } = {}) {
  if (typeof backend.requestApproval !== 'function') {
    const err = new Error('Interactive approval needs a running lwdb server (desktop app or `lwdb serve`).');
    err.code = 'NO_DAEMON';
    throw err;
  }
  const approval = await backend.requestApproval({ server, db, sql });
  if (onPending) onPending(approval);
  const deadline = Date.now() + timeoutMs;
  let current = approval;
  while (current.status === 'pending') {
    if (Date.now() > deadline) return { ...current, status: 'timeout' };
    await new Promise((r) => setTimeout(r, pollMs));
    current = await backend.getApproval(approval.id);
  }
  return current;
}

/**
 * Pick a backend. When `allowDaemon` and a healthy lwdb server is listening,
 * forward to it; otherwise open a local registry. Returns `{ backend, registry }`
 * — `registry` is null for the daemon path (the caller never opened SQLite).
 */
export async function resolveBackend({ allowDaemon = true, actor = 'cli' } = {}) {
  if (allowDaemon && process.env.LW_DB_NO_DAEMON !== '1') {
    const { loadConfig } = await import('./config.mjs');
    const config = await loadConfig();
    const baseUrl = `http://${config.host}:${config.port}`;
    const { detectDaemon, createDaemonBackend } = await import('./daemonClient.mjs');
    if (await detectDaemon(baseUrl)) return { backend: createDaemonBackend(baseUrl, { actor }), registry: null };
  }
  const { buildRegistry } = await import('./registry.mjs');
  const registry = await buildRegistry();
  return { backend: createLocalBackend(registry, { actor }), registry };
}
