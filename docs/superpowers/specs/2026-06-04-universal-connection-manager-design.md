# Universal Connection Manager — Design

**Date:** 2026-06-04
**Status:** Approved (pending spec review)
**Topic:** Replace the Linways-specific `dbconfs/*.txt` connection loader with a built-in, universal connection manager (add/edit/delete connections inside lwdb), backed by SQLite, with JSON import/export.

## Problem

Connections are currently parsed once at startup from `/var/www/html/linways/professional/dbconfs/*.txt` (a custom Linways PHP-snippet format) into a static in-memory array. This:

- Ties lwdb to one machine's Linways layout — it can't run usefully on a fresh machine.
- Offers no way to add, edit, or remove a connection from inside the tool.
- Is not portable or shareable.

The `.txt` files were only ever a reusable example. We want a universal connection store that any user can manage from the UI/CLI, with a clean import format so existing connections migrate once.

## Goals

- Manage connections (CRUD) from the UI and the CLI; changes take effect without a restart.
- Store connections in SQLite alongside snippets/history/prefs (rides existing backup/restore).
- Keep the exact connection object shape `{ id, label, kind, host, port, user, password }` so `pool.mjs` and all downstream consumers are unchanged.
- A documented, universal JSON import/export format. Anyone can author it.
- One-time migration of the existing Linways dbconfs into that format.
- Passwords stored plaintext in the gitignored local SQLite (DBeaver's trust model). No prompts for headless CLI/agents.

## Non-goals (YAGNI)

- Encryption / OS keychain (explicitly chosen against).
- SSH-tunnel management inside lwdb (tunnels remain external; we only connect to host:port).
- A per-connection "default database" field (not requested).
- Keeping the `.txt` format as a permanent import path (retired after one-time conversion).

## Connection model

New SQLite table `connections`:

| column       | type    | notes                                                        |
|--------------|---------|--------------------------------------------------------------|
| `id`         | TEXT PK | slug; from explicit id or derived from `label`               |
| `label`      | TEXT    | display name                                                 |
| `kind`       | TEXT    | `local` iff `host === 'localhost'`, else `remote`; override  |
| `host`       | TEXT    |                                                              |
| `port`       | INTEGER | default 3306                                                 |
| `user`       | TEXT    |                                                              |
| `password`   | TEXT    | plaintext                                                    |
| `color`      | TEXT    | nullable hex/name for palette chip                           |
| `group_tag`  | TEXT    | nullable (e.g. "production")                                 |
| `notes`      | TEXT    | nullable freeform                                            |
| `sort_order` | INTEGER | manual ordering; ties broken by label                        |
| `created_at` | TEXT    | ISO                                                          |
| `updated_at` | TEXT    | ISO                                                          |

**`kind` rule:** auto = `host === 'localhost' ? 'local' : 'remote'`. The form has a manual override toggle that pins `kind` regardless of host. Sort: `local` first, then by `sort_order`, then label.

## Components

### 1. `server/lib/connectionStore.mjs`
SQLite-backed store mirroring `PreferenceStore`. Methods:
`all()` · `get(id)` · `create(obj)` · `update(id, patch)` · `delete(id)` · `bulkUpsert(arr)` (import, idempotent by id) · `exportAll()`. Slug derivation from label when no id given (lowercase, non-alphanumeric → `-`, dedupe with numeric suffix). `updated_at` bumped on every write.

### 2. `server/lib/db.mjs`
Add a migration creating the `connections` table (idempotent `CREATE TABLE IF NOT EXISTS`).

### 3. `server/lib/registry.mjs`
- Construct a `ConnectionStore` from the opened db.
- `getConnection(id)` reads the store live (edits/additions apply without restart); throws `UNKNOWN_SERVER` if absent.
- `listConnections()` returns the sorted array (replaces the static `connections` array).
- Remove `loadConnections(dbConfsDir)` call and the `dbConfsDir` startup dependency.

### 4. `server/index.mjs` — API
- `GET /api/connections` → list via `safeConnection` (no passwords).
- `POST /api/connections` → create (validated).
- `PUT /api/connections/:id` → update.
- `DELETE /api/connections/:id` → delete.
- `POST /api/connections/test` → attempt a connect with a short timeout; return `{ ok, ms }` or an error. Works for both saved (by id) and ad-hoc (inline fields) connections.
- `POST /api/connections/import` → `bulkUpsert` from `{ version, connections: [...] }`; returns counts.
- `GET /api/connections/export` → the full JSON document (includes passwords — it's a local backup file).
- Existing `/api/servers` stays as the read view, now sourced from `listConnections()`.
- The 3 references to `registry.connections` (lines ~74, ~84, ~275) switch to `listConnections()`.

### 5. `bin/lwdb.mjs` — CLI
- `conn-add --label … --host … [--port 3306] --user … --password … [--color …] [--group …] [--notes …] [--local]`
- `conn-edit <id> [--label …] [--host …] …` (only provided flags change)
- `conn-rm <id>` (requires `--yes`)
- `conn-test <id>` (or ad-hoc via flags)
- `import <file.json>` → bulk upsert; prints `{ created, updated }`.
- `export [file.json]` → write the JSON document (stdout if no path).
- `servers` / `connections` both list. Connection management is **config**, like snippets — **not** behind the `agentWrites` DB-write gate.

### 6. UI — Connections manager
- New **Connections** tab in `Settings.vue`: list rows with color dot + group chip + notes preview; row actions edit/delete; "+ Add connection".
- Add/edit form: label, host, port, user, password (masked, reveal toggle), color picker, group, notes, and a "Treat as local" override toggle. Inline **Test connection** button shows latency or error.
- Empty state (fresh install): "Add your first connection" prompt with the form prefilled `host=localhost, port=3306, user=root`.
- Command palette: "+ Add connection" action; server items render their color dot/group.

### 7. Universal JSON format
```json
{
  "version": 1,
  "connections": [
    {
      "id": "server-84",
      "label": "V4 · Server 84",
      "host": "127.0.0.1",
      "port": 3384,
      "user": "root",
      "password": "…",
      "color": "#e23",
      "group": "production",
      "notes": "V4 main"
    }
  ]
}
```
- Import upserts by `id`; missing `id` → slug from `label`. Unknown fields ignored. `group` maps to `group_tag`.
- Ship `connections.example.json` (placeholder creds) **tracked in git** as the documented spec.
- Generate the user's real `connections.import.json` from `/var/www/html/linways/professional/dbconfs/*.txt` (parsed with the existing host/user/pass regexes) into a **gitignored** path (`data/connections.import.json`) for one-time `lwdb import`.

### 8. Retire dbconfs
- Delete `server/lib/connections.mjs` (the `.txt` parser) and its `loadConnections` usage; drop `config.dbConfsDir` from the startup path. `safeConnection` moves to `connectionStore.mjs` (still used by the API).
- Update `tests/connections.test.mjs` to cover the store (slug derivation, kind rule, bulkUpsert idempotency) instead of `.txt` parsing.

## Data flow

1. Startup: registry opens SQLite, constructs `ConnectionStore`. No file scan.
2. UI/CLI add → `create` → row inserted → next `getConnection`/`/api/servers` sees it immediately.
3. Query path unchanged: `getConnection(id)` → pool keyed by host:port:user.
4. Import: file → `bulkUpsert` → rows upserted.
5. Backup/restore: SQLite snapshot already includes the new table; JSON export is an extra portable path.

## Validation & errors

- `validate.mjs`: required `label`, `host`, `user`; `port` 1–65535 (default 3306); `color` optional hex/name; reject empty `host`.
- New/clarified codes: reuse `UNKNOWN_SERVER` for missing id; `VALIDATION` for bad payloads; `CONFLICT` if a created slug already exists and caller didn't intend upsert.
- `conn-test` failures surface the existing friendly connect-error decoration.

## Testing

- Unit (`node:test`): `connectionStore` slug derivation, kind rule (`localhost`→local, `127.0.0.1`→remote), `bulkUpsert` idempotency, `update` patch semantics, export round-trip.
- E2E (Playwright): open Connections tab → add a localhost connection → it appears in the server list/palette → edit label → delete. Import a small JSON via API → servers reflect it.
- Regression: existing query/snippet/schema tests must still pass against a store-sourced connection.

## Migration / rollout

1. Implement store + API + CLI + UI.
2. Run one-time conversion of the user's dbconfs → `data/connections.import.json`.
3. `lwdb import data/connections.import.json` to seed the five Linways servers.
4. Verify the UI lists them and queries work; then the `.txt` files are no longer referenced.

## Open questions

None outstanding.
