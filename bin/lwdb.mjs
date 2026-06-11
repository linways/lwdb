#!/usr/bin/env -S node --no-warnings=ExperimentalWarning

// CLI defaults to quiet logging unless the user opts in.
if (!process.env.LW_DB_LOG_LEVEL) process.env.LW_DB_LOG_LEVEL = 'warn';

import { safeConnection } from '../server/lib/connectionStore.mjs';
import { closeAll } from '../server/lib/pool.mjs';
import { inspectSql } from '../server/lib/sqlGuard.mjs';

const AGENT_WRITES_KEY = 'agentWrites';

/**
 * Gate writes from the CLI/agent surface.
 *
 * A write runs only when BOTH are true:
 *   1. the human enabled "Allow agent writes" (server pref, set in Settings)
 *   2. this call carries an explicit confirmation (--yes / --confirm / --writable)
 *
 * Returns true if the statement should run with writes enabled, throws (via die)
 * otherwise. Read-only statements always return false (no gate).
 */
async function resolveWritable(sql, backend) {
  let info;
  try { info = inspectSql(sql); } catch { return false; }
  if (info.allReadOnly) return false; // pure read — no gate needed

  const enabled = await backend.getAgentWrites();
  if (!enabled) {
    die('Writes are disabled for the CLI/agents. A human must enable Settings → AI Agents → "Allow agent writes", then you re-run with --yes after they confirm. (code: AGENT_WRITES_DISABLED)');
  }
  const confirmed = !!(flags.yes || flags.confirm || flags.writable);
  if (!confirmed) {
    die('This statement writes data (INSERT/UPDATE/DELETE/DDL). Ask the user to confirm, then re-run with --yes. (code: CONFIRM_REQUIRED)');
  }
  return true;
}
import {
  backupSqlite, backupJson, restoreJson, restoreSqliteFile,
  defaultBackupPath, looksLikeSqlite, loadJsonBackup,
} from '../server/lib/backup.mjs';

const args = process.argv.slice(2);
const flags = {};
const positional = [];
for (const arg of args) {
  if (arg.startsWith('--')) {
    const eq = arg.indexOf('=');
    if (eq !== -1) flags[arg.slice(2, eq)] = arg.slice(eq + 1);
    else flags[arg.slice(2)] = true;
  } else {
    positional.push(arg);
  }
}

const wantJson = !!flags.json || !process.stdout.isTTY;
const cmd = positional.shift();

function emit(value, { table, columns } = {}) {
  if (wantJson) { process.stdout.write(JSON.stringify(value, null, 2) + '\n'); return; }
  if (table && Array.isArray(value)) { printTable(value, columns); return; }
  if (Array.isArray(value)) {
    for (const r of value) process.stdout.write(typeof r === 'string' ? r + '\n' : JSON.stringify(r) + '\n');
    return;
  }
  if (typeof value === 'string') { process.stdout.write(value + (value.endsWith('\n') ? '' : '\n')); return; }
  process.stdout.write(JSON.stringify(value, null, 2) + '\n');
}

function printTable(rows, columns) {
  if (!rows.length) { process.stdout.write('(no rows)\n'); return; }
  const cols = columns || Object.keys(rows[0]);
  const widths = cols.map((c) =>
    Math.min(60, Math.max(c.length, ...rows.map((r) => String(r[c] ?? '').length)))
  );
  const sep = '+' + widths.map((w) => '-'.repeat(w + 2)).join('+') + '+';
  const fmtRow = (vals) =>
    '| ' + vals.map((v, i) => {
      const s = String(v ?? '');
      return (s.length > widths[i] ? s.slice(0, widths[i] - 1) + '…' : s).padEnd(widths[i]);
    }).join(' | ') + ' |';
  process.stdout.write(sep + '\n');
  process.stdout.write(fmtRow(cols) + '\n');
  process.stdout.write(sep + '\n');
  for (const r of rows) process.stdout.write(fmtRow(cols.map((c) => r[c])) + '\n');
  process.stdout.write(sep + '\n');
  process.stdout.write(`${rows.length} row${rows.length === 1 ? '' : 's'}\n`);
}

function die(msg, code = 1) {
  if (wantJson) process.stdout.write(JSON.stringify({ error: { message: msg } }) + '\n');
  else process.stderr.write(`error: ${msg}\n`);
  process.exit(code);
}

