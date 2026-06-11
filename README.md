<p align="center">
  <img src="./assets/cover.png" alt="lwdb — lightweight MySQL browser + agent-friendly CLI" width="100%" />
</p>

<p align="center">
  <a href="https://opensource.org/licenses/MIT"><img alt="License" src="https://img.shields.io/badge/license-MIT-blue.svg"></a>
  <a href="https://nodejs.org"><img alt="Node" src="https://img.shields.io/badge/node-%E2%89%A522.5-brightgreen.svg"></a>
  <img alt="MySQL" src="https://img.shields.io/badge/MySQL-5.7%2B-4479A1?logo=mysql&logoColor=white">
  <img alt="Vue 3" src="https://img.shields.io/badge/Vue-3-42b883?logo=vuedotjs&logoColor=white">
  <img alt="Claude Code" src="https://img.shields.io/badge/Claude%20Code-skill-7b61ff.svg">
</p>

A lightweight MySQL workbench for engineers who manage many databases across several servers (prod / staging / local, behind SSH tunnels or direct). Replaces DBeaver for the 80% of daily "switch server, find a database, run a query, save it as a template" work.

Two ways to drive it, one shared core:

- 🖥️ a **native desktop app** (`.deb` / `.rpm` / `.AppImage`) — a DBeaver-style window for keyboard-first humans;
- ⌨️ a **JSON-native `lwdb` CLI** (+ an MCP server) that AI agents run headlessly — every command emits a stable JSON envelope when not a TTY, so a Claude Code session can do anything the GUI can.

> On a headless or remote box where the desktop app can't run? `lwdb serve` and open the **same UI in your browser** over an SSH tunnel — the GUI travels with the server (see **🌐 Remote / headless** below).

> [!NOTE]
> **Status:** Shipped and in daily use — CLI (`lwdb`), MCP server (`lwdb mcp`), the native desktop app with versioned GitHub Releases, a built-in connection manager, AES-256-GCM-encrypted credentials, SQLite-backed connections/snippets/history/preferences, the Claude Code skill, and a one-shot `install.mjs` lifecycle. Under the hood it's a Vue 3 + CodeMirror UI over a Fastify API; you drive it through the desktop window, the CLI, or (remotely) a browser. Production-tested against the V3 / V4 / local MySQL servers over SSH tunnels.

---

## ⚡ Quick start

```bash
# 1. Install the core (CLI + server). Needs Node ≥ 22.5.
git clone https://github.com/sibincbaby/lwdb.git lwdb && cd lwdb
npm run setup

# 2. Add a connection (or import many — see connections.example.json)
lwdb conn-add --label="Local" --host=localhost --user=root
# lwdb import connections.example.json

# 3. Use it
lwdb servers
lwdb query localdb information_schema "SELECT 1"
```

Details below.

---

## ✨ Highlights

- **One picker for everything.** `⌘K` opens a global palette — fuzzy-find servers, databases, tables, saved queries, recent queries, actions. No tree to expand.
- **Multi-tab workspace.** Run against `prod` and `staging` side by side — no global "active database" to switch.
- **Live SQL autocomplete** with from-clause awareness — typing in `WHERE` suggests the actual columns of the table in the current `FROM`, alongside dot-prefix `tbl.col` and SQL keyword completions.
- **Saved templates with named parameters** (`:studentId`) and per-run operator overrides — flip `name = :name` to `LIKE %name%` without editing the snippet.
- **DBeaver-style right-click on result rows** → copy as `INSERT` / `UPDATE` / `DELETE`, with WHERE on the detected primary key.
- **Adaptive connection handling.** Per-server EWMA of connect time → tighter timeouts on fast SSH tunnels, more slack on direct WAN hosts. One automatic retry on transient errors (read-only queries only).
- **Read-only by default.** SELECT / SHOW / DESCRIBE / EXPLAIN only — until you explicitly unlock writes.
- **Interactive write approval.** An agent can request approval for one specific write (`lwdb query … --approve`); the desktop app pops a modal showing the exact SQL, and the write runs server-side only when you click **Approve**. Per-write human consent — no global switch to leave flipped on. Write-protected connections (`conn-add --protected`) refuse writes outright.
- **SQLite storage.** Connections, snippets, query history, and preferences in one file (`data/lwdb.sqlite`). Backup = copy a file.
- **Encrypted credentials at rest.** Connection passwords are AES-256-GCM encrypted in SQLite; the key lives in a separate `0600` file at `~/.lwdb/key` (or `LW_DB_KEY`/`LW_DB_KEY_FILE`), never inside the DB. Steal `lwdb.sqlite` alone and you get ciphertext. `lwdb secure status` shows the key source and how many rows are encrypted; `lwdb secure migrate` re-encrypts any legacy plaintext rows. (No OS-keychain prompt per command — that would wreck the agent CLI; keychain storage of the key is an optional desktop-side enhancement.)
- **Built-in connection store.** Connections live in lwdb's own SQLite store — add them with `lwdb conn-add` or `lwdb import` (universal JSON, see `connections.example.json`). Have a directory of legacy `dbconf`-style `*.txt` files? Convert once with `node tools/dbconfs-to-json.mjs <dir>`, then `lwdb import`.
- **Agent-friendly CLI.** `lwdb` mirrors every UI capability; auto-JSON when piped; bulk template push idempotent by name.

