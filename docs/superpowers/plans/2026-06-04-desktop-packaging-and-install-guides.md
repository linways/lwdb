# Desktop Packaging & Install Guides Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the installed Tauri `.deb` reliably start the lwdb server with a correct Node (≥22.5) and stop "Connection refused", via a launcher manifest the desktop reads; add `lwdb serve`; adopt an already-running server instead of double-spawning; and rewrite the README/installer for a layered (core → desktop) install humans and agents can follow.

**Architecture:** Option A (thin desktop over the installed Node core, no Node bundling). `install.mjs` writes `~/.lwdb/launcher.json` recording the correct `node` path (`process.execPath`) + server entry. The release Tauri shell (`lib.rs`) resolves the runtime (env → manifest → validated search where each candidate must pass `node -e "require('node:sqlite')"`), probes `:4321` to adopt an existing lwdb server (or spawn its own and kill on close), and shows an inline error page on failure.

**Tech Stack:** Node 22+ (node:sqlite), Fastify, `install.mjs` (Node stdlib), Tauri v2 / Rust (serde_json already a dep; add `base64`), node:test.

---

## File Structure

- `install.mjs` — add `writeLauncherManifest()`, call from `install()`/`update()`; de-dbconfs `doctor`/`status`/`uninstall`/`install` text; remove dead `resolveDbConfsDir()`; guard bottom `main()` so the module is importable for tests. One responsibility unchanged (lifecycle script).
- `bin/lwdb.mjs` — add a `serve` subcommand (foreground server) + help text.
- `src-tauri/src/lib.rs` — replace `node_bin`/`repo_root` with a manifest-aware, validated runtime resolver; add health-probe adopt logic + inline error page. Heaviest change.
- `src-tauri/Cargo.toml` — add `base64` (for the data-URL error page).
- `src-tauri/tauri.conf.json` — `mainBinaryName: "lwdb-desktop"` (avoid colliding with the `lwdb` CLI).
- `README.md` — layered install matrix, agent block, desktop+troubleshooting, de-dbconfs.
- Tests: `tests/install.test.mjs` (manifest), `tests/serve.test.mjs` (serve integration). Rust `#[cfg(test)]` in `lib.rs`.

---

## Task 1: install.mjs — launcher manifest (TDD) + importable module

**Files:**
- Modify: `install.mjs`
- Test: `tests/install.test.mjs`

- [ ] **Step 1: Write the failing test**

Create `tests/install.test.mjs`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { writeLauncherManifest } from '../install.mjs';

