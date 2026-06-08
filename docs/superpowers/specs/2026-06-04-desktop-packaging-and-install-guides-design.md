# Desktop Packaging & Install Guides — Design

**Date:** 2026-06-04
**Status:** Approved (pending spec review)
**Topic:** Make the desktop `.deb` reliably launch the bundled-by-reference Node server (fixing the "Connection refused" failure), formalize a layered install model (CLI+server core / desktop), and rewrite the README + installer guidance so humans and AI agents can install lwdb correctly. Packaging model: **Option A — thin `.deb` that depends on the separately-installed Node core** (no Node bundling).

## Problem

Installing the Tauri `.deb` and launching it from the desktop shows **"Could not connect to 127.0.0.1: Connection refused."** Root cause, confirmed on the user's machine (Linux Mint):

- The desktop-launched binary (`/usr/bin/app`) inherits the desktop environment's minimal `PATH`, not the shell's.
- `lib.rs` runs `node server/index.mjs`, and bare `node` resolves to **`/usr/bin/node` = v12.22.9** (the apt `nodejs` package), which lacks `node:sqlite` (needs ≥22.5). The server crashes on startup → nothing listens on `:4321` → the webview shows "Connection refused."
- The correct runtime, **Node v24.14.0**, lives at `~/.nvm/versions/node/v24.14.0/bin/node` — invisible to a desktop-launched app.
- This is why `npm run tauri:dev` works: the terminal's `PATH` has nvm's Node 24, and npm scripts start the server with it.

Secondary gaps:
- No clear, separated install story (CLI+server vs desktop); README Quick-start and `install.mjs` still reference the removed `dbconfs` model.
- The bundle binary is the default `app`, not a branded name.

## Goals

- The installed `.deb`, launched from the desktop menu, **reliably starts the server with a correct Node (≥22.5)** and loads the UI — no terminal, no env vars.
- Never trust bare `node` on `PATH`; resolve an absolute, validated runtime.
- On failure (core not installed / no suitable Node), show an **in-window remediation message**, not a bare connection error.
- Keep the lifecycle: server starts on launch, stops on close (already implemented — preserved).
- Provide a `lwdb serve` CLI subcommand so the server has a clean entry for humans.
- README + installer text present a **layered install** (core, then desktop) that humans and AI agents can follow.

## Non-goals (YAGNI)

- **No Node bundling / self-contained `.deb`** (Option B explicitly rejected). The `.deb` depends on the installed core.
- No npm-registry publishing (install stays git-clone + `install.mjs`).
- No Windows/macOS packaging work (Linux `.deb`/AppImage only, as today).
- No GitHub Actions release pipeline (manual `tauri:build` for now).

## Architecture

Single source of truth = the Node **core** (CLI + server), installed by `install.mjs` from a git clone. The desktop is a thin Tauri shell that, on launch, starts the core's server using a runtime recorded at install time, and stops it on close.

```
install.mjs install            (run with the correct Node ≥22.5)
   └─ writes ~/.lwdb/launcher.json  { node, serverEntry, cli, cwd, version, writtenAt }

desktop .deb launch (release lib.rs)
   1. resolve runtime:  env override → launcher.json → validated PATH/version-manager search
   2. spawn <node> <serverEntry>  (cwd) ; wait for 127.0.0.1:4321
   3. success → window.navigate(:4321) ;  failure → inline error page
   4. on WindowEvent::Destroyed → kill child   (unchanged)
```

## Components

### 1. Launcher manifest — `~/.lwdb/launcher.json`
Written by `install.mjs` during `install()` and `update()` (next to the existing `~/.lwdb/skill/`). Shape:
```json
{
  "version": "0.1.0",
  "node": "/home/sibin/.nvm/versions/node/v24.14.0/bin/node",
  "serverEntry": "/home/sibin/my-works/lwdb/server/index.mjs",
  "cli": "/home/sibin/my-works/lwdb/bin/lwdb.mjs",
  "cwd": "/home/sibin/my-works/lwdb",
  "writtenAt": "2026-06-04T17:00:00.000Z"
}
```
- `node` = `process.execPath` of the installer run. `install.mjs` preflight already enforces Node ≥22.5, so this path is guaranteed suitable.
- `serverEntry`/`cli`/`cwd` derive from `REPO_ROOT`.
- New `install.mjs` helper `writeLauncherManifest()`; called from `install()` and `update()`. `status` prints the manifest; `doctor` validates it (`node` exists + `node -e "require('node:sqlite')"` succeeds + `serverEntry` exists); `uninstall` removes it.

