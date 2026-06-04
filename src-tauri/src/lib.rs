// lwdb desktop shell (Tauri v2).
//
// Architecture — "Option A: Tauri + Node sidecar":
//   * Dev  (debug build): `beforeDevCommand` runs `npm run dev` (vite + api).
//                         The window loads the vite dev URL; HMR works.
//   * Prod (release build): on launch we spawn the existing Node server
//                         (`node <repo>/server/index.mjs`), wait for it to
//                         listen on 127.0.0.1:4321, then point the window
//                         there. The server is killed when the window closes.
//
// The server runs from the repo location (baked at build time, overridable
// via LWDB_REPO) so all of its filesystem assumptions — locating dist/,
// package.json, data/, the default dbconfs dir — keep working unchanged.
// The `lwdb` CLI is independent of all this and stays fully headless.

use std::net::TcpStream;
use std::path::PathBuf;
use std::process::Child;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use tauri::{Manager, WindowEvent};

const SERVER_ADDR: &str = "127.0.0.1:4321";
const SERVER_URL: &str = "http://127.0.0.1:4321";

/// Holds the spawned Node server process so we can kill it on exit.
struct ServerProc(Mutex<Option<Child>>);

/// Repo root: LWDB_REPO env override, else the directory above this crate
/// (baked in at compile time — `…/lwdb/src-tauri` → `…/lwdb`).
fn repo_root() -> PathBuf {
    if let Ok(p) = std::env::var("LWDB_REPO") {
        return PathBuf::from(p);
    }
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .map(|p| p.to_path_buf())
        .unwrap_or_else(|| PathBuf::from("."))
}

/// Node binary: LWDB_NODE env override, else `node` on PATH.
fn node_bin() -> String {
    std::env::var("LWDB_NODE").unwrap_or_else(|_| "node".to_string())
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

            // Release owns the server lifecycle; in dev the beforeDevCommand
            // (`npm run dev`) already started vite + the API, and the window
            // targets the dev URL via tauri.conf.json#build.devUrl.
            if !cfg!(debug_assertions) {
                let repo = repo_root();
                let server_js = repo.join("server").join("index.mjs");
                log::info!("starting lwdb server: {} {}", node_bin(), server_js.display());

                let child = std::process::Command::new(node_bin())
                    .arg(&server_js)
                    .current_dir(&repo)
                    .env("LW_DB_LOG_LEVEL", "warn")
                    .spawn()
                    .unwrap_or_else(|e| {
                        panic!(
                            "lwdb: failed to start the server with `{}`. Is Node on PATH? \
                             Set LWDB_NODE to the node binary (and LWDB_REPO to the repo path \
                             if it moved). cause: {e}",
                            node_bin()
                        )
                    });
                app.manage(ServerProc(Mutex::new(Some(child))));

                if !wait_for_listen(SERVER_ADDR, Duration::from_secs(25)) {
                    log::error!("lwdb server did not start listening on {SERVER_ADDR}");
                }
                window.navigate(SERVER_URL.parse().expect("valid server URL"))?;
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
