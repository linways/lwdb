# lwdb — Development Guide

The single reference for how lwdb is built, tested, branched, and released. If a
procedure isn't written here, add it — this doc is the source of truth so we
don't have to rediscover the workflow.

---

## 1. Architecture in one screen

lwdb is **one Node codebase** with two entry points, plus an optional desktop shell:

- **CLI** (`bin/lwdb.mjs`) — headless, JSON-when-piped, what AI agents use. No server needed.
- **Server** (`server/index.mjs`) — Fastify HTTP API + serves the built Vue SPA on `127.0.0.1:4321`. Started by `lwdb serve` / `npm start`.
- **Web UI** (`web/`) — Vue 3 + Vite + CodeMirror 6 SPA. Built to `dist/`, served by the server.
- **Desktop** (`src-tauri/`) — a **thin** Tauri v2 shell. It does **not** bundle Node; on launch it starts the installed core's server and points a window at it. (See §7.)

Connections, snippets, history, and preferences live in a local **SQLite** file
(`data/lwdb.sqlite`, gitignored). There is no external config; the old
The legacy `dbconfs/*.txt` loader was removed (migrate with `tools/dbconfs-to-json.mjs`).

**Key invariant:** a webview can't open raw TCP to MySQL, so a native layer
(Node) always runs. Agents use the headless CLI (no server); the server exists
only to serve the human GUI.

### Project layout
```
bin/lwdb.mjs            CLI entry (commands + `serve`)
server/index.mjs        Fastify API + static SPA host
server/lib/             registry, pool, runQuery, sqlGuard, stores (connection/snippet/history/pref), config, errors, validate
web/src/                Vue SPA (components/, store.js, api.js, sqlStatements.js, sqlCompletion.js)
src-tauri/              Tauri desktop shell (Rust) + tauri.conf.json
tools/                  one-shot scripts (dbconfs-to-json.mjs, release.mjs)
install.mjs             install/update/doctor/status/uninstall lifecycle
tests/*.test.mjs        node:test unit tests
tests/e2e/*.mjs         Playwright end-to-end tests
.github/workflows/      CI (release.yml)
docs/                   this guide + superpowers specs/plans
```

---

## 2. Prerequisites

- **Node ≥ 22.5** — required for built-in `node:sqlite` (used everywhere). Anything older fails to start.
  - `node:sqlite` is still experimental, so the CLI/server run with `--no-warnings=ExperimentalWarning` (baked into the shebang/scripts).
- **npm** (lockfile committed → `npm ci` works in CI).
- For the **desktop** build only: Rust (`rustup default stable`) + WebKitGTK toolchain (see §7).

---

## 3. First-time setup

```bash
git clone git@github.com:sibincbaby/lwdb.git && cd lwdb
npm run setup        # = node install.mjs install
```

`npm run setup` runs `npm install`, links the `lwdb` CLI onto PATH, snapshots the
agent skill into `~/.lwdb/skill/` (symlinked into `~/.claude`/`~/.copilot`/`~/.codex`),
and writes `~/.lwdb/launcher.json` (the Node binary + server path the desktop app reads).

Then add a connection: `lwdb conn-add --label="Local" --host=localhost --user=root`
(or `lwdb import connections.example.json`). Verify with `lwdb doctor`.

---

## 4. Everyday commands (npm scripts)

| Command | What it does |
|---|---|
| `npm run dev` | Vite dev server (`:5174`) + API with `--watch`, concurrently. For live UI work. |
| `npm run build` | Build the SPA to `dist/`. |
| `npm start` | Run the server on `:4321` serving the built `dist/` + API. |
| `lwdb serve` | Same server, foreground (the GUI backend; what the desktop app launches). |
| `npm test` | Unit tests (`node:test`, `tests/*.test.mjs`). |
| `npm run lint` / `lint:fix` | ESLint (flat config). `.` ignores `dist/`, `node_modules/`, `data/`, `src-tauri/target/`. |
| `npm run format` | Prettier. |
| `npm run desktop:build` / `desktop:clean` / `desktop:rebuild` | Build / clean / rebuild the desktop installers (see §7). |
| `npm run release:patch` / `:minor` / `:major` | Cut a release (see §6). |
| `lwdb doctor` / `update` / `update-skill` / `uninstall` | Lifecycle (delegate to `install.mjs`). |

