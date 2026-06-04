import { copyFile, readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

export const BACKUP_VERSION = 2;

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

export function defaultBackupPath(dataDir, kind = 'sqlite') {
  const ext = kind === 'json' ? 'json' : 'sqlite';
  return join(dataDir, 'backups', `lwdb-backup-${timestamp()}.${ext}`);
}

export async function backupSqlite(registry, outPath) {
  await mkdir(dirname(outPath), { recursive: true });
  registry.db.exec(`VACUUM INTO '${outPath.replace(/'/g, "''")}'`);
  const s = await stat(outPath);
  return { path: outPath, bytes: s.size, kind: 'sqlite', createdAt: new Date().toISOString() };
}

export async function backupJson(registry, outPath) {
  await mkdir(dirname(outPath), { recursive: true });
  const payload = {
    tool: 'lwdb',
    version: BACKUP_VERSION,
    createdAt: new Date().toISOString(),
    snippets: registry.snippets.exportAll(),
    preferences: registry.preferences.all(),
    history: registry.history.exportAll(),
  };
  await writeFile(outPath, JSON.stringify(payload, null, 2));
  const s = await stat(outPath);
  return { path: outPath, bytes: s.size, kind: 'json', createdAt: payload.createdAt };
}

export async function restoreJson(registry, payload, { merge = false } = {}) {
  if (!payload || payload.tool !== 'lwdb') {
    throw Object.assign(new Error('Not a lwdb backup payload'), { code: 'BAD_BACKUP' });
  }
  const restored = [];
  if (Array.isArray(payload.snippets)) {
    registry.snippets.importAll(payload.snippets, { merge });
    restored.push(`snippets(${payload.snippets.length})`);
  }
  if (payload.preferences && typeof payload.preferences === 'object') {
    if (!merge) registry.preferences.importAll(payload.preferences);
    else {
      for (const [k, v] of Object.entries(payload.preferences)) registry.preferences.set(k, v);
    }
    restored.push(`preferences(${Object.keys(payload.preferences).length})`);
  }
  return { restored, merged: merge };
}

export async function restoreSqliteFile(registry, srcPath) {
  // Replace the live sqlite file. Requires reopening — caller must restart process.
  const dst = registry.dbPath;
  if (!existsSync(srcPath)) throw new Error(`Backup file not found: ${srcPath}`);
  // Create a side-by-side .prev so we don't lose the old one.
  if (existsSync(dst)) await copyFile(dst, dst + '.prev');
  registry.db.close();
  await copyFile(srcPath, dst);
  return { restored: dst, from: srcPath, restartRequired: true };
}

export async function loadJsonBackup(path) {
  const text = await readFile(path, 'utf8');
  return JSON.parse(text);
}

export function looksLikeSqlite(path) {
  const ext = (path.split('.').pop() || '').toLowerCase();
  return ext === 'sqlite' || ext === 'db';
}