### 2. Desktop runtime resolution (`src-tauri/src/lib.rs`)
Replace `node_bin()` + `repo_root()` with a resolver returning `{ node: PathBuf, server_entry: PathBuf, cwd: PathBuf }` via this precedence:
1. **Env override** — if `LWDB_NODE` and/or `LWDB_REPO` set, use them (power-user / dev escape hatch).
2. **Manifest** — read `~/.lwdb/launcher.json` (parsed with `serde_json`). Use its `node`/`serverEntry`/`cwd` if the `node` path exists.
3. **Validated search** — candidate node paths in order: nvm current (`~/.nvm/alias/default` resolved, or newest under `~/.nvm/versions/node/*/bin/node`), `~/.volta/bin/node`, fnm dirs, `/usr/local/bin/node`, `/usr/bin/node`. For each candidate, run `<candidate> -e "require('node:sqlite')"` with a short timeout; the first that exits 0 wins. (This is what skips the broken v12.) `serverEntry` comes from the manifest if present, else the baked path.

If resolution fails (no suitable node, or no `serverEntry`), **do not spawn or navigate to a dead URL**. Instead navigate to an inline **`data:text/html,…`** URL built in Rust (self-contained — works even if `dist/` is absent) reading:
> **lwdb core not found.** Install it with: `node install.mjs install` (Node ≥22.5 required). Details: <reason>.

`serde_json` added to `src-tauri/Cargo.toml`. The startup `panic!` on spawn failure is replaced by the inline error page (no hard crash).

### 2a. Adopt-if-present / own-if-spawned (server already running)
A user (or a prior window) may already have a server on `:4321` (e.g. `lwdb serve`). The desktop must not blindly spawn a second one. On launch, before spawning:
1. **Probe `:4321`.** If something is listening, do a quick `GET /api/health` and confirm the JSON is lwdb's (has `ok:true` + a `version`).
   - **lwdb already serving →** *adopt*: navigate to it, **do not spawn**, and store no child handle.
   - **listening but not lwdb** (foreign process squatting the port) → show the inline error page ("port 4321 is in use by another application") rather than loading a stranger's page.
2. **Nothing listening →** spawn `<node> <serverEntry>` (cwd), `wait_for_listen`, navigate, and store the child handle.

On `WindowEvent::Destroyed`, kill the child **only if we spawned one** — the existing `ServerProc(Mutex<Option<Child>>)` already encodes this: it holds `Some(child)` only when the desktop spawned the server, and `None` when adopted, so an adopted server is left running (the desktop didn't start it, so it doesn't stop it). This satisfies "server stops when the app closes" for the normal case while respecting a separately-started `lwdb serve`.

The `GET /api/health` check needs a minimal HTTP read; implement with a tiny hand-rolled request over `TcpStream` (no new HTTP-client dependency) — connect, write `GET /api/health HTTP/1.0\r\n\r\n`, read the body, check it contains `"ok":true`. `wait_for_listen` (the spawn path's readiness wait) is unchanged.

### 3. Binary naming (`src-tauri/tauri.conf.json`)
Set `mainBinaryName: "lwdb-desktop"` so the bundle installs `/usr/bin/lwdb-desktop` — **not** `lwdb`, which would collide on `PATH` with the npm-linked CLI command. `productName` stays `"lwdb"` (window title + `.desktop` display name). The generated `lwdb.desktop` `Exec=` points at `lwdb-desktop`.

### 4. `lwdb serve` (`bin/lwdb.mjs`)
A convenience subcommand that runs the HTTP server in the foreground (so a CLI user can start the GUI backend without the desktop app, then open `http://127.0.0.1:4321`). Implemented as a special case handled **before** the CLI's `try { main() } finally { closeAll() }` wrapper (the server owns its own lifecycle and must not trigger the CLI's pool teardown):
```js
if (cmd === 'serve') { await import('../server/index.mjs'); }  // never returns; server keeps the loop alive
else { /* existing try/main/finally */ }
```
Documented in `help()` under a SYSTEM/SERVER section. The desktop itself spawns `<node> <serverEntry>` **directly** (not via `lwdb serve`) — fewer layers, and it already has the resolved absolute node.

