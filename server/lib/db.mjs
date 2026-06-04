import { DatabaseSync } from 'node:sqlite';
import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { existsSync } from 'node:fs';

const MIGRATIONS = [
  // v1
  `CREATE TABLE IF NOT EXISTS snippets (
     id TEXT PRIMARY KEY,
     name TEXT NOT NULL,
     description TEXT NOT NULL DEFAULT '',
     sql TEXT NOT NULL,
     tags_json TEXT NOT NULL DEFAULT '[]',
     default_server TEXT,
     default_db TEXT,
     created_at TEXT NOT NULL,
     updated_at TEXT NOT NULL
   );
   CREATE INDEX IF NOT EXISTS idx_snippets_name ON snippets(name);

   CREATE TABLE IF NOT EXISTS query_history (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     server TEXT NOT NULL,
     db TEXT,
     sql TEXT NOT NULL,
     args_json TEXT NOT NULL DEFAULT '[]',
     started_at TEXT NOT NULL,
     elapsed_ms INTEGER,
     row_count INTEGER,
     verb TEXT,
     ok INTEGER NOT NULL DEFAULT 1,
     error TEXT,
     snippet_id TEXT
   );
   CREATE INDEX IF NOT EXISTS idx_history_started ON query_history(started_at DESC);
   CREATE INDEX IF NOT EXISTS idx_history_server_db ON query_history(server, db);

   CREATE TABLE IF NOT EXISTS preferences (
     key TEXT PRIMARY KEY,
     value_json TEXT NOT NULL
   );

   CREATE TABLE IF NOT EXISTS schema_version (
     version INTEGER PRIMARY KEY
   );`,

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
];

export async function openDb(dbPath) {
  if (!existsSync(dirname(dbPath))) await mkdir(dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');

  db.exec('CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY);');
  const current = db.prepare('SELECT MAX(version) AS v FROM schema_version').get();
  const currentVersion = current?.v || 0;

  for (let i = currentVersion; i < MIGRATIONS.length; i++) {
    db.exec(MIGRATIONS[i]);
    db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(i + 1);
  }

  return db;
}

/**
 * Run a sync function inside a transaction. node:sqlite has no transaction
 * helper, so we wrap BEGIN/COMMIT/ROLLBACK manually. Mirrors the better-sqlite3
 * API enough to be a drop-in for this codebase.
 */
export function withTx(db, fn) {
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch (_) { /* ignore */ }
    throw err;
  }
}
