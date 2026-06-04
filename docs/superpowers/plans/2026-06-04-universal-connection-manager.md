# Universal Connection Manager Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Linways `dbconfs/*.txt` connection loader with a built-in, universal connection manager — full CRUD from UI and CLI, SQLite-backed, with a documented JSON import/export format and a one-time migration of the existing Linways servers.

**Architecture:** A new SQLite-backed `ConnectionStore` (mirroring `PreferenceStore`/`SnippetStore`) becomes the single source of connection definitions. The registry reads it live so edits apply without restart. Connection objects keep the identical `{id, label, kind, host, port, user, password}` shape, so `pool.mjs` and every consumer are unchanged. Passwords are stored plaintext in the gitignored `data/lwdb.sqlite`. A universal `{version, connections[]}` JSON powers import/export; a one-shot converter migrates the existing `.txt` files.

**Tech Stack:** Node 22+ `node:sqlite`, Fastify, mysql2, Vue 3 + Vite + CodeMirror, node:test, Playwright.

---

## File Structure

**Create:**
- `server/lib/connectionStore.mjs` — SQLite store + `safeConnection` + `slugify` + `deriveKind`. One responsibility: connection persistence.
- `tools/dbconfs-to-json.mjs` — one-shot migration: parse `.txt` dbconfs → universal JSON. Self-contained (no dependency on deleted code).
- `connections.example.json` — tracked documented import-format sample (placeholder creds).
- `web/src/components/ConnectionsManager.vue` — list + add/edit/delete/test UI.
- `tests/e2e/connections.mjs` — Playwright end-to-end.

**Modify:**
- `server/lib/db.mjs` — add migration v2 (`connections` table).
- `server/lib/config.mjs` — make `dbConfsDir` optional (remove the startup throw).
- `server/lib/pool.mjs` — add `pingConnection()` for connection-test.
- `server/lib/registry.mjs` — build `ConnectionStore`; `getConnection`/`listConnections` from store; drop `loadConnections`.
- `server/index.mjs` — connections CRUD/test/import/export routes; `registry.connections` → `registry.listConnections()`; import `safeConnection` from new module.
- `bin/lwdb.mjs` — `conn-add`/`conn-edit`/`conn-rm`/`conn-test`/`import`/`export`; ref + import updates; help.
- `tests/connections.test.mjs` — rewrite for `ConnectionStore`.
- `web/src/api.js` — connection endpoints.
- `web/src/store.js` — connection actions + manager open state.
- `web/src/components/Settings.vue` — add "Connections" tab.
- `web/src/components/CommandPalette.vue` — "+ Add connection" action + color dots.
- `.claude/skills/lwdb/SKILL.md`, `CHANGELOG.md`.

**Delete:**
- `server/lib/connections.mjs` (the `.txt` parser).

---

## Task 1: DB migration + config no longer requires dbconfs

**Files:**
- Modify: `server/lib/db.mjs:6-46` (MIGRATIONS array)
- Modify: `server/lib/config.mjs:62-66` (remove throw)

- [ ] **Step 1: Add the v2 migration**

In `server/lib/db.mjs`, append a second entry to the `MIGRATIONS` array (after the v1 template-literal, before the closing `]`):

```js
  // v2 — connections (replaces dbconfs/*.txt loading)
  `CREATE TABLE IF NOT EXISTS connections (
     id TEXT PRIMARY KEY,
     label TEXT NOT NULL,
     kind TEXT NOT NULL DEFAULT 'remote',
     host TEXT NOT NULL,
     port INTEGER NOT NULL DEFAULT 3306,
     user TEXT NOT NULL,
     password TEXT NOT NULL DEFAULT '',
     color TEXT,
     group_tag TEXT,
     notes TEXT,
     sort_order INTEGER NOT NULL DEFAULT 0,
     created_at TEXT NOT NULL,
     updated_at TEXT NOT NULL
   );
   CREATE INDEX IF NOT EXISTS idx_connections_kind ON connections(kind);`,
```

The migration loop (`for (let i = currentVersion; i < MIGRATIONS.length; i++)`) applies it to both fresh and existing databases automatically.

- [ ] **Step 2: Make `dbConfsDir` optional**

In `server/lib/config.mjs`, delete the throw block (currently lines 62-66):

```js
  if (!cfg.dbConfsDir) {
    throw new Error(
      'lwdb: dbConfsDir not configured. Set LW_DB_CONFS_DIR env or package.json#lwDb.dbConfsDir.'
    );
  }
```

`dbConfsDir` stays in the config (used only by the one-shot converter), just no longer required to boot.

- [ ] **Step 3: Verify the schema applies**

Run: `node --no-warnings=ExperimentalWarning -e "import('./server/lib/db.mjs').then(async m => { const db = await m.openDb('/tmp/lwdb-mig-test.sqlite'); console.log(db.prepare('SELECT name FROM sqlite_master WHERE type=\"table\" AND name=\"connections\"').get()); db.close(); })"`
Expected: `{ name: 'connections' }`

- [ ] **Step 4: Commit**

```bash
git add server/lib/db.mjs server/lib/config.mjs
git commit -m "feat(db): add connections table migration; make dbConfsDir optional"
```

---

## Task 2: ConnectionStore (TDD)

**Files:**
- Create: `server/lib/connectionStore.mjs`
- Test: `tests/connections.test.mjs` (rewrite — old content tested the deleted parser)

- [ ] **Step 1: Write the failing tests**

Replace the entire contents of `tests/connections.test.mjs` with:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openDb } from '../server/lib/db.mjs';
import {
  ConnectionStore, safeConnection, slugify, deriveKind,
} from '../server/lib/connectionStore.mjs';

async function freshStore() {
  const dir = await mkdtemp(join(tmpdir(), 'lwdb-conn-'));
  const db = await openDb(join(dir, 'lwdb.sqlite'));
  return { store: new ConnectionStore(db), cleanup: () => rm(dir, { recursive: true, force: true }) };
}

test('slugify lowercases and dashes non-alphanumerics', () => {
  assert.equal(slugify('V4 · Server 84'), 'v4-server-84');
  assert.equal(slugify('Local DB!!'), 'local-db');
  assert.equal(slugify(''), 'connection');
});

