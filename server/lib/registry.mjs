/**
 * Application registry. Resolves config, loads connection definitions, opens
 * SQLite, and exposes the data stores. A single instance per process.
 */
import { ConnectionStore } from './connectionStore.mjs';
import { openDb } from './db.mjs';
import { loadMasterKey } from './masterKey.mjs';
import { makeCodec } from './secret.mjs';
import { SnippetStore } from './snippets.mjs';
import { HistoryStore } from './history.mjs';
import { PreferenceStore } from './preferences.mjs';
import { AnnotationStore } from './annotations.mjs';
import { ApprovalQueue } from './approvals.mjs';
import { loadConfig } from './config.mjs';
import { configurePool, setHealthTracker } from './pool.mjs';
import { ConnectionHealth } from './connectionHealth.mjs';
import { setLogLevel, child } from './log.mjs';
import { appError, Codes } from './errors.mjs';

export async function buildRegistry() {
  const config = await loadConfig();
  setLogLevel(config.logLevel);
  const log = child('registry');

  configurePool({
    poolMaxPerKey: config.poolMaxPerKey,
    poolMaxKeys: config.poolMaxKeys,
    poolIdleTimeoutMs: config.poolIdleTimeoutMs,
    queryTimeoutMs: config.queryTimeoutMs,
    connectTimeoutMs: config.connectTimeoutMs,
  });

  const connectionHealth = new ConnectionHealth({
    baseTimeoutMs: config.connectTimeoutMs,
    minTimeoutMs: 1500,
    maxTimeoutMs: Math.max(config.connectTimeoutMs * 3, 12_000),
  });
  setHealthTracker(connectionHealth);

  const db = await openDb(config.sqlitePath);
  log.info('sqlite opened', { path: config.sqlitePath });

  const { key, source: keySource, path: keyPath } = loadMasterKey();
  const connectionStore = new ConnectionStore(db, { secret: makeCodec(key) });
  log.info('connections', { count: connectionStore.all().length, keySource });

  const snippets = new SnippetStore(db);
  const history = new HistoryStore(db, { max: config.historyMax });
  const preferences = new PreferenceStore(db);
  const annotations = new AnnotationStore(db);
  const approvals = new ApprovalQueue();

  function getConnection(id) {
    const c = connectionStore.get(id);
    if (!c) throw appError(Codes.UNKNOWN_SERVER, `Unknown server: ${id}`);
    return c;
  }

  return {
    config,
    dbConfsDir: config.dbConfsDir,
    dataDir: config.dataDir,
    dbPath: config.sqlitePath,
    port: config.port,
    host: config.host,
    projectRoot: config.projectRoot,
    connectionStore,
    keySource,
    keyPath: keyPath || null,
    listConnections: () => connectionStore.all(),
    snippets,
    history,
    preferences,
    annotations,
    approvals,
    connectionHealth,
    db,
    getConnection,
  };
}
