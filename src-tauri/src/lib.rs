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

            // Open maximized (the config `maximized: true` may not apply while
            // the window starts hidden, so enforce it before showing).
            let _ = window.maximize();
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