test('deriveKind: only localhost is local', () => {
  assert.equal(deriveKind('localhost'), 'local');
  assert.equal(deriveKind('127.0.0.1'), 'remote');
  assert.equal(deriveKind('db.example.com'), 'remote');
  assert.equal(deriveKind('127.0.0.1', 'local'), 'local'); // explicit override wins
});

test('safeConnection strips password', () => {
  const safe = safeConnection({ id: 'x', host: 'h', port: 1, user: 'u', password: 'pw' });
  assert.equal(safe.password, undefined);
  assert.equal(safe.hasPassword, true);
});

test('ConnectionStore.create derives id, kind, defaults', async () => {
  const { store, cleanup } = await freshStore();
  try {
    const c = store.create({ label: 'V4 Server 84', host: '127.0.0.1', port: 3384, user: 'merge', password: 'secret' });
    assert.equal(c.id, 'v4-server-84');
    assert.equal(c.kind, 'remote');
    assert.equal(c.port, 3384);
    const local = store.create({ label: 'Local', host: 'localhost', user: 'root' });
    assert.equal(local.kind, 'local');
    assert.equal(local.port, 3306); // default
  } finally { await cleanup(); }
});

test('ConnectionStore.create dedupes slug collisions', async () => {
  const { store, cleanup } = await freshStore();
  try {
    const a = store.create({ label: 'Dup', host: 'h1', user: 'u' });
    const b = store.create({ label: 'Dup', host: 'h2', user: 'u' });
    assert.equal(a.id, 'dup');
    assert.equal(b.id, 'dup-2');
  } finally { await cleanup(); }
});

test('ConnectionStore.all sorts local-first then label', async () => {
  const { store, cleanup } = await freshStore();
  try {
    store.create({ label: 'Zebra', host: 'h', user: 'u' });
    store.create({ label: 'Apple', host: 'h', user: 'u' });
    store.create({ label: 'Home', host: 'localhost', user: 'root' });
    const ids = store.all().map((c) => c.id);
    assert.deepEqual(ids, ['home', 'apple', 'zebra']);
  } finally { await cleanup(); }
});

test('ConnectionStore.update patches and preserves absent password', async () => {
  const { store, cleanup } = await freshStore();
  try {
    const c = store.create({ label: 'Edit', host: 'localhost', user: 'root', password: 'keepme' });
    const u = store.update(c.id, { label: 'Edited', host: 'remote.example' });
    assert.equal(u.label, 'Edited');
    assert.equal(u.kind, 'remote');     // host change recomputes kind
    assert.equal(u.password, 'keepme'); // password not in patch → preserved
  } finally { await cleanup(); }
});

test('ConnectionStore.delete removes the row', async () => {
  const { store, cleanup } = await freshStore();
  try {
    const c = store.create({ label: 'Bye', host: 'h', user: 'u' });
    assert.equal(store.delete(c.id), true);
    assert.equal(store.get(c.id), null);
    assert.equal(store.delete('nope'), false);
  } finally { await cleanup(); }
});

test('ConnectionStore.bulkUpsert is idempotent by id', async () => {
  const { store, cleanup } = await freshStore();
  try {
    const items = [{ id: 'server-84', label: 'S84', host: '127.0.0.1', port: 3384, user: 'm', password: 'p' }];
    const r1 = store.bulkUpsert(items);
    assert.equal(r1[0].status, 'created');
    const r2 = store.bulkUpsert(items);
    assert.equal(r2[0].status, 'updated');
    assert.equal(store.all().length, 1);
  } finally { await cleanup(); }
});

