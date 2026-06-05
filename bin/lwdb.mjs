#!/usr/bin/env -S node --no-warnings=ExperimentalWarning

// CLI defaults to quiet logging unless the user opts in.
if (!process.env.LW_DB_LOG_LEVEL) process.env.LW_DB_LOG_LEVEL = 'warn';

import { buildRegistry } from '../server/lib/registry.mjs';
import { safeConnection } from '../server/lib/connectionStore.mjs';
import { listDatabases, listTables, describeTable, fetchSchema, closeAll, pingConnection } from '../server/lib/pool.mjs';
import { runQuery } from '../server/lib/runQuery.mjs';
import { inspectSql } from '../server/lib/sqlGuard.mjs';
import { bindParams } from '../server/lib/snippets.mjs';

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
function resolveWritable(sql, registry) {
  let info;
  try { info = inspectSql(sql); } catch { return false; }
  if (info.allReadOnly) return false; // pure read — no gate needed

  const enabled = registry.preferences.get(AGENT_WRITES_KEY, false) === true;
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
  find-table <server> <pattern>     # search tables across every db on a server
  query <server> [db] "<sql>"       [--yes] [--limit=N]
                                       # writes need: agent-writes ON + --yes (user-confirmed)

CONNECTIONS
  servers | connections             # list connections
  conn-add --label= --host= --user= [--port=3306] [--password=] [--color=] [--group=] [--notes=] [--local]
  conn-edit <id> [--label=] [--host=] [--port=] [--user=] [--password=] [--color=] [--group=] [--notes=] [--local|--remote]
  conn-rm <id> --yes
  conn-test <id>                    # or: --host= --user= [--port=] [--password=]
  import <file.json>                # bulk upsert connections (universal format)
  export [file.json]                # dump connections (includes passwords)

SERVER (GUI backend)
  serve                             # run the HTTP API + Web UI on :4321
                                       # (this is what the desktop app launches)

SAVED QUERIES
  snippets [pattern]
  save <name> "<sql>" [--description=] [--default-server=] [--default-db=] [--tags=a,b]
  run <name-or-id> [--server=] [--db=] [--<param>=value...] [--<param>-op=<op>...] [--writable] [--limit=N]
                                       # operator keys: eq (default), like, like_contains,
                                       #   like_starts, like_ends, neq, not_like
  delete <name-or-id>
  push [file]                       # bulk upsert from JSON (file or stdin)
  schema-snippets                   # print expected JSON shape (for AI agents)

HISTORY
  history [--limit=N] [--server=...] [--db=...]
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
  (first-time install: npm run setup  — or: node install.mjs install)

OUTPUT
  --json        Force JSON (auto when not a TTY).

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

async function main() {
  if (!cmd || cmd === 'help' || cmd === '-h' || cmd === '--help') { help(); return; }
  if (INSTALLER_COMMANDS.has(cmd)) return runInstaller(cmd);
  const registry = await buildRegistry();

  switch (cmd) {
    case 'servers':
    case 'connections': {
      emit(registry.listConnections().map(safeConnection), {
        table: true, columns: ['id', 'label', 'kind', 'host', 'port', 'user'],
      });
      break;
    }

    case 'dbs': {
      const [server, pattern] = positional;
      if (!server) die('usage: lwdb dbs <server> [pattern]');
      const conn = registry.getConnection(server);
      let dbs = await listDatabases(conn);
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
      const conn = registry.getConnection(server);
      let tables = await listTables(conn, db);
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
      const conn = registry.getConnection(server);
      const desc = await describeTable(conn, db, table);
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
      const conn = registry.getConnection(server);
      const schema = await fetchSchema(conn, db);
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

    case 'find-table': {
      const [server, pattern] = positional;
      if (!server || !pattern) die('usage: lwdb find-table <server> <pattern>');
      const conn = registry.getConnection(server);
      const dbs = await listDatabases(conn);
      const p = pattern.toLowerCase();
      const matches = [];
      for (const db of dbs) {
        try {
          const tables = await listTables(conn, db);
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
      const conn = registry.getConnection(server);
      const result = await runQuery({
        connection: conn,
        db,
        sql,
        writable: resolveWritable(sql, registry),
        limit: flags.limit ? parseInt(flags.limit, 10) : undefined,
        history: registry.history,
        config: registry.config,
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
      const snippet = findSnippet(registry.snippets.list(), key);
      if (!snippet) die(`snippet not found: ${key}`);
      const targetServer = flags.server || snippet.defaultServer;
      const targetDb = flags.db || snippet.defaultDb;
      if (!targetServer) die('--server required (snippet has no defaultServer)');
      const { params, ops } = pickParams(flags);
      const { sql: boundSql, args: boundArgs } = bindParams(snippet.sql, params, ops);
      const conn = registry.getConnection(targetServer);
      const result = await runQuery({
        connection: conn, db: targetDb, sql: boundSql, args: boundArgs,
        writable: resolveWritable(boundSql, registry),
        limit: flags.limit ? parseInt(flags.limit, 10) : undefined,
        history: registry.history, snippetId: snippet.id,
        config: registry.config,
      });
      if (wantJson) emit({ ...result, snippet: { id: snippet.id, name: snippet.name } });
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
      const entries = registry.history.recent({ limit, server: flags.server || null, db: flags.db || null });
      emit(entries, { table: true, columns: ['startedAt', 'server', 'db', 'verb', 'elapsedMs', 'rowCount', 'sql'] });
      break;
    }

    case 'history-clear': {
      registry.history.clear();
      emit({ cleared: true });
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

    case 'conn-add': {
      if (!flags.label || !flags.host || !flags.user) {
        die('usage: lwdb conn-add --label=.. --host=.. --user=.. [--port=3306] [--password=..] [--color=..] [--group=..] [--notes=..] [--local]');
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
      let conn;
      if (id) conn = registry.connectionStore.get(id);
      else if (flags.host && flags.user) conn = { host: flags.host, port: flags.port ? parseInt(flags.port, 10) : 3306, user: flags.user, password: flags.password === true ? '' : (flags.password || '') };
      if (!conn) die('usage: lwdb conn-test <id>  (or --host=.. --user=.. [--port=..] [--password=..])');
      try { emit(await pingConnection(conn, { timeoutMs: 5000 })); }
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
} else {
  try {
    await main();
  } catch (err) {
    die(err.message);
  } finally {
    await closeAll();
  }
}
