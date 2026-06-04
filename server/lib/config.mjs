/**
 * Centralized runtime configuration.
 * Resolution order: env > package.json#lwDb > built-in defaults.
 *
 * All settings are read once at startup. Restart to apply changes.
 */
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const PROJECT_ROOT = resolve(__dirname, '..', '..');

const DEFAULTS = {
  host: '127.0.0.1',
  port: 4321,
  dbConfsDir: null,
  dataDir: join(PROJECT_ROOT, 'data'),
  sqlitePath: null, // derived
  queryTimeoutMs: 30_000,
  connectTimeoutMs: 4_000,
  poolMaxPerKey: 5,
  poolIdleTimeoutMs: 10 * 60_000,
  poolMaxKeys: 32, // cap total pools to bound memory
  defaultSelectLimit: 500,
  hardSelectLimit: 5_000,
  historyMax: 10_000,
  bodyLimitBytes: 50 * 1024 * 1024,
  logLevel: 'info',
};

function pickEnv(key, transform = (x) => x) {
  const v = process.env[key];
  return v === undefined ? undefined : transform(v);
}

let cached = null;

export async function loadConfig() {
  if (cached) return cached;

  let pkg = {};
  try {
    const raw = await readFile(join(PROJECT_ROOT, 'package.json'), 'utf8');
    pkg = JSON.parse(raw).lwDb || {};
  } catch (_) { /* defaults only */ }

  const cfg = {
    ...DEFAULTS,
    ...pkg,
    host: pickEnv('LW_DB_HOST') || pkg.host || DEFAULTS.host,
    port: pickEnv('LW_DB_PORT', (v) => parseInt(v, 10)) || pkg.port || DEFAULTS.port,
    dbConfsDir: pickEnv('LW_DB_CONFS_DIR') || pkg.dbConfsDir || DEFAULTS.dbConfsDir,
    dataDir: pickEnv('LW_DB_DATA_DIR') || pkg.dataDir || DEFAULTS.dataDir,
    sqlitePath: pickEnv('LW_DB_SQLITE') || pkg.sqlitePath,
    queryTimeoutMs: pickEnv('LW_DB_QUERY_TIMEOUT_MS', Number) || DEFAULTS.queryTimeoutMs,
    logLevel: pickEnv('LW_DB_LOG_LEVEL') || pkg.logLevel || DEFAULTS.logLevel,
    projectRoot: PROJECT_ROOT,
  };
  cfg.sqlitePath = cfg.sqlitePath || join(cfg.dataDir, 'lwdb.sqlite');

  Object.freeze(cfg);
  cached = cfg;
  return cfg;
}

export function resetConfigForTests() {
  cached = null;
}