// Machine-readable command catalog for agents (`lwdb --help --json`). Kept in
// sync with the switch below and the text help(). arg.required defaults false.
async function helpJson() {
  const { Codes } = await import('../server/lib/errors.mjs');
  const { readFile } = await import('node:fs/promises');
  const { fileURLToPath } = await import('node:url');
  const { dirname, resolve, join } = await import('node:path');
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  let version = '0.0.0';
  try { version = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')).version || version; } catch { /* default */ }

  const a = (name, required = false) => ({ name, required });
  const cmd = (name, group, summary, args = [], flags = {}) => ({ name, group, summary, args, flags });

  return {
    name: 'lwdb',
    version,
    description: 'Agent-friendly MySQL browser. Every command emits JSON when stdout is not a TTY and fails with a stable error.code.',
    errorCodes: Object.values(Codes),
    globalFlags: {
      json: 'Force JSON output (automatic when stdout is not a TTY).',
      'no-daemon': 'Skip the running lwdb server and connect directly (env: LW_DB_NO_DAEMON=1).',
    },
    writes: 'Writes (INSERT/UPDATE/DELETE/DDL) require the human-set "agent-writes" master switch AND a per-call --yes, and are refused on write-protected connections. Errors: AGENT_WRITES_DISABLED, CONFIRM_REQUIRED, READONLY_BLOCKED.',
    commands: [
      cmd('servers', 'data', 'List configured servers (alias: connections).'),
      cmd('dbs', 'data', 'List databases on a server.', [a('server', true), a('pattern')], { latest: 'Sort descending (date-suffixed dbs).' }),
      cmd('tables', 'data', 'List tables in a database with row estimates.', [a('server', true), a('db', true), a('pattern')]),
      cmd('describe', 'data', 'Columns and indexes for one table.', [a('server', true), a('db', true), a('table', true)]),
      cmd('schema', 'data', 'Bulk table→columns map (incl. PKs) for a database.', [a('server', true), a('db', true)]),
      cmd('context', 'data', 'Compact LLM brief: tables, columns, real+inferred FKs, row counts, annotations.', [a('server', true), a('db', true)]),
      cmd('sample', 'data', 'Return a few real rows (SELECT * LIMIT n).', [a('server', true), a('db', true), a('table', true)], { limit: 'Rows (default 5, max 100).' }),
      cmd('profile', 'data', 'Per-column null%/distinct/min/max/top over a bounded sample.', [a('server', true), a('db', true), a('table', true)], { columns: 'Comma-separated subset.', top: 'Top values (default 5).', sample: 'Sample size (default 10000).', exact: 'Full scan instead of a sample.' }),
      cmd('find-table', 'data', 'Search tables across every db on a server.', [a('server', true), a('pattern', true)]),
      cmd('query', 'data', 'Run one SQL statement (read-only unless writes unlocked).', [a('server', true), a('db'), a('sql', true)], { yes: 'Confirm a write after the user approves.', limit: 'Row limit for SELECT.', approve: 'Wait for a human to approve this exact write live in the lwdb app (needs a running server).', timeout: 'Seconds to wait for --approve (default 120).' }),
      cmd('snippets', 'snippets', 'List saved query templates.', [a('pattern')]),
      cmd('save', 'snippets', 'Create a saved query template.', [a('name', true), a('sql', true)], { description: '', tags: 'Comma-separated.', 'default-server': '', 'default-db': '' }),
      cmd('run', 'snippets', 'Run a snippet by name/id, binding :params.', [a('name', true)], { server: '', db: '', writable: 'Confirm a write.', limit: '' }),
      cmd('delete', 'snippets', 'Delete a snippet by name/id.', [a('name', true)]),
      cmd('push', 'snippets', 'Bulk upsert snippets from JSON (file or stdin).', [a('file')]),
      cmd('schema-snippets', 'snippets', 'Print the JSON shape accepted by push.'),
      cmd('annotate', 'annotations', 'Add/update a note on a table or column (merged into context).', [a('server', true), a('db', true), a('table', true), a('column')], { note: 'The note text (required unless --rm).', source: 'human|agent', rm: 'Delete the note instead.' }),
      cmd('annotations', 'annotations', 'List annotations.', [a('server'), a('db'), a('table')]),
      cmd('history', 'history', 'Recent query history (audit log).', [], { limit: '', server: '', db: '', actor: 'Filter by ui|cli|mcp.' }),
      cmd('history-clear', 'history', 'Wipe the query history.'),
      cmd('backup', 'backup', 'Back up the SQLite store (sqlite or json).', [], { out: '', format: 'sqlite|json' }),
      cmd('restore', 'backup', 'Restore from a backup file.', [a('path', true)], { merge: '' }),
      cmd('conn-add', 'connections', 'Add a connection.', [], { label: 'required', host: 'required', user: 'required', port: '', password: '', color: '', group: '', notes: '', local: '', protected: 'Refuse all agent writes to this connection.' }),
      cmd('conn-edit', 'connections', 'Edit a connection.', [a('id', true)], { label: '', host: '', port: '', user: '', password: '', color: '', group: '', notes: '', local: '', remote: '', protected: 'Mark write-protected.', unprotected: 'Clear write protection.' }),
      cmd('conn-rm', 'connections', 'Delete a connection.', [a('id', true)], { yes: 'required' }),
      cmd('conn-test', 'connections', 'Ping a connection (saved id or inline host/user).', [a('id')], { host: '', user: '', port: '', password: '' }),
      cmd('import', 'connections', 'Bulk upsert connections from JSON.', [a('file', true)]),
      cmd('export', 'connections', 'Dump connections (includes passwords).', [a('file')]),
      cmd('agent-writes', 'system', 'Show or set the master write switch.', [a('on|off')]),
      cmd('secure', 'system', 'Credential encryption status / migrate legacy plaintext passwords.', [a('status|migrate')]),
      cmd('serve', 'system', 'Run the HTTP API + Web UI on :4321.'),
      cmd('mcp', 'system', 'Run the MCP server over stdio for AI clients.'),
      cmd('doctor', 'system', 'Diagnose the install.'),
      cmd('update', 'system', 'git pull + reinstall deps + refresh skill.'),
      cmd('update-skill', 'system', 'Refresh only the agent skill snapshot.'),
      cmd('uninstall', 'system', 'Remove CLI link + skill symlinks.'),
    ],
  };
}

function help() {
  process.stdout.write(`lwdb CLI

USAGE
  lwdb <command> [args] [--flags]

DATA
  servers
  dbs <server> [pattern]            [--latest]
  tables <server> <db> [pattern]
  describe <server> <db> <table>
  schema <server> <db>              # bulk table -> columns map (incl. PK)
  context <server> <db>             # compact LLM brief: tables, cols, keys, inferred FKs, notes
  sample <server> <db> <table>      # SELECT * LIMIT n (n default 5, --limit=N)
  profile <server> <db> <table>     # per-column nulls/distinct/min/max/top [--columns=a,b] [--exact]
  find-table <server> <pattern>     # search tables across every db on a server
  query <server> [db] "<sql>"       [--yes] [--limit=N] [--approve] [--timeout=SEC]
                                       # writes need: agent-writes ON + --yes (user-confirmed)
                                       # OR --approve: a human approves THIS exact write live in
                                       #   the lwdb app (needs a running server; default wait 120s)

CONNECTIONS
  servers | connections             # list connections
  conn-add --label= --host= --user= [--port=3306] [--password=] [--color=] [--group=] [--notes=] [--local] [--protected]
  conn-edit <id> [--label=] [--host=] [--port=] [--user=] [--password=] [--color=] [--group=] [--notes=] [--local|--remote] [--protected|--unprotected]
                                       # --protected: refuse ALL agent writes to this connection (e.g. prod)
  conn-rm <id> --yes
  conn-test <id>                    # or: --host= --user= [--port=] [--password=]
  import <file.json>                # bulk upsert connections (universal format)
  export [file.json]                # dump connections (includes passwords)

SERVER (GUI backend)
  serve                             # run the HTTP API + Web UI on :4321
                                       # (this is what the desktop app launches)

MCP (Model Context Protocol — for any AI client)
  mcp                               # run the MCP server over stdio
                                       # config one line: { "command": "lwdb", "args": ["mcp"] }

SAVED QUERIES
  snippets [pattern]
  save <name> "<sql>" [--description=] [--default-server=] [--default-db=] [--tags=a,b]
  run <name-or-id> [--server=] [--db=] [--<param>=value...] [--<param>-op=<op>...] [--writable] [--limit=N]
                                       # operator keys: eq (default), like, like_contains,
                                       #   like_starts, like_ends, neq, not_like
  delete <name-or-id>
  push [file]                       # bulk upsert from JSON (file or stdin)
  schema-snippets                   # print expected JSON shape (for AI agents)

ANNOTATIONS (semantic notes merged into context)
  annotate <server> <db> <table> [column] --note="..."   # add/update a note (--rm to delete)
  annotations [server] [db] [table]                       # list notes

HISTORY
  history [--limit=N] [--server=...] [--db=...] [--actor=ui|cli|mcp]
  history-clear

BACKUP / RESTORE
  backup [--out=path.sqlite|path.json] [--format=sqlite|json]
  restore <path>  [--merge]

SYSTEM
  doctor                            # diagnose the install
  update                            # git pull + reinstall deps + refresh skill
  update-skill                      # refresh only the agent skill snapshot
  uninstall                         # remove CLI link + skill symlinks
  agent-writes [on|off]             # show or set the master switch for CLI/agent writes
  secure [status|migrate]           # passwords are AES-256-GCM encrypted at rest; migrate re-encrypts legacy rows
  (first-time install: npm run setup  — or: node install.mjs install)

OUTPUT
  --json        Force JSON (auto when not a TTY).

DAEMON
  MySQL commands reuse a running lwdb server (desktop app / lwdb serve) on
  127.0.0.1:4321 automatically — warm pools, same output, same write gate.
  --no-daemon   Skip detection and connect directly (env: LW_DB_NO_DAEMON=1).

EXAMPLES
  lwdb dbs V4-server84 stthomas --latest
  lwdb query V4-server84 test_stthomas_db2104 "SELECT id, name FROM students LIMIT 3"
  lwdb run student-info --studentId=12345 --server=V4-server84 --db=test_stthomas_db2104
  lwdb backup --format=sqlite --out=/tmp/lwdb-$(date +%F).sqlite

  # AI bulk push from stdin:
  cat << 'EOF' | lwdb push
  [
    { "name": "student-by-id", "description": "Lookup student by id",
      "sql": "SELECT * FROM students WHERE student_id = :id",
      "tags": ["students"], "defaultServer": "V4-server84" },
    { "name": "attendance-summary",
      "sql": "SELECT student_id, COUNT(*) FROM attendance WHERE date BETWEEN :from AND :to GROUP BY student_id" }
  ]
  EOF
`);
}

function findSnippet(snippets, key) {
  const lower = key.toLowerCase();
  return snippets.find((s) => s.id === key)
    || snippets.find((s) => s.name.toLowerCase() === lower)
    || snippets.find((s) => s.name.toLowerCase().includes(lower));
}

function pickParams(flags, reserved = new Set([
  'json', 'writable', 'server', 'db', 'latest', 'description', 'default-server', 'default-db', 'tags', 'limit', 'merge', 'out', 'format',
])) {
  const params = {};
  const ops = {};
  for (const [k, v] of Object.entries(flags)) {
    if (reserved.has(k)) continue;
    if (k.endsWith('-op')) {
      // --<param>-op=<operator> — see snippets.mjs OPERATORS for valid keys.
      ops[k.slice(0, -3)] = v === true ? '' : v;
      continue;
    }
    params[k] = v === true ? '' : v;
  }
  return { params, ops };
}

// Lifecycle commands delegate to install.mjs (the single source of truth for
// install/update/uninstall/skill/doctor) so users run `lwdb update` instead of
// `node install.mjs update`. Runs without opening the SQLite registry.
async function runInstaller(sub) {
  const { spawnSync } = await import('node:child_process');
  const { fileURLToPath } = await import('node:url');
  const { dirname, resolve, join } = await import('node:path');
  const here = dirname(fileURLToPath(import.meta.url));
  const installScript = join(resolve(here, '..'), 'install.mjs');
  const result = spawnSync(process.execPath, [installScript, sub], { stdio: 'inherit' });
  process.exit(result.status ?? 0);
}

const INSTALLER_COMMANDS = new Set(['install', 'update', 'uninstall', 'update-skill', 'doctor']);

// Commands worth forwarding to an already-running lwdb server: they reuse its
// warm MySQL pools (no per-invocation connect) and skip loading mysql2 here.
// SQLite-only commands (servers, snippets, history, ...) stay local — they're
// cheaper than the HTTP hop. Lifecycle/store-mutating commands always run locally.
const DAEMON_COMMANDS = new Set([
  'dbs', 'tables', 'describe', 'schema', 'context', 'sample', 'profile',
  'find-table', 'query', 'run', 'conn-test',
]);

async function pickBackend() {
  const allowDaemon = !flags['no-daemon'] && DAEMON_COMMANDS.has(cmd);
  const { resolveBackend } = await import('../server/lib/backend.mjs');
  const { backend } = await resolveBackend({ allowDaemon, actor: 'cli' });
  return backend;
}

async function main() {
  if (!cmd || cmd === 'help' || cmd === '-h' || cmd === '--help') {
    // Help stays human-readable even when piped; only an explicit --json yields
    // the machine catalog (so `lwdb --help | less` still shows text).
    if (flags.json) { process.stdout.write(JSON.stringify(await helpJson(), null, 2) + '\n'); return; }
    help();
    return;
  }
  if (INSTALLER_COMMANDS.has(cmd)) return runInstaller(cmd);
  const backend = await pickBackend();
  const registry = backend.registry || null;

  switch (cmd) {
    case 'servers':
    case 'connections': {
      emit(await backend.listServers(), {
        table: true, columns: ['id', 'label', 'kind', 'host', 'port', 'user'],
      });
      break;
    }

    case 'dbs': {
      const [server, pattern] = positional;
      if (!server) die('usage: lwdb dbs <server> [pattern]');
      let dbs = await backend.listDatabases(server);
      if (pattern) {
        const p = pattern.toLowerCase();
        dbs = dbs.filter((d) => d.toLowerCase().includes(p));
      }
      if (flags.latest) dbs = [...dbs].sort().reverse();
      emit(dbs.map((name) => ({ name })), { table: true, columns: ['name'] });
      break;
    }

    case 'tables': {
      const [server, db, pattern] = positional;
      if (!server || !db) die('usage: lwdb tables <server> <db> [pattern]');
      let tables = await backend.listTables(server, db);
      if (pattern) {
        const p = pattern.toLowerCase();
        tables = tables.filter((t) => t.name.toLowerCase().includes(p));
      }
      emit(tables, { table: true, columns: ['name', 'rowsApprox', 'type'] });
      break;
    }

    case 'describe': {
      const [server, db, table] = positional;
      if (!server || !db || !table) die('usage: lwdb describe <server> <db> <table>');
      const desc = await backend.describeTable(server, db, table);
      if (wantJson) { emit(desc); break; }
      process.stdout.write(`\n${db}.${table} — columns\n`);
      printTable(desc.columns, ['name', 'type', 'nullable', 'keyKind', 'defaultValue', 'extra']);
      process.stdout.write(`\n${db}.${table} — indexes\n`);
      printTable(desc.indexes, ['Key_name', 'Column_name', 'Non_unique', 'Index_type']);
      break;
    }

    case 'schema': {
      const [server, db] = positional;
      if (!server || !db) die('usage: lwdb schema <server> <db>');
      const schema = await backend.fetchSchema(server, db);
      if (wantJson) { emit(schema); break; }
      const rows = Object.entries(schema.tables).map(([name, cols]) => ({
        table: name,
        columns: cols.length,
        primaryKey: (schema.primaryKeys[name] || []).join(', ') || '—',
      }));
      printTable(rows, ['table', 'columns', 'primaryKey']);
      process.stdout.write(`\n${Object.keys(schema.tables).length} tables · ${schema.columnCount} columns\n`);
      break;
    }

    case 'context': {
      const [server, db] = positional;
      if (!server || !db) die('usage: lwdb context <server> <db>');
      const ctx = await backend.fetchContext(server, db);
      if (wantJson) { emit(ctx); break; }
      process.stdout.write(`${ctx.db} @ ${ctx.server} — ${ctx.tableCount} tables · ${ctx.columnCount} columns\n`);
      for (const [prefix, members] of Object.entries(ctx.groups || {})) {
        process.stdout.write(`  group ${prefix}: ${members.length} tables\n`);
      }
      for (const [name, t] of Object.entries(ctx.tables)) {
        const rows = t.rows == null ? '' : ` (~${t.rows} rows)`;
        const comment = t.comment ? `  // ${t.comment}` : '';
        process.stdout.write(`\n## ${name}${rows}${comment}\n`);
        for (const c of t.columns) process.stdout.write(`  ${c}\n`);
      }
      if (ctx.notes?.length) process.stdout.write(`\n${ctx.notes.map((n) => `note: ${n}`).join('\n')}\n`);
      break;
    }

    case 'sample': {
      const [server, db, table] = positional;
      if (!server || !db || !table) die('usage: lwdb sample <server> <db> <table> [--limit=5]');
      const { buildSampleSql } = await import('../server/lib/profile.mjs');
      const result = await backend.runQuery({
        server, db, sql: buildSampleSql(db, table, flags.limit), writable: false,
      });
      if (wantJson) emit(result);
      else {
        if (result.rows?.length) printTable(result.rows);
        else process.stdout.write('(no rows)\n');
      }
      break;
    }

    case 'profile': {
      const [server, db, table] = positional;
      if (!server || !db || !table) die('usage: lwdb profile <server> <db> <table> [--columns=a,b] [--top=5] [--sample=10000] [--exact]');
      const prof = await backend.profileTable(server, db, table, {
        columns: flags.columns ? String(flags.columns).split(',').map((s) => s.trim()).filter(Boolean) : null,
        top: flags.top ? parseInt(flags.top, 10) : undefined,
        sampleSize: flags.sample ? parseInt(flags.sample, 10) : undefined,
        exact: !!flags.exact,
      });
      if (wantJson) { emit(prof); break; }
      process.stdout.write(`${prof.db}.${prof.table} @ ${prof.server} — ${prof.rowsScanned} rows scanned${prof.exact ? ' (exact)' : ' (sample)'}\n\n`);
      const rows = Object.entries(prof.columns).map(([name, s]) => ({
        column: name, type: s.type, nulls: `${s.nullPct}%`, distinct: s.distinct,
        min: s.min, max: s.max,
        top: s.top ? s.top.map((t) => `${t.v}(${t.n})`).join(' ') : '',
      }));
      printTable(rows, ['column', 'type', 'nulls', 'distinct', 'min', 'max', 'top']);
      if (prof.notes?.length) process.stdout.write(`\n${prof.notes.map((n) => `note: ${n}`).join('\n')}\n`);
      break;
    }

    case 'find-table': {
      const [server, pattern] = positional;
      if (!server || !pattern) die('usage: lwdb find-table <server> <pattern>');
      const dbs = await backend.listDatabases(server);
      const p = pattern.toLowerCase();
      const matches = [];
      for (const db of dbs) {
        try {
          const tables = await backend.listTables(server, db);
          for (const t of tables) {
            if (t.name.toLowerCase().includes(p)) matches.push({ db, table: t.name, rowsApprox: t.rowsApprox });
          }
        } catch (_) { /* skip db we can't read */ }
      }
      emit(matches, { table: true, columns: ['db', 'table', 'rowsApprox'] });
      break;
    }

    case 'query': {
      const server = positional.shift();
      if (!server) die('usage: lwdb query <server> [db] "<sql>"');
      let db = null, sql = null;
      if (positional.length >= 2) { db = positional[0]; sql = positional.slice(1).join(' '); }
      else if (positional.length === 1) { sql = positional[0]; }
      if (!sql) die('SQL required');

      // --approve: ask a human to approve THIS write live in the lwdb app, instead
      // of relying on the global agent-writes switch. Needs a running server.
      if (flags.approve) {
        let info; try { info = inspectSql(sql); } catch { info = null; }
        if (info && info.allReadOnly) {
          // read-only — no approval needed; just run it.
          const ro = await backend.runQuery({ server, db, sql, writable: false, limit: flags.limit ? parseInt(flags.limit, 10) : undefined });
          emit(ro);
          break;
        }
        const { awaitApproval } = await import('../server/lib/backend.mjs');
        let final;
        try {
          final = await awaitApproval(backend, { server, db, sql }, {
            timeoutMs: flags.timeout ? parseInt(flags.timeout, 10) * 1000 : 120_000,
            onPending: (a) => { if (!wantJson) process.stderr.write(`Waiting for a human to approve in the lwdb app (${a.id}):\n  ${sql}\n`); },
          });
        } catch (err) { die(`${err.message} (code: ${err.code || 'DB_ERROR'})`); }
        if (final.status === 'approved') { emit(final.result); break; }
        if (final.status === 'denied') die('Write denied by the user. (code: CONFIRM_REQUIRED)');
        if (final.status === 'timeout') die('Approval timed out — nobody responded. (code: TIMEOUT)');
        die(`${final.error?.message || 'approval failed'} (code: ${final.error?.code || 'DB_ERROR'})`);
      }

      const result = await backend.runQuery({
        server,
        db,
        sql,
        writable: await resolveWritable(sql, backend),
        limit: flags.limit ? parseInt(flags.limit, 10) : undefined,
      });
      if (wantJson) emit(result);
      else {
        if (result.rows && result.rows.length) printTable(result.rows);
        else process.stdout.write(`(${result.verb}) affected: ${result.rowCount}\n`);
        process.stdout.write(`\n${result.elapsedMs} ms\n`);
      }
      break;
    }

    case 'snippets': {
      const [pattern] = positional;
      let list = registry.snippets.list();
      if (pattern) {
        const p = pattern.toLowerCase();
        list = list.filter((s) => s.name.toLowerCase().includes(p) || (s.description || '').toLowerCase().includes(p));
      }
      emit(list, { table: true, columns: ['name', 'params', 'description', 'defaultServer', 'defaultDb'] });
      break;
    }

    case 'save': {
      const name = positional.shift();
      const sql = positional.shift();
      if (!name || !sql) die('usage: lwdb save <name> "<sql>" [...flags]');
      const snippet = registry.snippets.create({
        name,
        sql,
        description: flags.description || '',
        tags: flags.tags ? String(flags.tags).split(',').map((t) => t.trim()).filter(Boolean) : [],
        defaultServer: flags['default-server'] || null,
        defaultDb: flags['default-db'] || null,
      });
      emit(snippet);
      break;
    }

    case 'delete': {
      const key = positional.shift();
      if (!key) die('usage: lwdb delete <name-or-id>');
      const snippet = findSnippet(registry.snippets.list(), key);
      if (!snippet) die(`snippet not found: ${key}`);
      registry.snippets.remove(snippet.id);
      emit({ deleted: snippet.name });
      break;
    }

    case 'run': {
      const key = positional.shift();
      if (!key) die('usage: lwdb run <snippet-name-or-id> [--param=value ...]');
      const snippet = findSnippet(await backend.listSnippets(), key);
      if (!snippet) die(`snippet not found: ${key}`);
      const targetServer = flags.server || snippet.defaultServer;
      const targetDb = flags.db || snippet.defaultDb;
      if (!targetServer) die('--server required (snippet has no defaultServer)');
      const { params, ops } = pickParams(flags);
      // Binding :params never changes the statement verb, so gating on the raw
      // snippet SQL is equivalent to gating on the bound SQL.
      const result = await backend.runSnippet(snippet, {
        server: targetServer, db: targetDb, params, ops,
        writable: await resolveWritable(snippet.sql, backend),
        limit: flags.limit ? parseInt(flags.limit, 10) : undefined,
      });
      if (wantJson) emit(result);
      else {
        process.stdout.write(`★ ${snippet.name}  →  ${targetServer}.${targetDb || '(no db)'}\n`);
        if (result.rows && result.rows.length) printTable(result.rows);
        else process.stdout.write(`(${result.verb}) affected: ${result.rowCount}\n`);
        process.stdout.write(`\n${result.elapsedMs} ms\n`);
      }
      break;
    }

    case 'history': {
      const limit = flags.limit ? parseInt(flags.limit, 10) : 20;
      const entries = registry.history.recent({
        limit, server: flags.server || null, db: flags.db || null, actor: flags.actor || null,
      });
      emit(entries, { table: true, columns: ['startedAt', 'actor', 'server', 'db', 'verb', 'elapsedMs', 'rowCount', 'sql'] });
      break;
    }

    case 'history-clear': {
      registry.history.clear();
      emit({ cleared: true });
      break;
    }

    case 'annotate': {
      // annotate <server> <db> <table> [column] --note="..."  (or --rm to delete)
      const [server, db, table, column] = positional;
      if (!server || !db || !table) die('usage: lwdb annotate <server> <db> <table> [column] --note="..."  [--rm]');
      if (flags.rm) {
        const ok = registry.annotations.remove({ server, db, tbl: table, col: column || null });
        if (!ok) die(`no annotation on ${db}.${table}${column ? `.${column}` : ''}`);
        emit({ removed: { server, db, table, column: column || null } });
        break;
      }
      if (!flags.note || flags.note === true) die('--note="..." required (or --rm to delete)');
      const annotation = registry.annotations.upsert({
        server, db, tbl: table, col: column || null, note: flags.note, source: flags.source || 'human',
      });
      emit(annotation);
      break;
    }

    case 'annotations': {
      const [server, db, table] = positional;
      const list = registry.annotations.list({ server: server || undefined, db: db || undefined, tbl: table || undefined });
      emit(list, { table: true, columns: ['server', 'db', 'tbl', 'col', 'note', 'source'] });
      break;
    }

    case 'backup': {
      const format = flags.format || (flags.out && looksLikeSqlite(flags.out) ? 'sqlite' : 'json');
      const outPath = flags.out || defaultBackupPath(registry.dataDir, format);
      const info = format === 'sqlite'
        ? await backupSqlite(registry, outPath)
        : await backupJson(registry, outPath);
      emit(info);
      break;
    }

    case 'restore': {
      const path = positional.shift();
      if (!path) die('usage: lwdb restore <path> [--merge]');
      if (looksLikeSqlite(path)) {
        const info = await restoreSqliteFile(registry, path);
        emit(info);
        break;
      }
      const payload = await loadJsonBackup(path);
      const result = await restoreJson(registry, payload, { merge: !!flags.merge });
      emit(result);
      break;
    }

    case 'push': {
      const file = positional.shift();
      let text;
      if (file) {
        const { readFile } = await import('node:fs/promises');
        text = await readFile(file, 'utf8');
      } else {
        text = await new Promise((resolve, reject) => {
          let buf = '';
          process.stdin.setEncoding('utf8');
          process.stdin.on('data', (c) => { buf += c; });
          process.stdin.on('end', () => resolve(buf));
          process.stdin.on('error', reject);
        });
      }
      if (!text || !text.trim()) die('no JSON input on stdin or file');
      let payload;
      try { payload = JSON.parse(text); } catch (err) { die(`invalid JSON: ${err.message}`); }
      const items = Array.isArray(payload) ? payload : (payload.snippets || []);
      if (!items.length) die('no snippets in payload');
      const result = registry.snippets.bulkUpsert(items);
      if (wantJson) emit({ count: result.length, result });
      else {
        emit(result, { table: true, columns: ['status', 'name', 'id'] });
      }
      break;
    }

    case 'schema-snippets': {
      const schema = {
        description: 'JSON shape accepted by `lwdb push`. Top-level may be an array of snippets OR { "snippets": [...] }.',
        snippet: {
          name: 'string (required, unique by name for upsert)',
          sql: 'string (required, use :paramName for parameters)',
          description: 'string (optional)',
          tags: 'string[] (optional)',
          defaultServer: 'string (optional, server id from `lwdb servers`)',
          defaultDb: 'string (optional)',
        },
        example: [
          {
            name: 'student-by-id',
            description: 'Lookup student by id',
            sql: 'SELECT * FROM students WHERE student_id = :id',
            tags: ['students'],
            defaultServer: 'V4-server84',
            defaultDb: null,
          },
        ],
      };
      process.stdout.write(JSON.stringify(schema, null, 2) + '\n');
      break;
    }


    case 'agent-writes': {
      const arg = (positional[0] || '').toLowerCase();
      if (arg === 'on' || arg === 'off' || arg === 'true' || arg === 'false') {
        const val = arg === 'on' || arg === 'true';
        registry.preferences.set(AGENT_WRITES_KEY, val);
        emit({ agentWrites: val });
      } else if (arg) {
        die("usage: lwdb agent-writes [on|off]");
      } else {
        emit({ agentWrites: registry.preferences.get(AGENT_WRITES_KEY, false) === true });
      }
      break;
    }

    case 'secure': {
      const sub = (positional.shift() || 'status').toLowerCase();
      if (sub === 'migrate') {
        const { migrated } = registry.connectionStore.migrateEncryption();
        emit({ migrated, ...registry.connectionStore.auditEncryption() });
      } else if (sub === 'status') {
        emit({
          keySource: registry.keySource,
          keyPath: registry.keyPath,
          ...registry.connectionStore.auditEncryption(),
        });
      } else {
        die('usage: lwdb secure [status|migrate]');
      }
      break;
    }

    case 'conn-add': {
      if (!flags.label || !flags.host || !flags.user) {
        die('usage: lwdb conn-add --label=.. --host=.. --user=.. [--port=3306] [--password=..] [--color=..] [--group=..] [--notes=..] [--local] [--protected]');
      }
      const conn = registry.connectionStore.create({
        label: flags.label,
        host: flags.host,
        port: flags.port ? parseInt(flags.port, 10) : 3306,
        user: flags.user,
        password: flags.password === true ? '' : (flags.password || ''),
        color: flags.color || null,
        group: flags.group || null,
        notes: flags.notes || null,
        kind: flags.local ? 'local' : undefined,
        writeProtected: !!flags.protected,
      });
      emit(safeConnection(conn));
      break;
    }

    case 'conn-edit': {
      const id = positional.shift();
      if (!id) die('usage: lwdb conn-edit <id> [--label=..] [--host=..] [--port=..] [--user=..] [--password=..] [--color=..] [--group=..] [--notes=..] [--local] [--remote]');
      const patch = {};
      for (const k of ['label', 'host', 'user', 'password', 'color', 'group', 'notes']) {
        if (k in flags) patch[k] = flags[k] === true ? '' : flags[k];
      }
      if ('port' in flags) patch.port = parseInt(flags.port, 10);
      if (flags.local) patch.kind = 'local';
      if (flags.remote) patch.kind = 'remote';
      if (flags.protected) patch.writeProtected = true;
      if (flags.unprotected) patch.writeProtected = false;
      const conn = registry.connectionStore.update(id, patch);
      if (!conn) die(`connection not found: ${id}`);
      emit(safeConnection(conn));
      break;
    }

    case 'conn-rm': {
      const id = positional.shift();
      if (!id) die('usage: lwdb conn-rm <id> --yes');
      if (!(flags.yes || flags.confirm)) die('refusing to delete without --yes');
      if (!registry.connectionStore.delete(id)) die(`connection not found: ${id}`);
      emit({ deleted: id });
      break;
    }

    case 'conn-test': {
      const id = positional.shift();
      let spec = null;
      if (id) spec = { id };
      else if (flags.host && flags.user) spec = { host: flags.host, port: flags.port ? parseInt(flags.port, 10) : 3306, user: flags.user, password: flags.password === true ? '' : (flags.password || '') };
      if (!spec) die('usage: lwdb conn-test <id>  (or --host=.. --user=.. [--port=..] [--password=..])');
      try { emit(await backend.testConnection(spec)); }
      catch (err) { die(`connect failed: ${err.message}`); }
      break;
    }

    case 'import': {
      const file = positional.shift();
      if (!file) die('usage: lwdb import <file.json>');
      const { readFile } = await import('node:fs/promises');
      let payload;
      try { payload = JSON.parse(await readFile(file, 'utf8')); }
      catch (err) { die(`cannot read/parse ${file}: ${err.message}`); }
      const items = Array.isArray(payload) ? payload : (payload.connections || []);
      if (!items.length) die('no connections in payload');
      const result = registry.connectionStore.bulkUpsert(items);
      if (wantJson) emit({ count: result.length, result });
      else emit(result, { table: true, columns: ['status', 'id', 'label'] });
      break;
    }

    case 'export': {
      const file = positional.shift();
      const doc = registry.connectionStore.exportAll();
      if (file) {
        const { writeFile } = await import('node:fs/promises');
        await writeFile(file, JSON.stringify(doc, null, 2) + '\n', 'utf8');
        emit({ written: file, count: doc.connections.length });
      } else {
        process.stdout.write(JSON.stringify(doc, null, 2) + '\n');
      }
      break;
    }

    default:
      die(`unknown command: ${cmd}. Try 'lwdb help'`);
  }
}

if (cmd === 'serve') {
  // Run the HTTP server + Web UI in the foreground. The server owns its own
  // lifecycle (signal handlers + pool teardown on shutdown), so we deliberately
  // bypass the CLI's try/finally(closeAll) wrapper. Importing the module starts
  // it listening and keeps the event loop alive; control never returns here.
  await import('../server/index.mjs');
} else if (cmd === 'mcp') {
  // Long-lived MCP server over stdio. stdout is the JSON-RPC channel — never
  // emit anything else there. Logs already go to stderr (LW_DB_LOG_LEVEL=warn).
  const { runMcp } = await import('../server/mcp.mjs');
  try {
    await runMcp();
  } finally {
    await closeAll();
  }
} else {
  try {
    await main();
  } catch (err) {
    die(err.message);
  } finally {
    await closeAll();
  }
}