### 5. Docs — README + installer text
- **README** rewrite of install-related sections into a layered matrix:
  - **Core (CLI + server):** `git clone … && cd lwdb && node install.mjs install`. Gives the `lwdb` CLI (agents + headless) and the server (`lwdb serve` / launched by the desktop). Requires Node ≥22.5.
  - **Desktop (optional):** install core first, then `npm run tauri:build` → install the `.deb`. Launching it auto-starts the server via the manifest and stops it on close. Note the one-time Rust + WebKitGTK toolchain.
  - **AI-agent block:** a one-paste install the agent can run unattended (clone + `node install.mjs install`), updated for the connection store — no `dbconfs`. State that connections are managed via `lwdb conn-add` / `lwdb import` (link `connections.example.json`), not config files.
  - Remove/replace the stale `LW_DB_CONFS_DIR` / "point at your existing connection configs" Quick-start lines.
  - Add a short **Troubleshooting** note: desktop shows "Connection refused" → core not installed or Node too old → run `node install.mjs install` with Node ≥22.5.
- **`install.mjs`** `install()` closing text: replace the `LW_DB_CONFS_DIR` guidance (lines ~135–136) with: run `lwdb conn-add …` or `lwdb import <file.json>` to add connections; mention the desktop is launched separately.

## Data flow

1. `node install.mjs install` (correct Node) → npm install + link CLI + skill + **write `~/.lwdb/launcher.json`** (records `process.execPath`).
2. User launches the `.deb` from the menu → `lib.rs` probes `:4321`: if lwdb is already serving, **adopt** (navigate, no spawn); else resolve runtime (manifest first) → spawn `<node> <serverEntry>` (cwd=repo) → wait for `:4321` → navigate.
3. Close window → child server killed **only if the desktop spawned it** (adopted servers left running).
4. `node install.mjs update` (git pull) → refreshes deps, skill, and rewrites the manifest (in case node/repo moved).

## Error handling

- **No manifest / core not installed:** inline error page with the `node install.mjs install` remediation.
- **Manifest node missing or invalid** (e.g. nvm version uninstalled): fall through to validated search; if that also fails, inline error page.
- **All candidate nodes too old** (no `node:sqlite`): inline error page naming the ≥22.5 requirement.
- **Server starts but `wait_for_listen` times out:** log it and still show the error page rather than a blank "Connection refused."
- **Server already running on `:4321`** (e.g. `lwdb serve`): the launch-time probe + `/api/health` check adopts it (window attaches, no second spawn, left running on close). See §2a.
- **`:4321` held by a non-lwdb process:** the `/api/health` check fails → inline error page ("port 4321 in use by another application"), no foreign page loaded.

## Testing

- **install.mjs (node:test):** `writeLauncherManifest()` writes valid JSON with `node === process.execPath`, absolute `serverEntry`/`cli`/`cwd`; `doctor` flags a manifest whose `node` path is missing. Use a temp `HOME`/`LWDB_DIR` override so tests don't touch the real `~/.lwdb`.
- **`lwdb serve` smoke (script):** start `node bin/lwdb.mjs serve` on a temp sqlite, poll `GET /api/health` until ok, assert `{ok:true}`, then SIGINT and assert the process exits.
- **Runtime resolver (Rust `#[test]` in lib.rs):** unit-test the candidate-validation/precedence logic where feasible (parse a manifest fixture; given a list of candidate paths + a "is-valid" predicate, the resolver picks the first valid). Pure path/precedence logic factored into a testable function; the actual process-spawn stays untested by unit tests.
- **Manual desktop verification (documented in the spec/PR):** `npm run tauri:build`; uninstall any old `.deb`; install the new one; launch from the menu → window loads the UI (server auto-started); close → server process gone (`pgrep -f server/index.mjs`). Also verify: (a) env-override path (`LWDB_NODE=… /usr/bin/lwdb-desktop`); (b) error page (rename the manifest, launch, see remediation); (c) **adopt path** — start `lwdb serve` first, launch the desktop → it attaches without spawning a second server, and after closing the window the `lwdb serve` process is **still running** (`pgrep -f server/index.mjs` still shows it).
- **Regression:** existing unit (`npm test`) + e2e (`BASE=http://127.0.0.1:4321`) suites still green.

## Migration / rollout

1. Implement manifest write (install.mjs) + `lwdb serve` + resolver (lib.rs) + binary rename + docs.
2. On the user's machine: `node install.mjs install` (writes the manifest), then `npm run tauri:build`, reinstall the `.deb`, launch from the menu → confirm it works with no env vars.
3. The old `/usr/bin/app` binary is replaced by `/usr/bin/lwdb-desktop` on reinstall; remove the stale `app` install if the package name/binary changes leave it behind (documented step).

## Open questions

None outstanding.
