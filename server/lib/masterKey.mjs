/**
 * Resolve the 32-byte master key that encrypts credentials at rest.
 *
 * Resolution order:
 *   1. LW_DB_KEY        — inline base64 of 32 bytes (CI / headless, no file)
 *   2. LW_DB_KEY_FILE   — explicit key file path
 *   3. ~/.lwdb/key      — default; generated 0600 on first use
 *
 * The key lives OUTSIDE the data dir (where lwdb.sqlite is) on purpose: stealing
 * the SQLite file alone yields only AES-256-GCM ciphertext. We deliberately do
 * NOT touch the OS keychain on every CLI invocation — that would trigger a
 * per-command unlock prompt and wreck the agent/CLI UX. Keychain storage of this
 * one key is an optional, desktop-side enhancement (Rust/Tauri), not the default.
 */
import { randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, mkdirSync, chmodSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export function keyFilePath() {
  return process.env.LW_DB_KEY_FILE || join(homedir(), '.lwdb', 'key');
}

function decodeKey(b64, where) {
  const buf = Buffer.from(String(b64).trim(), 'base64');
  if (buf.length !== 32) {
    throw Object.assign(new Error(`${where} must be base64 of exactly 32 bytes (got ${buf.length})`), { code: 'INVALID_CONFIG' });
  }
  return buf;
}

export function loadMasterKey() {
  if (process.env.LW_DB_KEY) {
    return { key: decodeKey(process.env.LW_DB_KEY, 'LW_DB_KEY'), source: 'env' };
  }
  const path = keyFilePath();
  if (existsSync(path)) {
    return { key: decodeKey(readFileSync(path, 'utf8'), `key file ${path}`), source: 'file', path };
  }
  const key = randomBytes(32);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, key.toString('base64') + '\n', { mode: 0o600 });
  try { chmodSync(path, 0o600); } catch { /* best effort (e.g. Windows) */ }
  return { key, source: 'file', path, created: true };
}