test('writeLauncherManifest writes a valid manifest to the given dir', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'lwdb-launch-'));
  try {
    const m = writeLauncherManifest(dir);
    assert.equal(m.node, process.execPath);
    assert.ok(m.serverEntry.endsWith('/server/index.mjs'), `serverEntry: ${m.serverEntry}`);
    assert.ok(m.cli.endsWith('/bin/lwdb.mjs'), `cli: ${m.cli}`);
    assert.ok(m.cwd.length > 0);
    assert.ok(m.version, 'version present');
    const onDisk = JSON.parse(await readFile(join(dir, 'launcher.json'), 'utf8'));
    assert.equal(onDisk.node, process.execPath);
    assert.equal(onDisk.serverEntry, m.serverEntry);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test tests/install.test.mjs`
Expected: FAIL — `install.mjs` does not export `writeLauncherManifest` (and importing it currently executes `main()`).

- [ ] **Step 3: Make install.mjs importable + add the manifest writer**

In `install.mjs`:

(a) Add a constant near the other path constants (after `const CANONICAL_SKILL = …`):
```js
const LAUNCHER_MANIFEST = path.join(LWDB_DIR, 'launcher.json');
```

(b) Add this exported function in the "Steps" section (e.g. right after `snapshotSkill()`):
```js
/**
 * Record where the desktop app should find Node + the server. The desktop
 * (which inherits a minimal PATH and can't see nvm/version-manager Node) reads
 * this to launch the server with an absolute, known-good runtime. `process.execPath`
 * is the Node that ran this installer — install.mjs preflight already enforces ≥22.5.
 */
export function writeLauncherManifest(dir = LWDB_DIR) {
  ensureDir(dir);
  const pkg = JSON.parse(fs.readFileSync(REPO_PKG, 'utf8'));
  const manifest = {
    version: pkg.version,
    node: process.execPath,
    serverEntry: path.join(REPO_ROOT, 'server', 'index.mjs'),
    cli: path.join(REPO_ROOT, 'bin', 'lwdb.mjs'),
    cwd: REPO_ROOT,
    writtenAt: new Date().toISOString(),
  };
  fs.writeFileSync(path.join(dir, 'launcher.json'), JSON.stringify(manifest, null, 2) + '\n');
  console.log(c('green', `✓ launcher manifest -> ${path.join(dir, 'launcher.json')}`));
  return manifest;
}
```

(c) Call it from `install()` — add `writeLauncherManifest();` right after `linkSkillsForAllAITools();` (before the "install complete" log).

(d) Call it from `update()` — add `writeLauncherManifest();` right after `linkSkillsForAllAITools();` (before the "update complete" log).

(e) Make the module importable: change the final bare `main();` at the very bottom of the file to:
```js
if (import.meta.url === `file://${process.argv[1]}`) main();
```

- [ ] **Step 4: Run to verify it passes**

Run: `node --test tests/install.test.mjs`
Expected: PASS (1 test).

- [ ] **Step 5: Verify the CLI entry still runs**

Run: `node install.mjs status`
Expected: prints the status banner (the guarded `main()` still executes when run directly).

- [ ] **Step 6: Commit**

```bash
git add install.mjs tests/install.test.mjs
git commit -m "feat(install): write ~/.lwdb/launcher.json; make installer importable"
```

---

## Task 2: install.mjs — de-dbconfs doctor/status/uninstall/text

**Files:**
- Modify: `install.mjs`

- [ ] **Step 1: Replace the dbconfs doctor checks with a launcher-manifest check**

In `doctor()`, DELETE checks 6 and 7 (the dbconfs blocks):
```js
  // 6. dbconfs directory configured
  const dbConfsDir = resolveDbConfsDir();
  checks.push({
    name: 'dbconfs directory',
    ok: !!dbConfsDir,
    detail: dbConfsDir || 'not set (LW_DB_CONFS_DIR env or package.json#lwDb.dbConfsDir)',
  });

  // 7. dbconfs has *.txt files
  if (dbConfsDir && exists(dbConfsDir)) {
    const txtCount = fs.readdirSync(dbConfsDir).filter((f) => f.endsWith('.txt')).length;
    checks.push({
      name: 'connections configured',
      ok: txtCount > 0,
      detail: txtCount > 0 ? `${txtCount} *.txt file(s)` : `no *.txt in ${dbConfsDir}`,
    });
  }
```
Replace them with a launcher-manifest validation check:
```js
  // 6. desktop launcher manifest (Node + server path the .deb uses)
  if (!exists(LAUNCHER_MANIFEST)) {
    checks.push({ name: 'desktop launcher manifest', ok: false, detail: `${LAUNCHER_MANIFEST} (run install to create)` });
  } else {
    try {
      const m = JSON.parse(fs.readFileSync(LAUNCHER_MANIFEST, 'utf8'));
      const nodeOk = !!m.node && exists(m.node);
      const entryOk = !!m.serverEntry && exists(m.serverEntry);
      checks.push({
        name: 'desktop launcher manifest',
        ok: nodeOk && entryOk,
        detail: `node ${nodeOk ? '✓' : 'missing'}, serverEntry ${entryOk ? '✓' : 'missing'}`,
      });
    } catch (e) {
      checks.push({ name: 'desktop launcher manifest', ok: false, detail: `invalid JSON: ${e.message}` });
    }
  }
```
(Leave check 8 "lwdb servers loads" intact — it now reads the SQLite store.)

- [ ] **Step 2: Remove the now-dead `resolveDbConfsDir()` helper**

Delete the whole function (in the Helpers section):
```js
function resolveDbConfsDir() {
  if (process.env.LW_DB_CONFS_DIR) return process.env.LW_DB_CONFS_DIR;
  try {
    const pkg = JSON.parse(fs.readFileSync(REPO_PKG, 'utf8'));
    return pkg.lwDb?.dbConfsDir || null;
  } catch (_) { return null; }
}
```

- [ ] **Step 3: Add the manifest to `status()` and fix `install()` closing text**

In `status()`, after the `snapshot:` line, add:
```js
  console.log(`launcher:  ${LAUNCHER_MANIFEST} ${exists(LAUNCHER_MANIFEST) ? c('green', '✓') : c('yellow', 'missing')}`);
```

In `install()`, replace the two closing dbconfs lines:
```js
  console.log(`${c('bold', 'Next:')} run ${c('cyan', 'lwdb servers')} to verify your connection configs.`);
  console.log(`Configure ${c('cyan', 'LW_DB_CONFS_DIR')} in your environment (or ${c('cyan', 'package.json#lwDb.dbConfsDir')}) if not already set.`);
```
with:
```js
  console.log(`${c('bold', 'Next:')} add a connection — ${c('cyan', 'lwdb conn-add --label="Local" --host=localhost --user=root')}`);
  console.log(`  or import many at once — ${c('cyan', 'lwdb import connections.example.json')}  (see connections.example.json)`);
  console.log(`  desktop app (optional): ${c('cyan', 'npm run tauri:build')} then install the .deb`);
```

- [ ] **Step 4: Add a manifest entry to `uninstall()`**

In `uninstall()`, before the final "Preserved" log, add removal of the manifest (it's regenerated on install, and points at a possibly-removed checkout):
```js
  if (exists(LAUNCHER_MANIFEST)) {
    try { fs.rmSync(LAUNCHER_MANIFEST, { force: true }); console.log(c('green', `✓ removed ${LAUNCHER_MANIFEST}`)); }
    catch (e) { console.error(c('red', `✗ ${LAUNCHER_MANIFEST}: ${e.message}`)); }
  }
```

- [ ] **Step 5: Verify**

Run: `node install.mjs doctor; echo "---"; node --test tests/install.test.mjs`
Expected: doctor runs and prints a "desktop launcher manifest" check (no "dbconfs directory" line); the Task 1 test still passes. (doctor may report the manifest check failing if you haven't run `install` — that's fine for this step.)
Run: `npx eslint install.mjs` → clean.

- [ ] **Step 6: Commit**

```bash
git add install.mjs
git commit -m "chore(install): replace dbconfs checks with launcher-manifest; drop resolveDbConfsDir"
```

---

## Task 3: `lwdb serve` subcommand

**Files:**
- Modify: `bin/lwdb.mjs`
- Test: `tests/serve.test.mjs`

- [ ] **Step 1: Write the failing integration test**

Create `tests/serve.test.mjs`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('lwdb serve starts the HTTP server and stops on SIGTERM', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'lwdb-serve-'));
  const port = 4399;
  const child = spawn(
    process.execPath,
    ['--no-warnings=ExperimentalWarning', 'bin/lwdb.mjs', 'serve'],
    { env: { ...process.env, LW_DB_SQLITE: join(dir, 'lwdb.sqlite'), LW_DB_PORT: String(port), LW_DB_LOG_LEVEL: 'warn' }, stdio: 'ignore' },
  );
  try {
    let ok = false;
    for (let i = 0; i < 60; i++) {
      try {
        const r = await fetch(`http://127.0.0.1:${port}/api/health`);
        if (r.ok) { const j = await r.json(); ok = j.ok === true; break; }
      } catch { /* not up yet */ }
      await new Promise((res) => setTimeout(res, 100));
    }
    assert.equal(ok, true, 'server responded ok on /api/health');
  } finally {
    child.kill('SIGTERM');
    await new Promise((res) => child.on('exit', res));
    await rm(dir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test tests/serve.test.mjs`
Expected: FAIL — `lwdb serve` is an unknown command (the CLI prints `unknown command: serve` and exits non-zero, so `/api/health` never comes up).

- [ ] **Step 3: Implement the `serve` subcommand**

In `bin/lwdb.mjs`, the file currently ends with:
```js
try {
  await main();
} catch (err) {
  die(err.message);
} finally {
  await closeAll();
}
```
Replace that block with:
```js
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
```

Then add `serve` to the `help()` text — insert a SERVER block after the CONNECTIONS block:
```
SERVER (GUI backend)
  serve                             # run the HTTP API + Web UI on :4321
                                       # (this is what the desktop app launches)
```

- [ ] **Step 4: Run to verify it passes**

Run: `node --test tests/serve.test.mjs`
Expected: PASS (1 test) — server comes up on :4399, `/api/health` returns `{ok:true}`, exits on SIGTERM.

- [ ] **Step 5: Manual smoke (default port)**

Run: `node bin/lwdb.mjs serve &` then `sleep 1.5 && curl -s localhost:4321/api/health && kill %1`
Expected: `{"ok":true,...}`.
Run: `npx eslint bin/lwdb.mjs` → clean.

- [ ] **Step 6: Commit**

```bash
git add bin/lwdb.mjs tests/serve.test.mjs
git commit -m "feat(cli): lwdb serve — run the HTTP server/Web UI in the foreground"
```

---

## Task 4: Rename the desktop binary

**Files:**
- Modify: `src-tauri/tauri.conf.json`

- [ ] **Step 1: Set `mainBinaryName`**

In `src-tauri/tauri.conf.json`, add a top-level `"mainBinaryName"` key (sibling of `productName`), so the produced binary is `lwdb-desktop` (NOT `lwdb`, which would collide on PATH with the npm-linked CLI):
```json
  "productName": "lwdb",
  "mainBinaryName": "lwdb-desktop",
  "version": "0.1.0",
```

- [ ] **Step 2: Verify the config parses**

Run: `node -e "const c=require('./src-tauri/tauri.conf.json'); console.log('mainBinaryName:', c.mainBinaryName, '| productName:', c.productName)"`
Expected: `mainBinaryName: lwdb-desktop | productName: lwdb`

- [ ] **Step 3: Commit**

```bash
git add src-tauri/tauri.conf.json
git commit -m "build(tauri): name the desktop binary lwdb-desktop (avoid CLI name clash)"
```

> Note: the actual produced-binary name is verified in Task 7 after a build (`ls src-tauri/target/release/lwdb-desktop`).

---

## Task 5: Desktop runtime resolver + adopt-if-present + error page (`lib.rs`)

**Files:**
- Modify: `src-tauri/src/lib.rs` (full rewrite of the file)
- Modify: `src-tauri/Cargo.toml` (add `base64`)

- [ ] **Step 1: Add the `base64` dependency**

In `src-tauri/Cargo.toml`, under `[dependencies]`, add:
```toml
base64 = "0.22"
```
(`serde_json` and `serde` are already present.)

- [ ] **Step 2: Replace `src-tauri/src/lib.rs` entirely**

Write this exact content:

```rust
// lwdb desktop shell (Tauri v2) — "Option A: thin desktop over the installed Node core".
//
//   * Dev  (debug build): beforeDevCommand (`npm run dev`) starts vite + api;
//                         the window targets devUrl. (unchanged)
//   * Prod (release build): on launch, ensure a server is up on 127.0.0.1:4321
//                         and point the window there:
//                           - lwdb already serving  → adopt (no spawn; not killed on close)
//                           - port held by non-lwdb → inline error page
//                           - nothing there         → resolve runtime, spawn, wait, navigate
//                                                      (kill the spawned server on close)
//                           - resolution/spawn fails → inline error page
//
// Runtime resolution order: LWDB_NODE / LWDB_REPO env  →  ~/.lwdb/launcher.json
//   →  validated search of common Node locations. A candidate Node is "valid"
//   only if `node -e "require('node:sqlite')"` succeeds (so an old apt Node 12
//   at /usr/bin/node is skipped). The manifest is written by `install.mjs`.

use std::io::{Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::path::{Path, PathBuf};
use std::process::Child;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use base64::Engine;
use serde::Deserialize;
use tauri::{Manager, WindowEvent};

const SERVER_ADDR: &str = "127.0.0.1:4321";
const SERVER_URL: &str = "http://127.0.0.1:4321";

/// Holds the spawned Node server process so we can kill it on exit.
/// Holds `None` when we adopted an already-running server (we don't own it).
struct ServerProc(Mutex<Option<Child>>);

#[derive(Debug, Deserialize, Clone)]
struct LauncherManifest {
    node: String,
    #[serde(rename = "serverEntry")]
    server_entry: String,
}

struct Resolved {
    node: PathBuf,
    server_entry: PathBuf,
    cwd: PathBuf,
}

enum HealthProbe {
    NotListening,
    Listening,
    Lwdb,
}

fn home_dir() -> Option<PathBuf> {
    std::env::var("HOME").ok().map(PathBuf::from)
}

fn manifest_path() -> Option<PathBuf> {
    home_dir().map(|h| h.join(".lwdb").join("launcher.json"))
}

fn parse_manifest(text: &str) -> Option<LauncherManifest> {
    serde_json::from_str::<LauncherManifest>(text).ok()
}

fn read_manifest() -> Option<LauncherManifest> {
    let p = manifest_path()?;
    let text = std::fs::read_to_string(p).ok()?;
    parse_manifest(&text)
}

/// A node binary is usable only if it can load node:sqlite (Node >= 22.5).
/// A non-existent path makes Command::output() error → treated as invalid.
fn node_is_valid(node: &Path) -> bool {
    std::process::Command::new(node)
        .arg("-e")
        .arg("require('node:sqlite')")
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

/// Candidate node paths to try, in priority order, for the validated search.
fn candidate_nodes() -> Vec<PathBuf> {
    let mut v = Vec::new();
    if let Some(home) = home_dir() {
        let nvm = home.join(".nvm").join("versions").join("node");
        if let Ok(entries) = std::fs::read_dir(&nvm) {
            let mut versions: Vec<PathBuf> = entries.filter_map(|e| e.ok().map(|e| e.path())).collect();
            versions.sort();
            versions.reverse(); // newest (lexically highest) first
            for ver in versions {
                v.push(ver.join("bin").join("node"));
            }
        }
        v.push(home.join(".volta").join("bin").join("node"));
        v.push(home.join(".local").join("bin").join("node"));
    }
    v.push(PathBuf::from("/usr/local/bin/node"));
    v.push(PathBuf::from("/usr/bin/node"));
    v
}

/// First candidate that passes `is_valid`. Pure/testable.
fn pick_node<F: Fn(&Path) -> bool>(candidates: &[PathBuf], is_valid: F) -> Option<PathBuf> {
    candidates.iter().find(|p| is_valid(p)).cloned()
}

fn resolve_runtime() -> Result<Resolved, String> {
    let env_node = std::env::var("LWDB_NODE").ok();
    let env_repo = std::env::var("LWDB_REPO").ok();
    let manifest = read_manifest();

    let server_entry: PathBuf = if let Some(repo) = &env_repo {
        PathBuf::from(repo).join("server").join("index.mjs")
    } else if let Some(m) = &manifest {
        PathBuf::from(&m.server_entry)
    } else {
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .map(|p| p.join("server").join("index.mjs"))
            .ok_or_else(|| "cannot locate server entry".to_string())?
    };
    if !server_entry.exists() {
        return Err(format!("server entry not found: {}", server_entry.display()));
    }
    let cwd: PathBuf = server_entry
        .parent()
        .and_then(|p| p.parent())
        .map(|p| p.to_path_buf())
        .unwrap_or_else(|| PathBuf::from("."));

    let node: PathBuf = if let Some(n) = env_node {
        PathBuf::from(n)
    } else if let Some(m) = manifest.as_ref().filter(|m| Path::new(&m.node).exists()) {
        PathBuf::from(&m.node)
    } else {
        pick_node(&candidate_nodes(), node_is_valid)
            .ok_or_else(|| "no Node ≥ 22.5 found (need node:sqlite). Run: node install.mjs install".to_string())?
    };

    Ok(Resolved { node, server_entry, cwd })
}

/// Is something serving lwdb on `addr`? TCP connect + GET /api/health, look for "ok":true.
fn lwdb_health(addr: &str) -> HealthProbe {
    let sock: SocketAddr = match addr.parse() {
        Ok(s) => s,
        Err(_) => return HealthProbe::NotListening,
    };
    let mut stream = match TcpStream::connect_timeout(&sock, Duration::from_millis(400)) {
        Ok(s) => s,
        Err(_) => return HealthProbe::NotListening,
    };
    let _ = stream.set_read_timeout(Some(Duration::from_millis(800)));
    let req = "GET /api/health HTTP/1.0\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n";
    if stream.write_all(req.as_bytes()).is_err() {
        return HealthProbe::Listening;
    }
    let mut buf = String::new();
    let _ = stream.read_to_string(&mut buf);
    if buf.contains("\"ok\":true") {
        HealthProbe::Lwdb
    } else {
        HealthProbe::Listening
    }
}

/// Block until something is listening on `addr`, or `timeout` elapses.
fn wait_for_listen(addr: &str, timeout: Duration) -> bool {
    let start = Instant::now();
    while start.elapsed() < timeout {
        if TcpStream::connect(addr).is_ok() {
            return true;
        }
        std::thread::sleep(Duration::from_millis(150));
    }
    false
}

/// Navigate the window to a self-contained base64 data: URL showing a message.
fn show_error(window: &tauri::WebviewWindow, msg: &str) -> tauri::Result<()> {
    let html = format!(
        "<!doctype html><html><head><meta charset=\"utf-8\"><title>lwdb</title></head>\
         <body style=\"font-family:system-ui,sans-serif;max-width:42rem;margin:3rem auto;padding:0 1rem;color:#111\">\
         <h2 style=\"color:#b91c1c\">lwdb couldn't start</h2>\
         <p style=\"font-size:15px;line-height:1.5\">{}</p>\
         <p style=\"color:#555;font-size:13px\">Need Node ≥ 22.5. Install the core, then relaunch.</p>\
         </body></html>",
        msg
    );
    let b64 = base64::engine::general_purpose::STANDARD.encode(html.as_bytes());
    let url = format!("data:text/html;base64,{}", b64);
    window.navigate(url.parse().expect("valid data url"))?;
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(
            tauri_plugin_log::Builder::default()
                .level(log::LevelFilter::Info)
                .build(),
        )
        .setup(|app| {
            let window = app
                .get_webview_window("main")
                .expect("main window missing from tauri.conf.json");

            if !cfg!(debug_assertions) {
                match lwdb_health(SERVER_ADDR) {
                    HealthProbe::Lwdb => {
                        log::info!("adopting existing lwdb server on {SERVER_ADDR}");
                        window.navigate(SERVER_URL.parse().expect("valid server URL"))?;
                    }
                    HealthProbe::Listening => {
                        show_error(&window, "Port 4321 is already in use by another application. Free it, then relaunch lwdb.")?;
                    }
                    HealthProbe::NotListening => match resolve_runtime() {
                        Err(reason) => {
                            show_error(&window, &format!("lwdb core not found — run <code>node install.mjs install</code>. ({reason})"))?;
                        }
                        Ok(r) => {
                            log::info!("starting lwdb server: {} {}", r.node.display(), r.server_entry.display());
                            match std::process::Command::new(&r.node)
                                .arg(&r.server_entry)
                                .current_dir(&r.cwd)
                                .env("LW_DB_LOG_LEVEL", "warn")
                                .spawn()
                            {
                                Err(e) => {
                                    show_error(&window, &format!("Failed to start the lwdb server: {e}. Try: node install.mjs install"))?;
                                }
                                Ok(child) => {
                                    app.manage(ServerProc(Mutex::new(Some(child))));
                                    if wait_for_listen(SERVER_ADDR, Duration::from_secs(25)) {
                                        window.navigate(SERVER_URL.parse().expect("valid server URL"))?;
                                    } else {
                                        show_error(&window, "The lwdb server did not start in time. Ensure Node ≥ 22.5 is installed (node install.mjs install).")?;
                                    }
                                }
                            }
                        }
                    },
                }
            }

            window.show()?;
            Ok(())
        })
        .on_window_event(|window, event| {
            if matches!(event, WindowEvent::Destroyed) {
                if let Some(state) = window.app_handle().try_state::<ServerProc>() {
                    if let Ok(mut guard) = state.0.lock() {
                        if let Some(mut child) = guard.take() {
                            let _ = child.kill();
                        }
                    }
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_manifest_reads_node_and_entry() {
        let json = r#"{"version":"0.1.0","node":"/x/node","serverEntry":"/x/server/index.mjs","cli":"/x/bin/lwdb.mjs","cwd":"/x"}"#;
        let m = parse_manifest(json).expect("parses");
        assert_eq!(m.node, "/x/node");
        assert_eq!(m.server_entry, "/x/server/index.mjs");
    }

    #[test]
    fn parse_manifest_rejects_garbage() {
        assert!(parse_manifest("not json").is_none());
    }

    #[test]
    fn pick_node_returns_first_valid() {
        let cands = vec![
            PathBuf::from("/no/node"),
            PathBuf::from("/yes/node"),
            PathBuf::from("/also/node"),
        ];
        let picked = pick_node(&cands, |p| p == Path::new("/yes/node"));
        assert_eq!(picked, Some(PathBuf::from("/yes/node")));
    }

    #[test]
    fn pick_node_none_when_all_invalid() {
        let cands = vec![PathBuf::from("/a"), PathBuf::from("/b")];
        assert_eq!(pick_node(&cands, |_| false), None);
    }
}
```

- [ ] **Step 3: Run the Rust unit tests**

Run: `cargo test --manifest-path src-tauri/Cargo.toml --lib`
Expected: compiles and the 4 tests pass (`parse_manifest_*`, `pick_node_*`). (First compile is slow — Tauri deps; they're already cached from prior builds.)

- [ ] **Step 4: Confirm the release shell compiles**

Run: `cargo build --manifest-path src-tauri/Cargo.toml --release` (or defer to the full `npm run tauri:build` in Task 7).
Expected: builds without errors.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/lib.rs src-tauri/Cargo.toml src-tauri/Cargo.lock
git commit -m "feat(desktop): manifest-aware Node resolver, adopt-if-running, inline error page"
```

---

## Task 6: README — layered install guide (de-dbconfs)

**Files:**
- Modify: `README.md`

> Read `README.md` first. Make the targeted edits below, matching the file's existing tone/emoji-heading style. The goal: a layered install (core → desktop), an agent-runnable block, a desktop section reflecting the manifest/adopt behavior, troubleshooting, and zero `dbconfs`/`LW_DB_CONFS_DIR` install instructions.

- [ ] **Step 1: Fix the Quick-start (remove dbconfs)**

Find the Quick-start command block that contains the comment `# point at your existing connection configs` and the `LW_DB_CONFS_DIR` line. Replace that connection-config part with:
```bash
# 1. Install the core (CLI + server). Needs Node ≥ 22.5.
git clone <your-repo-url> lwdb && cd lwdb
node install.mjs install

# 2. Add a connection (or import many — see connections.example.json)
lwdb conn-add --label="Local" --host=localhost --user=root
# lwdb import connections.example.json

# 3. Use it
lwdb servers
lwdb query localdb information_schema "SELECT 1"
```

- [ ] **Step 2: Rewrite the Install section into a layered matrix**

Under `## 📦 Install`, structure it as:
```markdown
lwdb installs in two layers — install the core; the desktop app is optional.

### Core (CLI + server) — required
Needs **Node ≥ 22.5** (for built-in `node:sqlite`).
```bash
git clone <your-repo-url> lwdb && cd lwdb
node install.mjs install
```
This installs deps, puts the `lwdb` CLI on your PATH, installs the agent skill, and writes `~/.lwdb/launcher.json` (so the desktop app can find this Node + server). Run `lwdb doctor` anytime to check the install.

The same core gives you:
- `lwdb …` — the headless CLI (what AI agents use)
- `lwdb serve` — run the HTTP API + Web UI on http://127.0.0.1:4321

### Desktop app (optional)
See **🖥️ Desktop app** below. It depends on the core being installed.
```
(Keep the existing Update / Skill-only / Uninstall subsections.)

- [ ] **Step 3: Update the Desktop section**

Under `## 🖥️ Desktop app (optional)`, ensure the body states the dependency + behavior:
```markdown
The desktop app is a thin Tauri window over the **installed core** — it doesn't bundle Node. On launch it starts the lwdb server (using the Node recorded in `~/.lwdb/launcher.json`) and stops it when you close the window. If a server is already running (e.g. you ran `lwdb serve`), it attaches to that one and leaves it running on close.

**Prerequisites:** install the core first (`node install.mjs install`), plus the one-time Tauri toolchain:
- Rust: https://rustup.rs → `rustup default stable`
- Linux: `sudo apt install libwebkit2gtk-4.1-dev build-essential libxdo-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev`

**Build & install:**
```bash
npm run tauri:build      # produces .deb / .AppImage under src-tauri/target/release/bundle/
```
Then install the `.deb` (the binary is `lwdb-desktop`; the menu entry is "lwdb").
```
(Adapt to the existing prose — keep the toolchain lines that are already there if present; don't duplicate them.)

- [ ] **Step 4: Update the AI-agent one-paste install**

Under `## 🤖 For AI agents` → the one-paste install block, replace any dbconfs wording with a de-dbconfs block:
```bash
# Install lwdb for the user (Node ≥ 22.5 required):
git clone <your-repo-url> lwdb && cd lwdb && node install.mjs install
# Verify, then add connections:
lwdb doctor
lwdb conn-add --label="Local" --host=localhost --user=root   # or: lwdb import <file.json>
```
And ensure the contract text says connections are managed via `lwdb conn-add` / `lwdb import` (universal JSON, see `connections.example.json`) — **not** config files. Remove any "`dbconfs/*.txt`" mention from this section.

- [ ] **Step 5: Update Configuration / env vars + add Troubleshooting**

In `## 🧰 Configuration` → environment variables: remove `LW_DB_CONFS_DIR` as a primary setting (it no longer drives connections). Add the desktop overrides:
```markdown
- `LWDB_NODE` — absolute path to the Node binary the desktop app should use (overrides the launcher manifest).
- `LWDB_REPO` — repo root the desktop app should run the server from (overrides the manifest).
```

Add a Troubleshooting subsection (near the end, before License):
```markdown
## 🩺 Troubleshooting

**Desktop app shows "Could not connect to 127.0.0.1: Connection refused".**
The app couldn't find a suitable Node (≥ 22.5) to start the server. Fix:
1. Install/refresh the core with a modern Node: `node install.mjs install` (this writes `~/.lwdb/launcher.json`).
2. Confirm: `lwdb doctor` shows "desktop launcher manifest ✓".
3. Relaunch the app.
Override manually if needed: `LWDB_NODE="$(which node)" lwdb-desktop`.
```

- [ ] **Step 6: Verify no stale install instructions remain**

Run: `grep -nE "LW_DB_CONFS_DIR|dbconfs|connection configs" README.md`
Expected: no matches in install/quick-start/agent/config contexts. (A historical mention in an "Architecture/why" note is acceptable only if clearly past-tense; otherwise remove it.)

- [ ] **Step 7: Commit**

```bash
git add README.md
git commit -m "docs(readme): layered core→desktop install, agent block, troubleshooting; de-dbconfs"
```

---

## Task 7: Full verification + build + on-machine install

**Files:** none (operational)

- [ ] **Step 1: Full automated suite**

Run: `npm test && npx eslint . && npm run build`
Expected: all node:test suites pass (includes new `install` + `serve` tests), eslint clean, SPA build OK.

- [ ] **Step 2: Rust tests**

Run: `cargo test --manifest-path src-tauri/Cargo.toml --lib`
Expected: 4 unit tests pass.

- [ ] **Step 3: Write the manifest on this machine + verify doctor**

Run: `node install.mjs install`
Then: `node install.mjs doctor`
Expected: install writes `~/.lwdb/launcher.json`; doctor shows "desktop launcher manifest ✓" with `node ✓, serverEntry ✓` (and no dbconfs line). Confirm the manifest's `node` is the nvm Node 24:
Run: `node -e "const m=require(require('os').homedir()+'/.lwdb/launcher.json'); console.log(m.node)"`
Expected: `/home/sibin/.nvm/versions/node/v24.14.0/bin/node` (not `/usr/bin/node`).

- [ ] **Step 4: Build the desktop app + confirm binary name**

Run: `npm run tauri:build`
Then: `ls src-tauri/target/release/lwdb-desktop && ls src-tauri/target/release/bundle/deb/*.deb`
Expected: a `lwdb-desktop` binary exists (not `app`); a `.deb` is produced.

- [ ] **Step 5: Remove the old package + install the new .deb (manual)**

Run: `sudo dpkg -r lwdb 2>/dev/null; sudo apt-get remove -y lwdb 2>/dev/null; ls -la /usr/bin/app 2>/dev/null || echo "old app binary gone"`
Then install the freshly built `.deb`: `sudo dpkg -i src-tauri/target/release/bundle/deb/*.deb`
Expected: old `lwdb` package/`/usr/bin/app` removed; new package installs `/usr/bin/lwdb-desktop` + `/usr/share/applications/lwdb.desktop`.

- [ ] **Step 6: MANUAL desktop verification (you run these; I can't drive a GUI launch)**

1. **Cold launch:** From the application menu, click **lwdb**. Expected: the window loads the UI (server auto-started via the manifest's Node 24) — no "Connection refused". Confirm a server is running: `pgrep -f 'server/index.mjs'` returns a PID. Close the window → `pgrep -f 'server/index.mjs'` returns nothing (spawned server killed).
2. **Adopt path:** `lwdb serve &` (wait for `:4321`), then launch the app from the menu. Expected: window attaches, no second server. Close the window → `pgrep -f 'server/index.mjs'` still shows the `lwdb serve` PID (adopted, not killed). Then `kill %1`.
3. **Error page:** `mv ~/.lwdb/launcher.json ~/.lwdb/launcher.json.bak`, temporarily ensure no valid Node on the GUI PATH is found is hard to force — instead test the message path by launching with a bad override: `LWDB_NODE=/usr/bin/node /usr/bin/lwdb-desktop` (Node 12 → no node:sqlite → server crashes → "did not start in time" error page, not a raw connection error). Restore: `mv ~/.lwdb/launcher.json.bak ~/.lwdb/launcher.json`.

- [ ] **Step 7: Final commit (only if asked)**

Per the user's commit-only-when-asked rule: surface the diff/results and ask before any further commit. The per-task commits above already capture all code changes.

---

## Self-Review Notes

- **Spec coverage:** manifest write (T1) · de-dbconfs installer (T2) · `lwdb serve` (T3) · binary rename (T4) · resolver + adopt-if-present + error page + Rust tests (T5) · README layered install + agent block + troubleshooting (T6) · build/manifest/manual desktop verification incl. adopt + error-page (T7). All spec sections map to a task.
- **`mainBinaryName`** is `lwdb-desktop` consistently (T4 config, T6 docs, T7 verification) — never `lwdb` (the CLI).
- **Manifest field names** consistent: `node` / `serverEntry` / `cli` / `cwd` / `version` / `writtenAt` in `writeLauncherManifest` (T1), read as `node`/`serverEntry` (with `#[serde(rename)]`) in `lib.rs` (T5), checked by `doctor` (T2).
- **Adopt-if-present** (T5): `ServerProc` holds `Some(child)` only when spawned, `None` when adopted → close kills only a spawned server. Matches the spec's ownership rule.
- **No placeholders:** every code step shows full code; README steps give exact replacement blocks + a grep gate. `<your-repo-url>` is an intentional user-supplied value, not a TODO.
- **Testing honesty:** the GUI launch (T7 Step 6) is explicitly manual; everything else (manifest, serve, resolver/pick_node/parse, build, binary name) is automated.
