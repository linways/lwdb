/**
 * lwdb MCP server (stdio transport). Exposes lwdb's explore/query surface as
 * MCP tools so any MCP client (Claude Desktop, Cursor, Claude Code, …) can mount
 * it with one config line — no shell, no skill install required.
 *
 * It's the same core the CLI uses: tools wrap the shared backend interface
 * (server/lib/backend.mjs), reusing a running `lwdb serve`'s warm pools when one
 * is up. The dual write gate (agentWrites pref + explicit confirm) is enforced
 * here exactly as on the CLI.
 *
 * stdout carries ONLY newline-delimited JSON-RPC; all logging goes to stderr.
 */
import { createInterface } from 'node:readline';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

import { createMcpServer, JSONRPC } from './lib/mcpServer.mjs';
import { inspectSql } from './lib/sqlGuard.mjs';
import { buildSampleSql } from './lib/profile.mjs';
import { appError, Codes } from './lib/errors.mjs';

const S = (props, required = []) => ({ type: 'object', properties: props, ...(required.length ? { required } : {}) });
const str = (description) => ({ type: 'string', description });
const int = (description) => ({ type: 'integer', description });

function findSnippet(snippets, key) {
  const lower = key.toLowerCase();
  return snippets.find((s) => s.id === key)
    || snippets.find((s) => s.name.toLowerCase() === lower)
    || snippets.find((s) => s.name.toLowerCase().includes(lower));
}

/**
 * Resolve whether a write should run. Read-only SQL never gates. A write needs
 * BOTH the human-set agentWrites pref AND an explicit writable=true on the call.
 */
async function resolveWritable(sql, writable, backend) {
  let info;
  try { info = inspectSql(sql); } catch { return false; }
  if (info.allReadOnly) return false;
  if (!(await backend.getAgentWrites())) {
    throw appError(Codes.AGENT_WRITES_DISABLED, 'Writes are disabled. A human must enable Settings → AI Agents → "Allow agent writes", then you retry with writable=true after they confirm.');
  }
  if (!writable) {
    throw appError(Codes.CONFIRM_REQUIRED, 'This statement writes data (INSERT/UPDATE/DELETE/DDL). Ask the user to confirm, then retry with writable=true.');
  }
  return true;
}

