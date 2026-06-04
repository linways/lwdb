# Changelog

All notable changes to **lwdb** are documented here. This project follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

#### Lifecycle & agent surface

- **One-shot `install.mjs` lifecycle script** following the lw-redmine pattern: a zero-dependency Node script at the repo root with `install` / `update` / `doctor` / `status` / `update-skill` / `uninstall` subcommands. `install` runs `npm install`, globally links the `lwdb` CLI (with a `~/.local/bin` fallback if `npm link` fails), snapshots the agent skill to `~/.lwdb/skill/SKILL.md`, symlinks it into every AI tool's skills folder it finds (`~/.claude/skills/lwdb`, `~/.copilot/skills/lwdb`, `~/.codex/skills/lwdb`), and finishes with a `doctor` pass. `update` does `git pull --ff-only` + reinstall + skill refresh.
- **`lwdb doctor`** as a CLI subcommand (delegates to `install.mjs doctor`).
- **`.claude/skills/lwdb/SKILL.md`** — agent contract, rewritten in the lw-redmine "agent-first" voice so a Claude session that sees `lwdb: command not found` knows to run `node /path/to/lwdb/install.mjs install` itself rather than asking the user to.
- **New CLI commands for agents**: `lwdb schema <server> <db>` (bulk table → columns + primary keys), `lwdb find-table <server> <pattern>` (search every db on a server).

#### Editor & query power

- **Live SQL autocomplete** (DBeaver-style). New `/api/servers/:id/databases/:db/schema` endpoint bulk-fetches `(table, column)` rows in one round-trip. The store loads it in parallel with the table list on db change; the CodeMirror SQL extension is wrapped in a `Compartment` and reconfigured live so completions reflect the active database's real schema without recreating the editor. Verified end-to-end: `SELECT * FROM ⌃Space` lists actual tables; `<table>.⌃Space` lists that table's columns.
- **From-clause-aware bare-column completion** — typing in a `WHERE` clause now suggests columns from the FROM/JOIN tables in the current statement, not just keywords. Aliases (`FROM students s`) resolve too.
- **Schema cache** (localStorage, per `(server, db)`). Linways AMS schemas are nearly identical across colleges, so we cache once and reuse — db switches are instant for completions. The `schema` chip in the top bar shows table count and a small dot when the schema is from cache; click to force-refresh. Palette also has `Refresh schema (current db)` and `Clear all cached schemas` actions.
- **Per-parameter operator override at run time.** Snippet SQL stays as `WHERE x = :x`, but you can flip the comparison to `LIKE %value%` (or any of `like`, `like_contains`, `like_starts`, `like_ends`, `neq`, `not_like`) without editing the snippet. UI: tap the small `=` button next to a param to toggle to `~`. CLI: pass `--<param>-op=<operator>`. API: `ops` map in `POST /api/snippets/:id/run`. `bindParams` rewrites the comparison adjacent to the placeholder and wraps the value with the right wildcards.
- **DBeaver-style row context menu.** Right-click any result row → copy as `INSERT` / `UPDATE` / `DELETE`, with WHERE on the detected primary key. Also Copy row as CSV / JSON. Falls back to "WHERE all cols" when no PK is known.
- **DBeaver-style keyboard shortcuts**: `⌘/Ctrl+Enter` and `F5` run the active query; `⌘/Ctrl+T` new tab; `⌘/Ctrl+W` / `⌘/Ctrl+F4` close tab; `⌘/Ctrl+S` save current SQL as snippet; `⌘/Ctrl+Shift+W` toggle write mode; `Ctrl+Tab` / `Ctrl+Shift+Tab` cycle tabs; `Esc` close palette/modal; `⌘/Ctrl+K` toggle command palette; `⌘/Ctrl+,` open settings.

#### Connection handling

- **Adaptive per-server connect timeout.** Per-server EWMA of connect time → next attempt uses `2.5 × EWMA` clamped to `[1.5 s, max(3× base, 12 s)]`. Fast SSH tunnels fail fast; slow WAN hosts get breathing room.
- One automatic retry on transient connect errors (`ECONNRESET` / `TIMEOUT` / `ETIMEDOUT` / `PROTOCOL_CONNECTION_LOST` / `EAI_AGAIN`) for read-only queries. Writes are never auto-retried.
- Per-server health tracker (`lastOk` / `lastFail` / `consecutiveFailures` / `lastError`) exposed via `GET /api/servers/health` and `GET /api/health`.
- Friendlier error messages for unreachable hosts — mentions the SSH tunnel when the failing port is a `127.0.0.1:<non-3306>` mapping.

