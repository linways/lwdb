/**
 * MySQL connection pool manager.
 *
 * One pool per (server, db) tuple. An LRU cap bounds total pool count;
 * idle pools are evicted after configured TTL. All queries enforce a
 * per-statement timeout to avoid hanging on slow remote DBs.
 */
import mysql from 'mysql2/promise';
import { appError, Codes } from './errors.mjs';
import { child } from './log.mjs';

const log = child('pool');

const pools = new Map(); // key -> { pool, lastUsed, key, firstConnectMs }

function key(serverId, db) {
  return `${serverId}::${db || ''}`;
}

let activeConfig = {
  poolMaxPerKey: 5,
  poolMaxKeys: 32,
  poolIdleTimeoutMs: 10 * 60_000,
  queryTimeoutMs: 30_000,
  connectTimeoutMs: 4_000,
};

let healthTracker = null;
export function setHealthTracker(h) { healthTracker = h; }

let sweepTimer = null;
function startSweeper() {
  if (sweepTimer) return;
  sweepTimer = setInterval(sweepIdle, 60_000);
  sweepTimer.unref?.();
}

export function configurePool(cfg) {
  activeConfig = { ...activeConfig, ...cfg };
  startSweeper();
}

function evictLruIfNeeded() {
  if (pools.size <= activeConfig.poolMaxKeys) return;
  let oldestKey = null;
  let oldest = Infinity;
  for (const [k, v] of pools) {
    if (v.lastUsed < oldest) { oldest = v.lastUsed; oldestKey = k; }
  }
  if (oldestKey) {
    log.info('evicting LRU pool', { key: oldestKey });
    closeKey(oldestKey).catch((err) => log.warn('eviction error', { err: err.message }));
  }
}

function sweepIdle() {
  const now = Date.now();
  for (const [k, v] of pools) {
    if (now - v.lastUsed > activeConfig.poolIdleTimeoutMs) {
      log.info('closing idle pool', { key: k, idleMs: now - v.lastUsed });
      closeKey(k).catch((err) => log.warn('idle close error', { err: err.message }));
    }
  }
}

async function closeKey(k) {
  const entry = pools.get(k);
  if (!entry) return;
  pools.delete(k);
  try { await entry.pool.end(); } catch (_) { /* ignore */ }
}

export function getPool(connection, db) {
  const k = key(connection.id, db);
  const existing = pools.get(k);
  if (existing) {
    existing.lastUsed = Date.now();
    return existing.pool;
  }

  // Connect timeout adapts to the server's recent history (if any) so SSH-tunneled
  // hosts that respond in ~200ms fail fast and direct WAN hosts get more slack.
  const connectTimeout = healthTracker
    ? healthTracker.timeoutFor(connection.id)
    : activeConfig.connectTimeoutMs;

  const pool = mysql.createPool({
    host: connection.host,
    port: connection.port,
    user: connection.user,
    password: connection.password,
    database: db || undefined,
    waitForConnections: true,
    connectionLimit: activeConfig.poolMaxPerKey,
    queueLimit: 0,
    multipleStatements: false,
    dateStrings: true,
    decimalNumbers: true,
    connectTimeout,
  });

  pools.set(k, { pool, lastUsed: Date.now(), key: k });
  evictLruIfNeeded();
  return pool;
}

/**
 * Run a query with a hard timeout. Returns mysql2's [rows, fields].
 * Uses Promise.race against a timer; query may continue server-side
 * if it hangs, but the client unblocks. mysql2 pool will recycle the
 * connection on next use.
 */