---

## 📦 Install

lwdb installs in two layers — install the core; the desktop app is optional.

### Core (CLI + server) — required

Needs **Node ≥ 22.5** (for built-in `node:sqlite`).

```bash
git clone https://github.com/sibincbaby/lwdb.git lwdb && cd lwdb
npm run setup
```

This installs deps, puts the `lwdb` CLI on your PATH, installs the agent skill, and writes `~/.lwdb/launcher.json` (so the desktop app can find this Node + server). Run `lwdb doctor` anytime to check the install.

The same core gives you:

- `lwdb …` — the headless CLI (what AI agents use)
- `lwdb mcp` — the MCP server for AI clients (stdio)
- `lwdb serve` — the GUI server on http://127.0.0.1:4321 (what the desktop app runs; also openable in a browser for remote/headless use)

### Desktop app (optional)

See **🖥️ Desktop app** below. It depends on the core being installed.

<details>
<summary>What the installer does, step by step</summary>

1. Verifies Node ≥ 22.5 (built-in `node:sqlite`), npm, git.
2. Runs `npm install`.
3. Globally links the `lwdb` binary (`npm link`) — with a `~/.local/bin` fallback if the global link is unavailable.
4. Snapshots `.claude/skills/lwdb/SKILL.md` to `~/.lwdb/skill/` (the canonical location — a copy, so updates don't change the file under a running agent).
5. Detects installed AI tools and symlinks the canonical skill into each:
   - `~/.claude/skills/lwdb/` (Claude Code)
   - `~/.copilot/skills/lwdb/` (GitHub Copilot)
   - `~/.codex/skills/lwdb/` (Codex CLI)
6. Writes `~/.lwdb/launcher.json` (the Node binary + server path the desktop app uses).
7. Runs `doctor` — Node, deps, `lwdb` on PATH, skill snapshot, Claude link, launcher manifest, `lwdb servers` loads.

Tools whose dotdir isn't present are skipped silently. Re-running `install` is idempotent.

</details>

Verify:

```bash
which lwdb && lwdb --help
lwdb doctor
node install.mjs status
```

### Update

```bash
lwdb update                  # git pull --ff-only → npm install → relink → refresh skill
```

Because every AI tool symlinks the same canonical bundle, `update` only writes `~/.lwdb/skill/` once — the symlinks pick it up automatically. The new SKILL.md is loaded by the **next** agent session, not the current one.

### Skill-only refresh

```bash
lwdb update-skill                # after a manual git pull, refresh only the skill snapshot
```

### Uninstall

```bash
lwdb uninstall               # removes CLI link + skill symlinks; preserves ~/.lwdb user data
```

To wipe data too: `rm -rf ~/.lwdb data/` afterward.

<details>
<summary>Manual install (without the installer script)</summary>

```bash
git clone https://github.com/sibincbaby/lwdb.git lwdb && cd lwdb
npm install
npm link                       # puts `lwdb` on $PATH
```

You'll then need to symlink the skill manually into each AI tool's folder:

```bash
ln -s "$PWD/.claude/skills/lwdb" "$HOME/.claude/skills/lwdb"
```

</details>

---

## 🖥️ Desktop app (optional)

The desktop app is the primary GUI — a DBeaver-style native window. It's a thin [Tauri](https://tauri.app) shell ([`src-tauri/`](./src-tauri)) over the **installed core**: it doesn't bundle Node, it just runs the lwdb server (using the Node recorded in `~/.lwdb/launcher.json`) and points a native window at it, stopping it when you close the window. If a server is already running (e.g. you ran `lwdb serve`), it attaches to that one and leaves it running on close.

> The window and a browser tab are the same UI from the same local server — the desktop app is simply the packaged, double-click way to get it. Use the desktop app on your workstation; use a browser over SSH for remote/headless boxes (below).

**In both cases you need the core installed** (`npm run setup`) — the desktop app runs the core's server and reads `~/.lwdb/launcher.json` to find Node.

### Option A — download a release (no build)

Grab the `.deb` (or `.rpm` / `.AppImage`) from the [**Releases page**](https://github.com/sibincbaby/lwdb/releases/latest):

```bash
sudo dpkg -i lwdb_*_amd64.deb          # Debian/Ubuntu/Mint
# sudo rpm -i lwdb-*.x86_64.rpm        # Fedora/RHEL
# chmod +x lwdb_*_amd64.AppImage && ./lwdb_*_amd64.AppImage   # portable (needs libfuse2)
```

No Rust toolchain needed — just the core. Launch "lwdb" from your app menu; it opens maximized.

### Option B — build from source

One-time Tauri toolchain (Rust + WebKitGTK):

```bash
#   Rust:  https://rustup.rs   →  rustup default stable
#   Linux: sudo apt install libwebkit2gtk-4.1-dev build-essential \
#                           libxdo-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev
```

Then:

```bash
npm run tauri:dev        # native window, HMR — for development
npm run desktop:build    # build .deb / .rpm / .AppImage → src-tauri/target/release/bundle/
npm run desktop:clean    # remove old build artifacts (the bundle/ dir)
npm run desktop:rebuild  # desktop:clean + desktop:build
```

`desktop:build` bakes in `APPIMAGE_EXTRACT_AND_RUN=1` so the AppImage builds even without FUSE. Then install the `.deb` (`sudo dpkg -i …`). The binary is `lwdb-desktop`; the menu entry is "lwdb".

Override the Node binary or repo root the app uses with `LWDB_NODE=/path/to/node` and `LWDB_REPO=/path/to/lwdb`.

> [!NOTE]
> **Releases are one command.** From a clean, up-to-date `main`:
> ```bash
> npm run release:patch   # 0.1.2 → 0.1.3   (or release:minor / release:major)
> ```
> It computes the next version from the latest tag, pushes the tag, and GitHub Actions ([`.github/workflows/release.yml`](./.github/workflows/release.yml)) stamps that version into the build and publishes the `.deb`/`.rpm`/`.AppImage` — no version files to edit (the git tag is the source of truth). Local `npm run desktop:build` still works for one-off builds.

> [!NOTE]
> The desktop app is just the packaged, double-click way to open the **human** UI. **AI agents don't need it** — they use the `lwdb` CLI, which is fully headless and needs no server or window (see below).

---

## 🌐 Remote / headless

The desktop `.deb` is for your workstation. On a **headless or remote box** — a server with no desktop, or a DB you can only reach through an SSH tunnel — there's no window to open, but you can still get the full GUI: run the server there and forward its port to your laptop.

```bash
# On the remote host (where the core is installed):
lwdb serve                       # GUI server on 127.0.0.1:4321

# On your laptop — forward the port over SSH, then open a browser:
ssh -N -L 4321:127.0.0.1:4321 you@remote-host
#   → open http://127.0.0.1:4321
```

Same UI, same server — just reached through a browser instead of the native window. The port stays bound to `127.0.0.1` on **both** machines and only travels inside your SSH session, so nothing is exposed to the network.

If you ever need to bind **beyond** localhost, turn on the API token first: set `LW_DB_TOKEN=<random string>` (env or `.env`). Every `/api` request then requires it — `Authorization: Bearer <token>`, or `?token=<token>` for a browser's first page load (the SPA stores it after that). The CLI and MCP server read `LW_DB_TOKEN` from the same environment automatically. Unset (the default) means no auth — correct for the localhost-only model.

---

## 🤖 For AI agents

`lwdb` is built to be the substrate under Claude Code / Copilot / any agent that can shell out. Every command auto-emits JSON when not a TTY, errors with stable `code` strings, and never prompts in non-TTY contexts.

### One-paste install (for the agent)

```bash
# Install lwdb for the user (Node ≥ 22.5 required):
git clone https://github.com/sibincbaby/lwdb.git lwdb && cd lwdb && npm run setup
# Verify, then add connections:
lwdb doctor
lwdb conn-add --label="Local" --host=localhost --user=root   # or: lwdb import <file.json>
```

After install completes, open a new Claude Code session — the `lwdb` skill auto-activates and the agent learns the full command surface from [`.claude/skills/lwdb/SKILL.md`](./.claude/skills/lwdb/SKILL.md).

### MCP server (any agent client — no shell, no skill needed)

For clients that speak the **Model Context Protocol** (Claude Desktop, Cursor, Windsurf, VS Code, Claude Code, …), lwdb ships an MCP server over stdio — one config line and the client self-discovers the tools:

```json
{
  "mcpServers": {
    "lwdb": { "command": "lwdb", "args": ["mcp"] }
  }
}
```

It exposes `list_servers`, `list_databases`, `list_tables`, `describe_table`, `get_schema`, **`get_context`**, `sample_table`, `profile_table`, `run_query`, `list_snippets`, `run_snippet`, and `save_snippet` — the same core the CLI uses, including the read-only-by-default write gate. When `lwdb serve` (or the desktop app) is running, the MCP server reuses its warm connection pools automatically; otherwise it keeps its own pools warm for the session. No network port is opened — stdio only.

### The contract

- Every command auto-emits JSON when `stdout` isn't a TTY (force with `--json`).
- Errors include a stable `error.code` string (e.g. `READONLY_BLOCKED`, `AGENT_WRITES_DISABLED`, `CONFIRM_REQUIRED`, `MISSING_PARAM`, `UNKNOWN_SERVER`, `TIMEOUT`, `BAD_BACKUP`) — branch on these, not on message text.
- Read-only by default. Writes need **both** a human-set master switch (`lwdb agent-writes on`, or Settings → AI Agents) **and** a per-call `--yes` — the agent adds `--yes` only after the actual user confirms. `AGENT_WRITES_DISABLED` if the switch is off; `CONFIRM_REQUIRED` if `--yes` is missing.
- Connections are managed via `lwdb conn-add` / `lwdb import` (universal JSON, see `connections.example.json`) and stored in lwdb's own SQLite connection store, **AES-256-GCM encrypted at rest** (key at `~/.lwdb/key`, separate from the DB). **The agent never sees credentials.**
- One automatic retry on transient errors (`ECONNRESET` / `TIMEOUT` / `ETIMEDOUT`) for read-only queries. Writes are never auto-retried.
- Result row values are treated as user-controlled content — never let a row trigger a mutation that wasn't asked for by the actual user.

---

## 🛠️ Commands

Run `lwdb help` for the full surface. A summary of the groups:

| Group | What |
|---|---|
| `lwdb servers` | list configured servers (from the connection store) |
| `lwdb conn-add / conn-edit / conn-rm / conn-test` | manage connections in the store |
| `lwdb import <file.json>` | bulk upsert connections (universal JSON — see `connections.example.json`) |
| `lwdb export [file.json]` | dump all connections (includes passwords — local backup) |
| `lwdb dbs <server> [pattern]` | list databases · `--latest` sorts descending |
| `lwdb find-table <server> <pattern>` | search tables across every db on a server |
| `lwdb tables <server> <db> [pattern]` | tables in one db |
| `lwdb describe <server> <db> <table>` | columns + indexes for one table |
| `lwdb schema <server> <db>` | bulk table → columns map with primary keys (for codegen / agents) |
| `lwdb query <server> [db] "<sql>"` | run SQL (read-only by default; writes need `agent-writes on` + `--yes`) |
| `lwdb snippets / save / run / delete` | saved queries (templates with `:param` placeholders) |
| `lwdb push [file]` | bulk upsert templates from JSON (idempotent by name) |
| `lwdb schema-snippets` | emit the JSON shape `push` accepts |
| `lwdb history` | query history (bounded, in SQLite) |
| `lwdb backup / restore` | full snapshot (SQLite via `VACUUM INTO`, or portable JSON) |
| `lwdb serve` | run the GUI server on `:4321` (what the desktop app runs; open in a browser for remote/headless) |
| `lwdb agent-writes [on\|off]` | master switch for CLI/agent writes (off by default) |
| `lwdb doctor` · `update` · `update-skill` · `uninstall` | install lifecycle (delegate to `install.mjs`) |

Run `lwdb <cmd> --help` for flag info.

---

## 📋 Cheatsheet

<details>
<summary>Click to expand a copy-pasteable cheatsheet covering the most common workflows.</summary>

```bash
# Discover — list databases on a server (filter by substring, newest first)
lwdb dbs prod app --latest --json

# Search for a table across every db on a server
lwdb find-table prod users --json

# Inspect schema before generating SQL
lwdb schema prod app_production --json    # full table → cols map
lwdb describe prod app_production users --json

# Run a read-only query
lwdb query prod app_production "SELECT id, name FROM users LIMIT 5"

# Run a write — needs the master switch ON + per-call --yes (after the user confirms)
lwdb agent-writes on
lwdb query prod app_production \
  "UPDATE users SET status='archived' WHERE id=42" --yes

# Save a parametrized template
lwdb save user-by-id "SELECT * FROM users WHERE user_id = :id" \
  --description="Look up a user by id" \
  --tags=users \
  --default-server=prod

# Run it
lwdb run user-by-id --id=12345 --db=app_production

# Per-param operator at run time — exact → contains, no snippet edit
lwdb run rule-by-name --name='PROMO' --name-op=like_contains

# Bulk-push templates an AI agent prepared (idempotent by name)
cat templates.json | lwdb push

# History — what did I run an hour ago?
lwdb history --server=prod --limit=20

# Backup / restore
lwdb backup --format=sqlite --out=/tmp/lwdb-$(date +%F).sqlite
lwdb restore /tmp/lwdb-2026-05-26.json --merge
```

</details>

---

## 🧰 Configuration

Resolution order for any setting (highest wins):

1. **CLI flag / env var on the call** — `--json`, `--writable`, `--limit=N`, `--<param>-op=<op>`, …
2. **Process env** — see table below
3. **`package.json#lwDb`** — checked-in defaults
4. **Hardcoded defaults** — [`server/lib/config.mjs`](./server/lib/config.mjs)

### Environment variables

| Var | Purpose |
|---|---|
| `LW_DB_HOST` / `LW_DB_PORT` | HTTP bind (default `127.0.0.1:4321`). |
| `LW_DB_SQLITE` | SQLite file path (default `./data/lwdb.sqlite`). |
| `LW_DB_DATA_DIR` | Directory for SQLite + backups (default `./data`). |
| `LW_DB_QUERY_TIMEOUT_MS` | Per-query timeout (default `30000`). |
| `LW_DB_LOG_LEVEL` | `debug` / `info` / `warn` / `error` / `silent` (default `info`). |
| `LWDB_NODE` | Absolute path to the Node binary the desktop app should use (overrides the launcher manifest). |
| `LWDB_REPO` | Repo root the desktop app should run the server from (overrides the manifest). |

See [`.env.example`](./.env.example).

### State directory

```
data/                           # everything lwdb owns lives here (gitignored)
├── lwdb.sqlite                 # connections · snippets · query_history · preferences
├── lwdb.sqlite-wal             # WAL companion
├── lwdb.sqlite-shm             # shared-memory companion
└── backups/                    # snapshots from `lwdb backup`
    ├── lwdb-backup-*.sqlite    # VACUUM INTO snapshots
    └── lwdb-backup-*.json      # portable JSON dumps
```

`~/.lwdb/` (created by `install.mjs`) is separate — it holds the canonical SKILL.md snapshot that AI-tool folders symlink to, plus `launcher.json` (the Node binary + server path the desktop app uses).

---

## 🧪 Development

> Full contributor reference — architecture, testing, the branch/PR + release flow, desktop build, and gotchas — lives in **[`docs/DEVELOPMENT.md`](./docs/DEVELOPMENT.md)**.

```bash
npm run dev                    # vite (5174) + fastify (4321) with --watch
npm test                       # node:test unit suites, no extra runner
npm run lint
npm run format
npm run build                  # vite production build
```

### E2E tests (Playwright)

Headless smoke tests for the SPA in [`tests/e2e/`](./tests/e2e):

```bash
node tests/e2e/diagnose-results.mjs    # results grid renders after a query
node tests/e2e/autocomplete.mjs        # FROM/JOIN-aware completions
node tests/e2e/schema-cache.mjs        # localStorage cache hits + manual refresh
node tests/e2e/row-context-menu.mjs    # right-click → Copy as INSERT/UPDATE/DELETE
node tests/e2e/settings.mjs            # Settings modal applies prefs live
# … and others, listed in tests/e2e/
```

Each drives a real browser against a running server and exits non-zero on regression. The reliable way is to build, serve on `:4321`, and force `BASE=http://127.0.0.1:4321` (some tests default to the Vite port) — see [`docs/DEVELOPMENT.md`](./docs/DEVELOPMENT.md) §5 for the exact recipe. `HEADFUL=1` watches in a real browser.

### Architecture (one-line per layer)

```
server/
├── index.mjs           # Fastify HTTP API + static SPA host
└── lib/
    ├── config.mjs      # env + package.json#lwDb resolution
    ├── log.mjs         # structured JSON logger
    ├── errors.mjs      # typed error codes + HTTP status mapping
    ├── validate.mjs    # request input guards
    ├── connectionStore.mjs # SQLite connection store (CRUD, import/export)
    ├── db.mjs          # opens SQLite, runs migrations, withTx
    ├── snippets.mjs    # saved queries + named-param + operator overrides
    ├── history.mjs     # query history (bounded, auto-trimmed)
    ├── preferences.mjs # k/v server-side prefs
    ├── pool.mjs        # MySQL pool registry — LRU + idle TTL + adaptive timeout
    ├── connectionHealth.mjs # per-server EWMA, transient-error retry policy
    ├── sqlGuard.mjs    # quote/comment-aware read-only SQL parser
    ├── runQuery.mjs    # one-call query orchestrator (guard + limit + history)
    ├── backup.mjs      # JSON export + sqlite VACUUM INTO
    └── registry.mjs    # builds the app-wide context

bin/lwdb.mjs            # CLI — shares the same lib code (incl. `serve`)
install.mjs             # zero-dep installer/updater/doctor (run by humans + agents)
src-tauri/              # Tauri v2 desktop shell (Rust) — thin window over the core
tools/                  # one-shot scripts: dbconfs-to-json.mjs · release.mjs

web/                    # Vue 3 SPA
├── index.html
└── src/
    ├── App.vue · store.js · api.js · prefs.js · sqlCompletion.js · sqlStatements.js · sqlGen.js
    └── components/     # TopBar · Workspace · QueryEditor (CodeMirror 6) · ResultsView
                        # CommandPalette (⌘K) · SnippetEditor · Settings · ConnectionsManager
                        # ContextMenu · ParamStrip · StatusBar · Toast

tests/                  # node:test (unit) + Playwright (e2e/)
.claude/skills/lwdb/   # SKILL.md — canonical agent contract (snapshotted by install.mjs)
```

### Why SQLite?

- Single-file storage — `cp data/lwdb.sqlite somewhere` is the entire backup.
- Safe concurrent writes when CLI and UI run at once.
- Room to grow (query history, favorites, soft-delete, full-text search).
- Built into Node 22.5+, no native bindings to compile.

### Read-only by default

The SQL guard:

- Strips comments and string/quoted-identifier content **before** scanning verbs (so `'DROP'` inside a string literal can't trip the guard).
- Splits statements at unquoted `;` only.
- Requires the leading verb to be in `{SELECT, SHOW, DESCRIBE, DESC, EXPLAIN, WITH, USE}` **and** that no write verb (`INSERT`, `UPDATE`, `DELETE`, `DROP`, `CREATE`, `ALTER`, `TRUNCATE`, `RENAME`, `GRANT`, `REVOKE`, `CALL`, `LOAD`, `LOCK`, `UNLOCK`, `SET`, `REPLACE`, `MERGE`, `HANDLER`) appears anywhere in the cleaned body.
- In the UI, flip the write switch in the top bar. On the CLI, writes need the master switch on (`lwdb agent-writes on`) **plus** a per-call `--yes` (`--confirm`/`--writable` also count as the confirmation).

### Connection pool lifecycle

- One `mysql2` pool per `(serverId, db)` tuple (`connectionLimit: 5`).
- LRU cap on total pools (default 32) — least-recently-used evicted under pressure.
- Idle pools closed after 10 minutes.
- Per-query and per-connect timeouts adapt to each server's EWMA of recent connect times — fast SSH tunnels fail fast, direct WAN hosts get slack.
- One automatic retry on transient errors for read-only queries; writes never auto-retry.

---

## 🩺 Troubleshooting

**Desktop app shows "Could not connect to 127.0.0.1: Connection refused".**
The app couldn't find a suitable Node (≥ 22.5) to start the server. Fix:

1. Install/refresh the core with a modern Node: `npm run setup` (this writes `~/.lwdb/launcher.json`).
2. Confirm: `lwdb doctor` shows "desktop launcher manifest ✓".
3. Relaunch the app.

Override manually if needed: `LWDB_NODE="$(which node)" lwdb-desktop`.

---

## 📜 License

[MIT](./LICENSE) © lwdb contributors