#### UX polish

- **Loading indicators across the UI**: spinners on the server / db / schema chips while connecting; scanning progress bar on the results pane while a query runs; pulsing dot on the running tab; status-bar dot pulses with `connecting…` / `loading tables…` / `running query…`.
- **Hide / restore results pane.** Small `×` on the results toolbar collapses the pane; thin `▲ show results · N rows` bar restores it. Running a new query auto-restores.
- **Tab numbering** (`Query 1`, `Query 2`, …) — DBeaver-style, so multiple unnamed tabs are distinguishable.
- **Status bar** now also shows last query elapsed time.
- **Settings modal** (`⌘/Ctrl+,` or gear button) with five tabs: General · Editor · Results · Data · About. All prefs persist to localStorage and apply live (font size, line numbers, word wrap, NULL display, max cell width, zebra stripes, default LIMIT, confirm-destructive, write-unlocked-by-default).

#### Tests & dev

- Headless e2e suite under [`tests/e2e/`](./tests/e2e/) — Playwright-driven regression tests for: result grid render, schema cache, SQL autocomplete (table + column + contextual), Ctrl+Enter behaviour, row context menu, results toggle, server switch, param operator, settings modal.

### Fixed

- **Results pane collapsed to 4 px** when the active tab had no snippet. CSS Grid auto-placement was dropping the results pane into the splitter's 4 px track because the conditionally-rendered `ParamStrip` left a phantom `auto` row. The grid template now adapts to whether `ParamStrip` is mounted. (Caught via a headless Playwright diagnostic that compared computed pane height against rendered grid HTML — `pane.h: 4 → 360`.)
- **`Ctrl+Enter` inserted a blank line and ran the query.** `defaultKeymap` binds `Mod-Enter` to `insertBlankLine`; my custom handler came *after* the spread so it was overridden. Moved the run-binding to the top of `keymap.of([...])`, and added `event.defaultPrevented` guard in the global keydown so the same shortcut never fires twice.
- **Server switch from the palette did nothing** for non-localhost entries. Spread order in `CommandPalette` was `{ kind: 'server', ...server }` — the connection's own `kind: 'remote'` was clobbering ours, so `activate()` fell through with no case. Reordered the spread.
- **SQL guard returned stripped statement text** (string literals erased) and that's what `runQuery` sent to MySQL. `WHERE name='alice'` became `WHERE name=''`. The guard now keeps the raw statement verbatim and only strips for verb analysis. Added regression tests for string literals, backtick identifiers, comments, and pathological `;` inside identifiers.

### Changed

- Default connect timeout reduced from 8 s to 4 s — adaptive logic relaxes it per-server as needed.
- Old `bin/install-skill.mjs` removed; everything routes through `install.mjs`.

---

## [0.1.0] — 2026-05-25

Initial release.

### Added

- HTTP API (Fastify) exposing servers, databases, tables, schema, query, snippets, history, backup/restore.
- `lwdb` CLI mirroring the API; auto-emits JSON when not a TTY for AI-agent friendliness.
- `lwdb push` — bulk upsert saved queries from a JSON file or stdin (idempotent by name).
- `lwdb schema-snippets` — print the expected JSON shape for agents.
- Vue 3 SPA with ⌘K global command palette (servers · databases · tables · snippets · recent queries · actions).
- Multi-tab query workspace with CodeMirror 6 SQL editor and virtualized result grid.
- CSV / JSON copy + CSV download from result grid.
- Saved queries with `:namedParameter` substitution and default server/db.
- Query history (bounded, configurable) — surfaced both in the palette and via CLI.
- Backup/restore: SQLite snapshot via `VACUUM INTO` or portable JSON dump.
- Read-only SQL guard with comment/string-aware parser; opt-in write unlock via UI or `--writable`.
- MySQL connection pool registry with LRU eviction, idle TTL, and per-query timeout.
- Structured JSON logging on stderr.
- node:test coverage for `sqlGuard`, `snippets`, `connections`, `backup`, `validate`.
- ESLint flat config + Prettier + EditorConfig.

### Notes

- Designed for the Linways `dbconfs/*.txt` connection layout — connection definitions are read from there as the single source of truth, so the tool stays in sync with `setDB.php`.
- Requires **Node 22.5+** for built-in `node:sqlite`.