export async function poolQuery(pool, sql, args = [], { timeoutMs } = {}) {
  const effective = timeoutMs ?? activeConfig.queryTimeoutMs;
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      reject(appError(Codes.TIMEOUT, `Query timed out after ${effective}ms`));
    }, effective);
    timer.unref?.();
  });
  try {
    return await Promise.race([pool.query(sql, args), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

export async function closeAll() {
  for (const { pool } of pools.values()) {
    try { await pool.end(); } catch (_) { /* ignore */ }
  }
  pools.clear();
  if (sweepTimer) { clearInterval(sweepTimer); sweepTimer = null; }
}

function decorateConnectError(err, connection) {
  const isLocalTunnel = connection.host === '127.0.0.1' && connection.port !== 3306;
  const msg = err.message || String(err);
  if (err.code === 'ECONNREFUSED' || /ECONNREFUSED|ETIMEDOUT|ENETUNREACH|EHOSTUNREACH/.test(msg)) {
    const hint = isLocalTunnel
      ? ` — looks like an SSH tunnel port; check 'ssh-tunnels.sh' or your tunnel for ${connection.host}:${connection.port}.`
      : '';
    return appError(Codes.DB_ERROR, `Cannot reach ${connection.id} (${connection.host}:${connection.port})${hint}`, { cause: err });
  }
  return err;
}

export async function listDatabases(connection) {
  const pool = getPool(connection, null);
  const started = Date.now();
  try {
    const timeoutMs = healthTracker?.timeoutFor(connection.id);
    const [rows] = await poolQuery(pool, 'SHOW DATABASES', [], { timeoutMs });
    healthTracker?.recordSuccess(connection.id, Date.now() - started);
    const skip = new Set(['information_schema', 'performance_schema', 'mysql', 'sys']);
    return rows.map((r) => r.Database || r.database).filter((d) => !skip.has(d));
  } catch (err) {
    healthTracker?.recordFailure(connection.id, err);
    // Drop the pool so the next attempt actually reconnects with a fresh timeout.
    await closeKey(key(connection.id, null));
    throw decorateConnectError(err, connection);
  }
}

export async function listTables(connection, db) {
  if (!db) throw appError(Codes.BAD_REQUEST, 'db is required');
  const pool = getPool(connection, db);
  const started = Date.now();
  try {
    const timeoutMs = healthTracker?.timeoutFor(connection.id);
    const [rows] = await poolQuery(
      pool,
      `SELECT TABLE_NAME as name, TABLE_ROWS as rowsApprox, TABLE_TYPE as type
       FROM information_schema.tables
       WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME`,
      [db],
      { timeoutMs },
    );
    healthTracker?.recordSuccess(connection.id, Date.now() - started);
    return rows;
  } catch (err) {
    healthTracker?.recordFailure(connection.id, err);
    await closeKey(key(connection.id, db));
    throw decorateConnectError(err, connection);
  }
}

/**
 * Bulk-fetch the table→columns map for one database. One round-trip; used to
 * feed CodeMirror's SQL completion. Returns a flat map suitable for sql({schema}).
 */
export async function fetchSchema(connection, db) {
  if (!db) throw appError(Codes.BAD_REQUEST, 'db is required');
  const pool = getPool(connection, db);
  const started = Date.now();
  try {
    const timeoutMs = healthTracker?.timeoutFor(connection.id);
    const [rows] = await poolQuery(
      pool,
      `SELECT TABLE_NAME as tbl, COLUMN_NAME as col, COLUMN_KEY as keyKind
       FROM information_schema.columns
       WHERE TABLE_SCHEMA = ?
       ORDER BY TABLE_NAME, ORDINAL_POSITION`,
      [db],
      { timeoutMs },
    );
    healthTracker?.recordSuccess(connection.id, Date.now() - started);
    const tables = {};
    const primaryKeys = {};
    let columnCount = 0;
    for (const r of rows) {
      const t = r.tbl;
      if (!tables[t]) tables[t] = [];
      tables[t].push(r.col);
      if (r.keyKind === 'PRI') {
        if (!primaryKeys[t]) primaryKeys[t] = [];
        primaryKeys[t].push(r.col);
      }
      columnCount++;
    }
    return { tables, primaryKeys, columnCount, fetchedAt: new Date().toISOString() };
  } catch (err) {
    healthTracker?.recordFailure(connection.id, err);
    await closeKey(key(connection.id, db));
    throw decorateConnectError(err, connection);
  }
}

export async function describeTable(connection, db, table) {
  if (!db || !table) throw appError(Codes.BAD_REQUEST, 'db and table required');
  const pool = getPool(connection, db);
  const [cols] = await poolQuery(
    pool,
    `SELECT COLUMN_NAME as name, COLUMN_TYPE as type, IS_NULLABLE as nullable,
            COLUMN_KEY as keyKind, COLUMN_DEFAULT as defaultValue, EXTRA as extra
     FROM information_schema.columns
     WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
     ORDER BY ORDINAL_POSITION`,
    [db, table],
  );
  const [idx] = await poolQuery(pool, `SHOW INDEX FROM \`${db}\`.\`${table}\``);
  return { columns: cols, indexes: idx };
}

export function poolStats() {
  return {
    activePools: pools.size,
    keys: [...pools.keys()],
    config: { ...activeConfig },
    health: healthTracker?.snapshot() || null,
  };
}

/**
 * One-off connectivity probe for the "Test connection" action. Opens a single
 * connection (NOT pooled, so an unsaved/ad-hoc connection leaves nothing
 * behind), pings, and closes. Returns latency in ms or throws.
 */
export async function pingConnection(connection, { timeoutMs } = {}) {
  const start = Date.now();
  const conn = await mysql.createConnection({
    host: connection.host,
    port: Number(connection.port) || 3306,
    user: connection.user,
    password: connection.password || '',
    connectTimeout: timeoutMs || activeConfig.connectTimeoutMs,
  });
  try {
    await conn.ping();
    return { ok: true, ms: Date.now() - start };
  } finally {
    try { await conn.end(); } catch (_) { /* ignore */ }
  }
}