/** Build the lwdb tool set over a resolved backend. */
export function buildLwdbTools(backend) {
  return [
    {
      name: 'list_servers',
      description: 'List configured MySQL servers (connections). No credentials are exposed.',
      inputSchema: S({}),
      handler: () => backend.listServers(),
    },
    {
      name: 'list_databases',
      description: 'List databases on a server.',
      inputSchema: S({ server: str('Server id from list_servers') }, ['server']),
      handler: ({ server }) => backend.listDatabases(server).then((databases) => ({ databases })),
    },
    {
      name: 'list_tables',
      description: 'List tables in a database, with approximate row counts.',
      inputSchema: S({ server: str('Server id'), db: str('Database name') }, ['server', 'db']),
      handler: ({ server, db }) => backend.listTables(server, db).then((tables) => ({ tables })),
    },
    {
      name: 'describe_table',
      description: 'Columns and indexes for one table.',
      inputSchema: S({ server: str('Server id'), db: str('Database'), table: str('Table name') }, ['server', 'db', 'table']),
      handler: ({ server, db, table }) => backend.describeTable(server, db, table),
    },
    {
      name: 'get_schema',
      description: 'Bulk table→columns map (with primary keys) for a database, in one call.',
      inputSchema: S({ server: str('Server id'), db: str('Database') }, ['server', 'db']),
      handler: ({ server, db }) => backend.fetchSchema(server, db),
    },
    {
      name: 'get_context',
      description: 'Compact, LLM-optimized brief of a database: tables grouped by prefix, columns with types/keys, real and naming-inferred foreign keys (arrows ending in ? are inferred, not real constraints), row estimates, and any saved annotations. Prefer this when orienting in an unfamiliar database.',
      inputSchema: S({ server: str('Server id'), db: str('Database') }, ['server', 'db']),
      handler: ({ server, db }) => backend.fetchContext(server, db),
    },
    {
      name: 'sample_table',
      description: 'Return a few real rows from a table (SELECT * LIMIT n).',
      inputSchema: S({ server: str('Server id'), db: str('Database'), table: str('Table'), limit: int('Rows to return (default 5, max 100)') }, ['server', 'db', 'table']),
      handler: ({ server, db, table, limit }) =>
        backend.runQuery({ server, db, sql: buildSampleSql(db, table, limit), writable: false }),
    },
    {
      name: 'profile_table',
      description: 'Per-column stats over a bounded sample: null %, distinct count, min/max, and top values for low-cardinality columns. Use before writing a WHERE clause.',
      inputSchema: S({
        server: str('Server id'), db: str('Database'), table: str('Table'),
        columns: { type: 'array', items: { type: 'string' }, description: 'Restrict to these columns (default: all)' },
        top: int('Top values per low-cardinality column (default 5)'),
        sample: int('Sample size (default 10000)'),
        exact: { type: 'boolean', description: 'Full-table scan instead of a sample (slower)' },
      }, ['server', 'db', 'table']),
      handler: ({ server, db, table, columns, top, sample, exact }) =>
        backend.profileTable(server, db, table, { columns: columns || null, top, sampleSize: sample, exact: !!exact }),
    },
    {
      name: 'run_query',
      description: 'Run one SQL statement. Read-only by default (SELECT/SHOW/DESCRIBE/EXPLAIN). For a write, either set writable=true (needs the human-set "Allow agent writes" preference) OR set await_approval=true to have a human approve THIS exact statement live in the lwdb app (needs a running server; no global switch required). Bare SELECTs are auto-limited.',
      inputSchema: S({
        server: str('Server id'), db: str('Database (optional)'), sql: str('A single SQL statement'),
        limit: int('Row limit for SELECT (default 500, max 5000)'),
        writable: { type: 'boolean', description: 'Confirm a write (with the global agent-writes switch on)' },
        await_approval: { type: 'boolean', description: 'Wait for a human to approve this exact write in the lwdb app (per-write consent; alternative to the global switch)' },
      }, ['server', 'sql']),
      handler: async ({ server, db, sql, limit, writable, await_approval }) => {
        if (await_approval) {
          let info;
          try { info = inspectSql(sql); } catch { info = null; }
          if (!info || !info.allReadOnly) {
            const { awaitApproval } = await import('./lib/backend.mjs');
            const final = await awaitApproval(backend, { server, db: db || null, sql });
            if (final.status === 'approved') return final.result;
            if (final.status === 'denied') throw appError(Codes.CONFIRM_REQUIRED, 'Write denied by the user.');
            if (final.status === 'timeout') throw appError(Codes.TIMEOUT, 'Approval timed out — nobody responded.');
            throw appError(final.error?.code || Codes.DB_ERROR, final.error?.message || 'Approval failed');
          }
        }
        return backend.runQuery({ server, db: db || null, sql, limit, writable: await resolveWritable(sql, writable, backend) });
      },
    },
    {
      name: 'list_snippets',
      description: 'List saved query templates (snippets).',
      inputSchema: S({ pattern: str('Filter by name/description substring') }),
      handler: async ({ pattern }) => {
        let list = await backend.listSnippets();
        if (pattern) {
          const p = pattern.toLowerCase();
          list = list.filter((s) => s.name.toLowerCase().includes(p) || (s.description || '').toLowerCase().includes(p));
        }
        return { snippets: list };
      },
    },
    {
      name: 'run_snippet',
      description: 'Run a saved snippet by name or id, binding :params. Same write gate as run_query.',
      inputSchema: S({
        snippet: str('Snippet name or id'),
        server: str('Server id (defaults to the snippet\'s defaultServer)'),
        db: str('Database (defaults to the snippet\'s defaultDb)'),
        params: { type: 'object', description: 'Named parameter values, e.g. {"studentId": 123}' },
        ops: { type: 'object', description: 'Per-param operator overrides, e.g. {"name": "like_contains"}' },
        limit: int('Row limit'),
        writable: { type: 'boolean', description: 'Confirm a write' },
      }, ['snippet']),
      handler: async ({ snippet, server, db, params, ops, limit, writable }) => {
        const found = findSnippet(await backend.listSnippets(), snippet);
        if (!found) throw appError(Codes.NOT_FOUND, `Snippet not found: ${snippet}`);
        const targetServer = server || found.defaultServer;
        if (!targetServer) throw appError(Codes.BAD_REQUEST, 'server required (snippet has no defaultServer)');
        return backend.runSnippet(found, {
          server: targetServer, db: db || found.defaultDb, params: params || {}, ops: ops || {},
          limit, writable: await resolveWritable(found.sql, writable, backend),
        });
      },
    },
    {
      name: 'save_snippet',
      description: 'Create or update a reusable query template (idempotent by name). Use :paramName placeholders for parameters.',
      inputSchema: S({
        name: str('Unique snippet name'), sql: str('SQL with optional :param placeholders'),
        description: str('What it does'),
        tags: { type: 'array', items: { type: 'string' } },
        defaultServer: str('Default server id'), defaultDb: str('Default database'),
      }, ['name', 'sql']),
      handler: ({ name, sql, description, tags, defaultServer, defaultDb }) =>
        backend.saveSnippet({ name, sql, description: description || '', tags: tags || [], defaultServer: defaultServer || null, defaultDb: defaultDb || null }),
    },
  ];
}

async function lwdbVersion() {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const pkg = JSON.parse(await readFile(join(resolve(here, '..'), 'package.json'), 'utf8'));
    return pkg.version || '0.0.0';
  } catch { return '0.0.0'; }
}

/**
 * Run the stdio MCP server. Resolves a backend (daemon when available, else a
 * local registry that keeps MySQL pools warm for the session), then reads
 * newline-delimited JSON-RPC from stdin and writes responses to stdout.
 */
export async function runMcp() {
  const { resolveBackend } = await import('./lib/backend.mjs');
  const { backend } = await resolveBackend({ allowDaemon: true, actor: 'mcp' });
  const server = createMcpServer({
    serverInfo: { name: 'lwdb', version: await lwdbVersion() },
    tools: buildLwdbTools(backend),
  });

  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of rl) {
    const text = line.trim();
    if (!text) continue;
    let msg;
    try {
      msg = JSON.parse(text);
    } catch {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: JSONRPC.PARSE_ERROR, message: 'Parse error' } }) + '\n');
      continue;
    }
    let res;
    try {
      res = await server.handleMessage(msg);
    } catch (e) {
      res = msg && 'id' in msg ? { jsonrpc: '2.0', id: msg.id, error: { code: JSONRPC.INTERNAL_ERROR, message: e.message } } : null;
    }
    if (res) process.stdout.write(JSON.stringify(res) + '\n');
  }
}