**Two servers, know the difference:**
- **Vite `:5174`** (`npm run dev`) — hot reload for UI dev. Its file watcher can go stale.
- **Fastify `:4321`** (`npm start`) — serves the freshly built `dist/` from disk. **Use this for reliable e2e verification.**

---

## 5. Testing

### Unit (`node:test`)
```bash
npm test                                   # all unit suites
node --test tests/connections.test.mjs     # one file
```
Pure logic (stores, sqlGuard, snippets, sqlStatements, validate, install manifest, `lwdb serve` smoke, …). Fast, no server.

### End-to-end (Playwright)
e2e tests drive a real browser against a **running server**. They live in `tests/e2e/*.mjs`.

**Gotcha — the port:** some e2e files default `BASE` to the Vite port `:5173`, others to `:4321`. The reliable way is to **build, run the Fastify server, and force `BASE=:4321`** for all of them:
```bash
npm run build
node --no-warnings=ExperimentalWarning server/index.mjs &   # serves :4321 from dist/
sleep 2
BASE=http://127.0.0.1:4321 node tests/e2e/connections.mjs   # one test
# or sweep:
BASE=http://127.0.0.1:4321 sh -c 'for t in tests/e2e/*.mjs; do node "$t" || echo "FAIL: $t"; done'
kill %1
```
e2e needs the **live store** to have connections (the local MySQL ones) for tests that query real schemas (e.g. autocomplete). Connectivity-sensitive tests need the relevant DB/SSH tunnels up.