test('ConnectionStore.exportAll round-trips through bulkUpsert', async () => {
  const { store, cleanup } = await freshStore();
  try {
    store.create({ label: 'A', host: 'localhost', user: 'root', password: 'pw', color: '#e23', group: 'prod', notes: 'n' });
    const doc = store.exportAll();
    assert.equal(doc.version, 1);
    assert.equal(doc.connections[0].password, 'pw');
    assert.equal(doc.connections[0].group, 'prod');
  } finally { await cleanup(); }
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test tests/connections.test.mjs`
Expected: FAIL — `Cannot find module '../server/lib/connectionStore.mjs'`

- [ ] **Step 3: Implement the store**

Create `server/lib/connectionStore.mjs`:

```js
/**
 * SQLite-backed connection store. Replaces the old dbconfs/*.txt loader as the
 * single source of connection definitions. Mirrors the PreferenceStore /
 * SnippetStore pattern. Connection objects keep the shape the rest of the app
 * expects: { id, label, kind, host, port, user, password, ... }.
 */
import { withTx } from './db.mjs';

/** Slugify a label into a stable id: lowercase, non-alphanumerics → '-'. */
export function slugify(label) {
  const base = String(label || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return base || 'connection';
}

/** Only `localhost` is local; everything else (incl. 127.0.0.1) is remote.
 *  An explicit override of 'local'|'remote' always wins. */
export function deriveKind(host, override) {
  if (override === 'local' || override === 'remote') return override;
  return host === 'localhost' ? 'local' : 'remote';
}

/** Strip the password for client-facing responses. */
export function safeConnection(conn) {
  const { password, ...rest } = conn;
  return { ...rest, hasPassword: !!password };
}

function row2conn(row) {
  if (!row) return null;
  return {
    id: row.id,
    label: row.label,
    kind: row.kind,
    host: row.host,
    port: row.port,
    user: row.user,
    password: row.password,
    color: row.color,
    group: row.group_tag,
    notes: row.notes,
    sortOrder: row.sort_order,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class ConnectionStore {
  constructor(db) {
    this.db = db;
  }

  all() {
    const rows = this.db.prepare('SELECT * FROM connections').all().map(row2conn);
    rows.sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === 'local' ? -1 : 1;
      if ((a.sortOrder ?? 0) !== (b.sortOrder ?? 0)) return (a.sortOrder ?? 0) - (b.sortOrder ?? 0);
      return a.label.localeCompare(b.label);
    });
    return rows;
  }

  get(id) {
    return row2conn(this.db.prepare('SELECT * FROM connections WHERE id = ?').get(id));
  }

  _uniqueId(desired) {
    let id = desired;
    let n = 2;
    while (this.get(id)) id = `${desired}-${n++}`;
    return id;
  }

  create(input) {
    const label = input.label || input.id;
    if (!label) throw new Error('label required');
    if (!input.host) throw new Error('host required');
    if (!input.user) throw new Error('user required');
    const desired = slugify(input.id || label);
    const id = this.get(desired) ? this._uniqueId(desired) : desired;
    const now = new Date().toISOString();
    const kind = deriveKind(input.host, input.kind);
    this.db.prepare(
      `INSERT INTO connections
         (id, label, kind, host, port, user, password, color, group_tag, notes, sort_order, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      id, label, kind, input.host, Number(input.port) || 3306, input.user,
      input.password || '', input.color || null, input.group || null, input.notes || null,
      Number(input.sortOrder) || 0, now, now,
    );
    return this.get(id);
  }

  update(id, patch) {
    const existing = this.get(id);
    if (!existing) return null;
    const merged = { ...existing, ...patch };
    let kind;
    if (patch.kind === 'local' || patch.kind === 'remote') kind = patch.kind;
    else if (patch.host !== undefined) kind = deriveKind(patch.host);
    else kind = existing.kind;
    const now = new Date().toISOString();
    this.db.prepare(
      `UPDATE connections SET
         label = ?, kind = ?, host = ?, port = ?, user = ?, password = ?,
         color = ?, group_tag = ?, notes = ?, sort_order = ?, updated_at = ?
       WHERE id = ?`
    ).run(
      merged.label, kind, merged.host, Number(merged.port) || 3306, merged.user,
      merged.password ?? '', merged.color ?? null, merged.group ?? null, merged.notes ?? null,
      Number(merged.sortOrder) || 0, now, id,
    );
    return this.get(id);
  }

  delete(id) {
    return this.db.prepare('DELETE FROM connections WHERE id = ?').run(id).changes > 0;
  }

  /** Upsert by id (slug). For import files / agent pushes. Idempotent. */
  bulkUpsert(items) {
    const results = [];
    withTx(this.db, () => {
      for (const c of items) {
        if (!c || !c.host || !c.user) {
          results.push({ label: c?.label || '(unnamed)', status: 'skipped', reason: 'host and user required' });
          continue;
        }
        const id = slugify(c.id || c.label || c.host);
        if (this.get(id)) {
          this.update(id, c);
          results.push({ id, label: c.label, status: 'updated' });
        } else {
          const created = this.create({ ...c, id });
          results.push({ id: created.id, label: created.label, status: 'created' });
        }
      }
    });
    return results;
  }

  /** Full export document (INCLUDES passwords — it's a local backup file). */
  exportAll() {
    return {
      version: 1,
      connections: this.all().map((c) => ({
        id: c.id, label: c.label, kind: c.kind, host: c.host, port: c.port,
        user: c.user, password: c.password, color: c.color, group: c.group, notes: c.notes,
      })),
    };
  }
}
```

- [ ] **Step 4: Run to verify pass**

Run: `node --test tests/connections.test.mjs`
Expected: PASS (all tests green)

- [ ] **Step 5: Commit**

```bash
git add server/lib/connectionStore.mjs tests/connections.test.mjs
git commit -m "feat: SQLite-backed ConnectionStore with CRUD, bulkUpsert, export"
```

---

## Task 3: pool.pingConnection (connection test)

**Files:**
- Modify: `server/lib/pool.mjs` (add an exported function; `mysql` is already imported at top)

- [ ] **Step 1: Add `pingConnection`**

Append to `server/lib/pool.mjs` (after `poolStats`, before EOF):

```js
/**
 * One-off connectivity probe for the "Test connection" action. Opens a single
 * connection (NOT pooled, so an unsaved/ad-hoc connection leaves nothing
 * behind), pings, and closes. Returns latency in ms or throws.
 */
export async function pingConnection(connection, { timeoutMs } = {}) {
  const start = Date.now();
  const conn = await mysql.createConnection({
    host: connection.host,
    port: Number(connection.port) || 3306,
    user: connection.user,
    password: connection.password || '',
    connectTimeout: timeoutMs || activeConfig.connectTimeoutMs,
  });
  try {
    await conn.ping();
    return { ok: true, ms: Date.now() - start };
  } finally {
    try { await conn.end(); } catch (_) { /* ignore */ }
  }
}
```

- [ ] **Step 2: Smoke-test against localhost (best-effort)**

Run: `node --no-warnings=ExperimentalWarning -e "import('./server/lib/pool.mjs').then(async m => { try { console.log(await m.pingConnection({host:'localhost',port:3306,user:'root',password:''}, {timeoutMs:2000})); } catch(e){ console.log('expected-ish error:', e.code||e.message); } })"`
Expected: either `{ ok: true, ms: <n> }` or a MySQL auth/connect error code (function executes — no `is not a function`).

- [ ] **Step 3: Commit**

```bash
git add server/lib/pool.mjs
git commit -m "feat(pool): pingConnection probe for connection-test"
```

---

## Task 4: Registry reads the store

**Files:**
- Modify: `server/lib/registry.mjs`

- [ ] **Step 1: Swap the loader for the store**

In `server/lib/registry.mjs`:

Replace the import line:
```js
import { loadConnections } from './connections.mjs';
```
with:
```js
import { ConnectionStore } from './connectionStore.mjs';
```

Delete this block (the file-scan loader):
```js
  const connections = await loadConnections(config.dbConfsDir);
  if (!connections.length) {
    log.warn('no connections found — check LW_DB_CONFS_DIR', { dir: config.dbConfsDir });
  } else {
    log.info('connections loaded', { count: connections.length, dir: config.dbConfsDir });
  }
```

After `const db = await openDb(config.sqlitePath);` and its log line, add:
```js
  const connectionStore = new ConnectionStore(db);
  log.info('connections', { count: connectionStore.all().length });
```

Replace `getConnection`:
```js
  function getConnection(id) {
    const c = connectionStore.get(id);
    if (!c) throw appError(Codes.UNKNOWN_SERVER, `Unknown server: ${id}`);
    return c;
  }
```

In the returned object, replace `connections,` with:
```js
    connectionStore,
    listConnections: () => connectionStore.all(),
```
Leave `dbConfsDir: config.dbConfsDir` as-is (still surfaced for the converter), and keep `getConnection`.

- [ ] **Step 2: Verify registry boots without dbconfs**

Run: `LW_DB_SQLITE=/tmp/lwdb-reg-test.sqlite node --no-warnings=ExperimentalWarning -e "import('./server/lib/registry.mjs').then(async m => { const r = await m.buildRegistry(); console.log('connections:', r.listConnections().length); r.db.close(); })"`
Expected: prints `connections: 0` (empty store, no error about dbConfsDir).

- [ ] **Step 3: Commit**

```bash
git add server/lib/registry.mjs
git commit -m "feat(registry): source connections from ConnectionStore (live, no file scan)"
```

---

## Task 5: API endpoints

**Files:**
- Modify: `server/index.mjs`

- [ ] **Step 1: Update imports + `registry.connections` references**

In `server/index.mjs`, change the import:
```js
import { safeConnection } from './lib/connections.mjs';
```
to:
```js
import { safeConnection } from './lib/connectionStore.mjs';
```

Add `pingConnection` to the pool import line:
```js
import { listDatabases, listTables, describeTable, fetchSchema, closeAll, poolStats, pingConnection } from './lib/pool.mjs';
```

Replace the three `registry.connections` usages:
- `connections: registry.connections.length,` (in `/api/health`) → `connections: registry.listConnections().length,`
- `servers: registry.connections.map(safeConnection),` (in `/api/servers`) → `servers: registry.listConnections().map(safeConnection),`
- `connections: registry.connections.length,` (in the listen log) → `connections: registry.listConnections().length,`

- [ ] **Step 2: Add the connections routes**

Insert immediately after the `/api/servers/health` route (before `/api/servers/:id/databases`):

```js
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
  const body = ensureObject(req.body, 'body');
  const items = Array.isArray(body) ? body : (body.connections || []);
  ensureArray(items, 'connections');
  if (!items.length) throw appError(Codes.BAD_REQUEST, 'No connections in payload');
  const result = registry.connectionStore.bulkUpsert(items);
  return { count: result.length, result };
}));

app.get('/api/connections/export', async () => registry.connectionStore.exportAll());
```

- [ ] **Step 3: Verify routes respond**

Start the server, then exercise the endpoints:

Run: `LW_DB_SQLITE=/tmp/lwdb-api-test.sqlite node --no-warnings=ExperimentalWarning server/index.mjs & sleep 1.5 && \
  curl -s -X POST localhost:4321/api/connections -H 'content-type: application/json' -d '{"label":"Local","host":"localhost","user":"root","password":""}' && echo && \
  curl -s localhost:4321/api/connections && echo && \
  curl -s localhost:4321/api/connections/export && echo && \
  kill %1`
Expected: create returns `{"connection":{...,"id":"local","kind":"local","hasPassword":false}}`; list shows it (no `password` field); export shows `{"version":1,"connections":[{...,"password":""}]}`.

- [ ] **Step 4: Commit**

```bash
git add server/index.mjs
git commit -m "feat(api): connections CRUD + test + import/export endpoints"
```

---

## Task 6: CLI commands

**Files:**
- Modify: `bin/lwdb.mjs`

- [ ] **Step 1: Update import + `servers` command**

Change:
```js
import { safeConnection } from '../server/lib/connections.mjs';
```
to:
```js
import { safeConnection } from '../server/lib/connectionStore.mjs';
import { pingConnection } from '../server/lib/pool.mjs';
```
(`closeAll`, `listDatabases`, etc. stay on their existing pool import line — just add `pingConnection` there instead if you prefer one line; either is fine.)

In the `servers` case, replace `registry.connections.map(safeConnection)` with `registry.listConnections().map(safeConnection)` and add `label` to the columns:
```js
    case 'servers':
    case 'connections': {
      emit(registry.listConnections().map(safeConnection), {
        table: true, columns: ['id', 'label', 'kind', 'host', 'port', 'user'],
      });
      break;
    }
```

- [ ] **Step 2: Add connection-management + import/export cases**

Insert before the `default:` case:

```js
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
      else if (flags.host) conn = { host: flags.host, port: flags.port ? parseInt(flags.port, 10) : 3306, user: flags.user, password: flags.password === true ? '' : (flags.password || '') };
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
```

- [ ] **Step 3: Update help text**

In `help()`, add a new section after the `DATA` block:

```
CONNECTIONS
  servers | connections             # list connections
  conn-add --label= --host= --user= [--port=3306] [--password=] [--color=] [--group=] [--notes=] [--local]
  conn-edit <id> [--label=] [--host=] [--port=] [--user=] [--password=] [--color=] [--group=] [--notes=] [--local|--remote]
  conn-rm <id> --yes
  conn-test <id>                    # or: --host= --user= [--port=] [--password=]
  import <file.json>                # bulk upsert connections (universal format)
  export [file.json]                # dump connections (includes passwords)
```

- [ ] **Step 4: Verify CLI round-trip**

Run: `LW_DB_SQLITE=/tmp/lwdb-cli-test.sqlite node --no-warnings=ExperimentalWarning bin/lwdb.mjs conn-add --label="Local" --host=localhost --user=root --json && \
  LW_DB_SQLITE=/tmp/lwdb-cli-test.sqlite node --no-warnings=ExperimentalWarning bin/lwdb.mjs servers --json && \
  LW_DB_SQLITE=/tmp/lwdb-cli-test.sqlite node --no-warnings=ExperimentalWarning bin/lwdb.mjs export --json`
Expected: add prints the new connection (`id: "local"`, `kind: "local"`); servers lists it; export shows the `{version:1,...}` doc with the password field.

- [ ] **Step 5: Commit**

```bash
git add bin/lwdb.mjs
git commit -m "feat(cli): conn-add/edit/rm/test + import/export commands"
```

---

## Task 7: Universal format sample + dbconfs converter

**Files:**
- Create: `connections.example.json`
- Create: `tools/dbconfs-to-json.mjs`

- [ ] **Step 1: Write the documented example**

Create `connections.example.json`:

```json
{
  "version": 1,
  "connections": [
    {
      "id": "localdb",
      "label": "Local DB",
      "host": "localhost",
      "port": 3306,
      "user": "root",
      "password": "",
      "color": "#16a34a",
      "group": "local",
      "notes": "Local development MySQL"
    },
    {
      "id": "server-84",
      "label": "V4 · Server 84",
      "host": "127.0.0.1",
      "port": 3384,
      "user": "youruser",
      "password": "yourpassword",
      "color": "#dc2626",
      "group": "production",
      "notes": "Reachable via SSH tunnel on 127.0.0.1:3384"
    }
  ]
}
```

- [ ] **Step 2: Write the converter**

Create `tools/dbconfs-to-json.mjs` (self-contained — does not import the soon-to-be-deleted parser):

```js
#!/usr/bin/env -S node --no-warnings=ExperimentalWarning
/**
 * One-shot migration: convert legacy Linways dbconfs/*.txt files into the
 * universal lwdb connection JSON. Run once, then `lwdb import <out>`.
 *
 * Usage: node tools/dbconfs-to-json.mjs <dbconfsDir> [outFile]
 *   default outFile: data/connections.import.json (gitignored)
 */
import { readdir, readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, basename, dirname } from 'node:path';

const HOST_RE = /\$(?:AMS_AUTONOMOUS_)?DB_HOST\s*=.*?=\s*"([^"]+)"/;
const USER_RE = /\$(?:AMS_AUTONOMOUS_)?DB_USER\s*=.*?=\s*"([^"]+)"/;
const PASS_RE = /\$(?:AMS_AUTONOMOUS_)?DB_PASSWD\s*=.*?=\s*"([^"]+)"/;

function parseConfText(text) {
  const h = text.match(HOST_RE), u = text.match(USER_RE), p = text.match(PASS_RE);
  if (!h || !u || !p) return null;
  let host = h[1], port = 3306;
  if (host.includes(':')) { const [hh, pp] = host.split(':'); host = hh; port = parseInt(pp, 10) || 3306; }
  return { host, port, user: u[1], password: p[1] };
}

const [dir, outArg] = process.argv.slice(2);
if (!dir) { console.error('usage: node tools/dbconfs-to-json.mjs <dbconfsDir> [outFile]'); process.exit(1); }
const out = outArg || join('data', 'connections.import.json');

const entries = (await readdir(dir)).filter((f) => f.endsWith('.txt'));
const connections = [];
for (const file of entries) {
  const conf = parseConfText(await readFile(join(dir, file), 'utf8'));
  if (!conf) { console.error(`skip (no creds): ${file}`); continue; }
  const id = basename(file, '.txt');
  connections.push({
    id,
    label: id === 'localdb' ? 'Local DB' : id,
    host: conf.host,
    port: conf.port,
    user: conf.user,
    password: conf.password,
    group: id === 'localdb' ? 'local' : 'linways',
  });
}

await mkdir(dirname(out), { recursive: true });
await writeFile(out, JSON.stringify({ version: 1, connections }, null, 2) + '\n', 'utf8');
console.error(`wrote ${connections.length} connection(s) → ${out}`);
```

- [ ] **Step 3: Verify the converter parses a sample**

Run: `mkdir -p /tmp/dbconf-test && printf '$DB_HOST = "127.0.0.1:3384";\n$DB_USER = "merge";\n$DB_PASSWD = "sec";\n' > /tmp/dbconf-test/V4-server84.txt && node tools/dbconfs-to-json.mjs /tmp/dbconf-test /tmp/conv-out.json && cat /tmp/conv-out.json`
Expected: writes 1 connection; JSON shows `id: "V4-server84"`, `host: "127.0.0.1"`, `port: 3384`, `user: "merge"`, `password: "sec"`.

- [ ] **Step 4: Commit**

```bash
git add connections.example.json tools/dbconfs-to-json.mjs
git commit -m "feat: universal connections.example.json + dbconfs→json converter"
```

---

## Task 8: Delete the legacy parser

**Files:**
- Delete: `server/lib/connections.mjs`

- [ ] **Step 1: Confirm no remaining importers**

Run: `grep -rn "lib/connections.mjs\|from './connections.mjs'\|from '../connections.mjs'" --include='*.mjs' . | grep -v node_modules`
Expected: no matches (Tasks 4, 5, 6, 2 moved everything to `connectionStore.mjs`).

- [ ] **Step 2: Delete the file**

Run: `git rm server/lib/connections.mjs`

- [ ] **Step 3: Run the full unit suite**

Run: `npm test`
Expected: PASS — all suites green, including the rewritten `connections.test.mjs`.

- [ ] **Step 4: Commit**

```bash
git commit -m "chore: remove legacy dbconfs .txt parser"
```

---

## Task 9: Web API client methods

**Files:**
- Modify: `web/src/api.js`

- [ ] **Step 1: Add connection methods**

In `web/src/api.js`, add to the `api` object (after `runSnippet`):

```js
  connections: () => req('/connections'),
  createConnection: (body) => req('/connections', { method: 'POST', body }),
  updateConnection: (id, body) => req(`/connections/${encodeURIComponent(id)}`, { method: 'PUT', body }),
  deleteConnection: (id) => req(`/connections/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  testConnection: (body) => req('/connections/test', { method: 'POST', body }),
  importConnections: (doc) => req('/connections/import', { method: 'POST', body: doc }),
  exportConnections: () => req('/connections/export'),
```

- [ ] **Step 2: Lint**

Run: `npx eslint web/src/api.js`
Expected: exit 0.

- [ ] **Step 3: Commit**

```bash
git add web/src/api.js
git commit -m "feat(web): connection API client methods"
```

---

## Task 10: Store actions

**Files:**
- Modify: `web/src/store.js`

- [ ] **Step 1: Add a manager-open flag + connections actions**

In `store.js`, add `connectionsOpen: false` to the `reactive({...})` store object (next to `toast: null`).

Add these actions to the `actions` object (after `selectServer`/`selectDatabase`, before `runActive` is fine):

```js
  openConnections() { store.connectionsOpen = true; },
  closeConnections() { store.connectionsOpen = false; },

  /** Reload the server list from the backing store (after add/edit/delete). */
  async reloadServers(selectId = null) {
    const { servers } = await api.servers();
    store.servers = servers;
    if (selectId && servers.find((s) => s.id === selectId)) {
      await this.selectServer(selectId);
    } else if (store.currentServer && !servers.find((s) => s.id === store.currentServer)) {
      // current server was deleted — fall back to the first available
      if (servers[0]) await this.selectServer(servers[0].id);
      else { store.currentServer = null; store.databases = []; store.tables = []; }
    }
  },

  async saveConnection(payload) {
    try {
      const saved = payload.id && payload._editing
        ? await api.updateConnection(payload.id, payload)
        : await api.createConnection(payload);
      await this.reloadServers(saved.connection.id);
      toast(payload._editing ? 'Connection updated' : 'Connection added', 'good');
      return saved.connection;
    } catch (err) { toast(err.message, 'error'); throw err; }
  },

  async deleteConnection(id) {
    if (store.prefs.confirmDestructive && !confirm('Delete this connection?')) return;
    try {
      await api.deleteConnection(id);
      await this.reloadServers();
      toast('Connection deleted', 'good');
    } catch (err) { toast(err.message, 'error'); }
  },

  async testConnection(payload) {
    return api.testConnection(payload); // caller handles ok/err for inline UI feedback
  },
```

- [ ] **Step 2: Lint**

Run: `npx eslint web/src/store.js`
Expected: exit 0.

- [ ] **Step 3: Commit**

```bash
git add web/src/store.js
git commit -m "feat(web): store actions for connection CRUD + test"
```

---

## Task 11: Connections manager UI + Settings tab

**Files:**
- Create: `web/src/components/ConnectionsManager.vue`
- Modify: `web/src/components/Settings.vue` (add a "Connections" tab that renders the manager)

- [ ] **Step 1: Build the manager component**

Create `web/src/components/ConnectionsManager.vue`:

```vue
<script setup>
import { ref, reactive, onMounted } from 'vue';
import { store, actions } from '../store.js';

const editing = ref(null);          // connection id being edited, or 'new', or null
const testState = reactive({ status: 'idle', msg: '' }); // idle|testing|ok|err
const form = reactive({
  id: null, label: '', host: 'localhost', port: 3306, user: 'root',
  password: '', color: '', group: '', notes: '', kind: 'local',
});

function startAdd() {
  Object.assign(form, { id: null, label: '', host: 'localhost', port: 3306, user: 'root', password: '', color: '', group: '', notes: '', kind: 'local' });
  testState.status = 'idle'; testState.msg = '';
  editing.value = 'new';
}
function startEdit(s) {
  Object.assign(form, {
    id: s.id, label: s.label, host: s.host, port: s.port, user: s.user,
    password: '', color: s.color || '', group: s.group || '', notes: s.notes || '', kind: s.kind,
  });
  testState.status = 'idle'; testState.msg = '';
  editing.value = s.id;
}
function cancel() { editing.value = null; }

// Auto-track kind from host unless the user pins it.
const kindPinned = ref(false);
function onHostInput() { if (!kindPinned.value) form.kind = form.host === 'localhost' ? 'local' : 'remote'; }
function toggleKind() { kindPinned.value = true; form.kind = form.kind === 'local' ? 'remote' : 'local'; }

async function test() {
  testState.status = 'testing'; testState.msg = '';
  try {
    const r = await actions.testConnection({ host: form.host, port: form.port, user: form.user, password: form.password });
    testState.status = 'ok'; testState.msg = `Connected in ${r.ms} ms`;
  } catch (err) { testState.status = 'err'; testState.msg = err.message; }
}

async function save() {
  const payload = { ...form, _editing: editing.value !== 'new' };
  // On edit, don't overwrite the stored password with an empty field.
  if (payload._editing && !form.password) delete payload.password;
  try { await actions.saveConnection(payload); editing.value = null; }
  catch (_) { /* toast already shown */ }
}

onMounted(() => { if (!store.servers.length) startAdd(); });
</script>

<template>
  <div class="conn-mgr">
    <div class="conn-list" v-if="editing === null">
      <div class="conn-head">
        <h3>Connections</h3>
        <button class="btn primary" @click="startAdd">+ Add connection</button>
      </div>
      <p v-if="!store.servers.length" class="empty">No connections yet. Add your first connection to get started.</p>
      <ul v-else>
        <li v-for="s in store.servers" :key="s.id" class="conn-row">
          <span class="dot" :style="{ background: s.color || '#94a3b8' }"></span>
          <span class="label">{{ s.label || s.id }}</span>
          <span class="meta">{{ s.user }}@{{ s.host }}:{{ s.port }}</span>
          <span v-if="s.group" class="chip">{{ s.group }}</span>
          <span class="kind">{{ s.kind }}</span>
          <span class="actions">
            <button class="btn" @click="startEdit(s)">Edit</button>
            <button class="btn danger" @click="actions.deleteConnection(s.id)">Delete</button>
          </span>
        </li>
      </ul>
    </div>

    <form v-else class="conn-form" @submit.prevent="save">
      <h3>{{ editing === 'new' ? 'Add connection' : 'Edit connection' }}</h3>
      <label>Label<input v-model="form.label" required placeholder="V4 · Server 84" /></label>
      <div class="row">
        <label class="grow">Host<input v-model="form.host" required @input="onHostInput" placeholder="localhost or 127.0.0.1" /></label>
        <label class="port">Port<input v-model.number="form.port" type="number" min="1" max="65535" /></label>
      </div>
      <div class="row">
        <label class="grow">User<input v-model="form.user" required /></label>
        <label class="grow">Password<input v-model="form.password" type="password" :placeholder="editing !== 'new' ? '(unchanged)' : ''" /></label>
      </div>
      <div class="row">
        <label class="color">Color<input v-model="form.color" type="text" placeholder="#dc2626" /></label>
        <label class="grow">Group<input v-model="form.group" placeholder="production" /></label>
        <label class="kind-toggle">
          <input type="checkbox" :checked="form.kind === 'local'" @change="toggleKind" /> Treat as local
        </label>
      </div>
      <label>Notes<textarea v-model="form.notes" rows="2"></textarea></label>

      <div class="test-row">
        <button type="button" class="btn" @click="test" :disabled="testState.status === 'testing'">
          {{ testState.status === 'testing' ? 'Testing…' : 'Test connection' }}
        </button>
        <span :class="['test-msg', testState.status]">{{ testState.msg }}</span>
      </div>

      <div class="form-actions">
        <button type="button" class="btn" @click="cancel">Cancel</button>
        <button type="submit" class="btn primary">{{ editing === 'new' ? 'Add' : 'Save' }}</button>
      </div>
    </form>
  </div>
</template>

<style scoped>
.conn-mgr { display: flex; flex-direction: column; gap: 12px; }
.conn-head { display: flex; justify-content: space-between; align-items: center; }
.empty { color: var(--muted, #94a3b8); padding: 16px 0; }
.conn-row { display: flex; align-items: center; gap: 10px; padding: 8px 0; border-bottom: 1px solid var(--border, #1f2937); }
.conn-row .dot { width: 10px; height: 10px; border-radius: 50%; flex: none; }
.conn-row .label { font-weight: 600; }
.conn-row .meta { color: var(--muted, #94a3b8); font-size: 12px; }
.conn-row .chip { font-size: 11px; padding: 1px 6px; border-radius: 8px; background: var(--border, #1f2937); }
.conn-row .kind { font-size: 11px; color: var(--muted, #94a3b8); }
.conn-row .actions { margin-left: auto; display: flex; gap: 6px; }
.conn-form { display: flex; flex-direction: column; gap: 10px; max-width: 560px; }
.conn-form label { display: flex; flex-direction: column; gap: 4px; font-size: 12px; }
.conn-form input, .conn-form textarea { padding: 6px 8px; border-radius: 6px; border: 1px solid var(--border, #1f2937); background: var(--bg, #0b1220); color: inherit; }
.row { display: flex; gap: 10px; }
.row .grow { flex: 1; }
.row .port input { width: 90px; }
.kind-toggle { flex-direction: row; align-items: center; gap: 6px; align-self: end; }
.test-row { display: flex; align-items: center; gap: 10px; }
.test-msg.ok { color: #16a34a; }
.test-msg.err { color: #dc2626; }
.form-actions { display: flex; justify-content: flex-end; gap: 8px; }
.btn.primary { background: var(--accent, #2563eb); color: #fff; }
.btn.danger { color: #dc2626; }
</style>
```

- [ ] **Step 2: Add the Settings tab**

In `web/src/components/Settings.vue`:
- `import ConnectionsManager from './ConnectionsManager.vue';` in the script.
- Add `'Connections'` to the tab list (wherever the tab names array/buttons are defined — match the existing pattern; put it right after `'General'`).
- In the tab-panel area, add a panel that renders `<ConnectionsManager v-if="activeTab === 'Connections'" />` (match the existing `v-if`/`v-show` convention used by the other tabs).

> If unsure of the exact tab markup, open `Settings.vue` and follow the established structure for an existing tab (e.g. how `'Editor'` is wired) — replicate it for `'Connections'`.

- [ ] **Step 3: Build the SPA**

Run: `npm run build`
Expected: Vite build succeeds, no errors.

- [ ] **Step 4: Commit**

```bash
git add web/src/components/ConnectionsManager.vue web/src/components/Settings.vue
git commit -m "feat(ui): Connections manager (list/add/edit/delete/test) in Settings"
```

---

## Task 12: Command palette — add-connection + color dots

**Files:**
- Modify: `web/src/components/CommandPalette.vue`

- [ ] **Step 1: Add an "Add connection" action + color dot on server items**

In `CommandPalette.vue`:
- Add an action item to the actions list (where "Open settings"/"Refresh schema" are defined), e.g.:
  ```js
  { kind: 'action', id: 'add-connection', label: '+ Add connection', run: () => { actions.openConnections(); } }
  ```
  (Match the existing action-item shape and however `actions`/settings-open is invoked in this file.)
- Where server items are rendered, prefix a colored dot using the connection's `color`:
  ```html
  <span class="cmd-dot" :style="{ background: item.color || 'transparent' }"></span>
  ```
  and add a small scoped style: `.cmd-dot { display:inline-block; width:8px; height:8px; border-radius:50%; margin-right:6px; }`

> Follow the file's existing item structure — server items already spread `{...s, kind:'server'}`, so `item.color` is available.

- [ ] **Step 2: Build + lint**

Run: `npm run build && npx eslint web/src/components/CommandPalette.vue`
Expected: build OK, eslint exit 0.

- [ ] **Step 3: Commit**

```bash
git add web/src/components/CommandPalette.vue
git commit -m "feat(ui): palette add-connection action + server color dots"
```

---

## Task 13: End-to-end test

**Files:**
- Create: `tests/e2e/connections.mjs`

- [ ] **Step 1: Write the e2e test**

Create `tests/e2e/connections.mjs`:

```js
/**
 * Connection manager round-trip via the API (UI is exercised by the same
 * endpoints the manager calls). Verifies: create → list reflects it →
 * import upserts → export round-trips → delete.
 */
const BASE = process.env.BASE || 'http://127.0.0.1:4321';

async function j(path, opts = {}) {
  const res = await fetch(`${BASE}${path}`, {
    headers: { 'content-type': 'application/json' },
    ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error(`${path} → ${res.status} ${data?.error?.message || ''}`);
  return data;
}

let ok = true;
function check(cond, msg) { console.log(`${cond ? '✓' : '✗'} ${msg}`); if (!cond) ok = false; }

// create
const created = await j('/api/connections', { method: 'POST', body: { label: 'E2E Temp', host: 'localhost', user: 'root', password: '', color: '#abc', group: 'e2e' } });
const id = created.connection.id;
check(id === 'e2e-temp', `created id is slug (${id})`);
check(created.connection.kind === 'local', 'localhost → local');
check(created.connection.password === undefined, 'list payload has no password');

// list reflects it
const list = await j('/api/connections');
check(list.connections.some((c) => c.id === id), 'list contains new connection');

// import upserts (idempotent)
const imp = await j('/api/connections/import', { method: 'POST', body: { version: 1, connections: [{ id, label: 'E2E Temp', host: 'localhost', user: 'root', password: '' }] } });
check(imp.result[0].status === 'updated', 'import upserts existing by id');

// export includes it (with password field)
const exp = await j('/api/connections/export');
check(exp.version === 1 && exp.connections.some((c) => c.id === id && 'password' in c), 'export round-trips with password');

// delete (cleanup)
const del = await j(`/api/connections/${id}`, { method: 'DELETE' });
check(del.ok === true, 'delete returns ok');
const after = await j('/api/connections');
check(!after.connections.some((c) => c.id === id), 'connection gone after delete');

console.log(ok ? '\n✓ ALL PASS' : '\n✗ FAIL');
process.exit(ok ? 0 : 1);
```

- [ ] **Step 2: Run it against a built server**

Run: `npm run build && LW_DB_SQLITE=/tmp/lwdb-e2e.sqlite node --no-warnings=ExperimentalWarning server/index.mjs & sleep 2 && node tests/e2e/connections.mjs ; kill %1`
Expected: `✓ ALL PASS`.

- [ ] **Step 3: Commit**

```bash
git add tests/e2e/connections.mjs
git commit -m "test(e2e): connection CRUD + import/export round-trip"
```

---

## Task 14: Docs (SKILL.md + CHANGELOG)

**Files:**
- Modify: `.claude/skills/lwdb/SKILL.md`
- Modify: `CHANGELOG.md`

- [ ] **Step 1: Document the new commands in SKILL.md**

Add a "Connections" section to `.claude/skills/lwdb/SKILL.md` describing: `servers`/`connections` list, `conn-add`/`conn-edit`/`conn-rm --yes`/`conn-test`, and `import <file.json>` / `export [file.json]` with the universal format (`{version, connections[]}`). Note connection management is config (NOT behind the `agentWrites` DB-write gate). Match the file's existing voice/format.

- [ ] **Step 2: Update CHANGELOG**

Under `## [Unreleased] → ### Added`, add a "Connections" subsection:

```markdown
#### Connections

- **Built-in connection manager** — add/edit/delete/test DB connections from Settings → Connections and the `lwdb conn-*` CLI commands. Connections are stored in SQLite (`data/lwdb.sqlite`, gitignored) alongside snippets/history, so they ride the existing backup/restore. Edits apply live without a restart. Fields: label, host, port, user, password, color, group, notes. `kind` is auto (`localhost`→local, else remote) with a manual override.
- **Universal JSON import/export** — `lwdb import <file.json>` / `lwdb export [file.json]` and `POST /api/connections/import` / `GET /api/connections/export`, format `{ "version": 1, "connections": [...] }`. See `connections.example.json`.
- **Connection test** — `lwdb conn-test <id>` and an inline "Test connection" button report connect latency before saving.
```

Under `### Changed`/`### Removed`, note:

```markdown
- **Removed the Linways `dbconfs/*.txt` dependency.** Connections now live in lwdb's own store; `dbConfsDir` is no longer required to boot. Migrate legacy files once with `node tools/dbconfs-to-json.mjs <dir>` then `lwdb import`.
```

- [ ] **Step 3: Commit**

```bash
git add .claude/skills/lwdb/SKILL.md CHANGELOG.md
git commit -m "docs: document connection manager + universal import/export"
```

---

## Task 15: Full verification + one-time data migration

**Files:** none (operational)

- [ ] **Step 1: Full check suite**

Run: `npm test && npx eslint . && npm run build`
Expected: all unit tests pass, eslint exit 0, build succeeds.

- [ ] **Step 2: E2E sweep**

Run: `LW_DB_SQLITE=/tmp/lwdb-final.sqlite node --no-warnings=ExperimentalWarning server/index.mjs & sleep 2 && for t in tests/e2e/*.mjs; do echo "== $t"; node "$t" || echo "FAILED: $t"; done ; kill %1`
Expected: every e2e prints `✓ ALL PASS`.

- [ ] **Step 3: Migrate the real Linways connections (user's machine)**

Run: `node tools/dbconfs-to-json.mjs /var/www/html/linways/professional/dbconfs data/connections.import.json`
Expected: writes 5 connections to the gitignored `data/connections.import.json`.

- [ ] **Step 4: Import into the live store**

Run: `node --no-warnings=ExperimentalWarning bin/lwdb.mjs import data/connections.import.json && node --no-warnings=ExperimentalWarning bin/lwdb.mjs servers`
Expected: 5 connections created; `servers` lists localdb (local) + the four V-servers (remote).

- [ ] **Step 5: Confirm `data/connections.import.json` is gitignored**

Run: `git check-ignore data/connections.import.json && git status --porcelain`
Expected: `git check-ignore` prints the path (it IS ignored); `git status` shows no `data/` files staged.

- [ ] **Step 6: Final commit (if any docs/state changed) — only when the user asks**

Per the user's global rule, commit only when explicitly requested. Surface the diff and ask.

---

## Self-Review Notes

- **Spec coverage:** storage (Tasks 1–2), registry/live (4), API (5), CLI (6), UI manager + empty-state prefill (11), palette + color (12), universal format + example + converter (7), retire dbconfs (8), test/export round-trip (2, 13), migration (15), docs (14). All spec sections map to a task.
- **`kind` rule** (`localhost`-only-local) is consistent across `deriveKind`, its unit test, the UI host handler, and the e2e assertion.
- **Password preservation on edit** handled in three consistent places: store `update` (merge keeps existing), UI `save` (drops empty password key on edit), and `safeConnection` (never leaks it on read).
- **No placeholders:** every code step has complete code; the two UI-wiring "follow existing structure" notes (Settings tab markup, palette item shape) point at concrete existing patterns rather than leaving logic undefined.