### Rust (desktop shell)
```bash
cargo test --manifest-path src-tauri/Cargo.toml --lib
```
Pure helpers (manifest parse, Node-candidate selection) have `#[cfg(test)]` tests. The GUI launch itself is **manual** (can't be driven headlessly here) — verify a real `.deb` install by clicking the menu icon and checking `pgrep -f server/index.mjs`.

**Before any release/PR:** `npm test && npx eslint . && npm run build` should all be green (plus `cargo test` if `src-tauri/` changed).

---

## 6. Branching & releasing

### `main` is protected — every change goes through a PR
- **You cannot push to `main` directly** (rule: "Changes must be made through a pull request"). The org rules can't be relaxed.
- Workflow: branch → commit → push → open PR (`gh pr create`) → merge on GitHub (or `gh pr merge --merge --delete-branch` if clean).
- After a merge: `git checkout main && git pull && git remote prune origin`.
- **Heads-up:** GitHub's merge/list state lags a few seconds — a PR can briefly show OPEN right after you merge, and `git pull` can say "Already up to date" before propagation. Re-check with `git fetch` / `gh pr view <n>` before concluding it didn't merge.

### Commit messages
- Conventional-style (`feat:`, `fix:`, `chore:`, `docs:`, `ci:`, `test:`).
- **Never add an AI-attribution / `Co-Authored-By` trailer** (project rule).

### Releases are tag-driven (SemVer `MAJOR.MINOR.PATCH`)
The **git tag is the version of record** — there are no version numbers to hand-edit. From a clean, up-to-date `main`:
```bash
git checkout main && git pull
npm run release:patch      # 0.1.3 → 0.1.4   (fixes / polish)
npm run release:minor      # 0.1.3 → 0.2.0   (new feature, backward-compatible)
npm run release:major      # 0.1.3 → 1.0.0   (breaking change)
```
`tools/release.mjs` computes the next version from the latest `v*` tag, then creates and pushes the tag (after checks: on `main`, tracked tree clean, in sync with origin, no duplicate tag). Pushing the tag triggers CI.

**Which bump:** fix/polish → patch · new capability → minor · breaking change (renamed/removed command, changed output) → major. While on `0.x` it's loose; cut `1.0.0` (major) when you declare it stable.

### The release CI (`.github/workflows/release.yml`)
On a `v*` tag push (or manual run with a tag), an Ubuntu runner:
1. installs WebKitGTK deps + Rust (cached) + Node 22, `npm ci`;
2. **stamps the version from the tag** into `package.json` / `tauri.conf.json` / `Cargo.toml` (build-time only — that's why committed version strings don't need editing);
3. builds `.deb` / `.rpm` / `.AppImage` via `tauri-apps/tauri-action` (with `APPIMAGE_EXTRACT_AND_RUN=1`, since runners lack FUSE);
4. publishes the GitHub Release with the artifacts.

Watch a run: `gh run watch <id> --exit-status`. Tags aren't blocked by branch protection, so a release needs **no PR** — just the tag.

---

## 7. Desktop app (Tauri)

Thin shell over the **installed core** — it doesn't bundle Node.

- **Build locally:** `npm run desktop:build` (bakes in `APPIMAGE_EXTRACT_AND_RUN=1` so the AppImage builds without FUSE). `desktop:clean` removes `src-tauri/target/release/bundle`; `desktop:rebuild` does both. One-time toolchain: `rustup default stable` + `sudo apt install libwebkit2gtk-4.1-dev build-essential libxdo-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev`.
- **Binary name:** `lwdb-desktop` (NOT `lwdb` — that would collide with the CLI on PATH). Bundle id: `com.sibincbaby.lwdb`. Window opens **maximized**.
- **Runtime resolution (the "Connection refused" fix):** a desktop-launched app inherits a minimal `PATH`, so bare `node` can resolve to a wrong/old binary (e.g. an apt `node` v12 with no `node:sqlite`). The shell instead reads `~/.lwdb/launcher.json` (written by `install.mjs`) for the correct absolute Node + server path, validates fallback candidates with `node -e "require('node:sqlite')"`, **adopts** an already-running server instead of double-spawning, and shows an inline error page (not a blank refusal) if the core isn't installed. Override with `LWDB_NODE` / `LWDB_REPO`.
- **Lifecycle:** server starts on launch, is killed on close — but only if the desktop spawned it (a server you started with `lwdb serve` is left running).

---

## 8. Connections, writes, and the agent surface

- Connections are managed via the UI (Settings → Connections), the command palette, or the CLI (`conn-add`/`conn-edit`/`conn-rm`/`conn-test`, `import`/`export`). Stored in SQLite; passwords are plaintext in the gitignored `data/lwdb.sqlite` (DBeaver's trust model).
- Connection **ids preserve explicit case** (e.g. `Prod-1`) so saved snippets keep resolving; ids auto-derived from a label are lowercase slugs.
- **Read-only by default.** Writes (INSERT/UPDATE/DELETE/DDL) from the CLI/agents need **both**: a human-set master switch (`lwdb agent-writes on`, or Settings → AI Agents) **and** a per-call `--yes`. Connection management is *config*, not behind that gate; `conn-rm` still needs `--yes`.
- The agent contract lives in `.claude/skills/lwdb/SKILL.md`. After editing it, run `lwdb update-skill` to refresh the `~/.lwdb/skill/` snapshot.

---

## 9. Gotchas / lessons (don't relearn these)

- **Node ≥ 22.5 everywhere** — `node:sqlite` is the hard floor. The desktop-launch bug was entirely an old `/usr/bin/node` shadowing nvm's Node.
- **e2e port:** force `BASE=http://127.0.0.1:4321` against the built Fastify server; don't trust a test's `:5173` default unless Vite is running.
- **GitHub state lag:** PRs can show OPEN right after merge; `git pull` may say "up to date" before propagation. `git fetch` + `gh pr view` to confirm.
- **`USE <db>`** in the editor switches the active db + header (intercepted client-side); it is NOT sent to MySQL (it wouldn't stick on a pooled connection).
- **`runActive` is bound as a bare `@run` reference** in `Workspace.vue`, so `this` isn't the actions object there — reference module-scoped `actions.*`, not `this.*`, in store methods reachable from it.
- **Release clean-check ignores untracked files** (`--untracked-files=no`) — untracked docs won't block a release.
- The CI workflow used by a tag build is the one **in that tag's commit** — land workflow changes on `main` before tagging.
```
