/**
 * Execute one SQL statement with the read-only guard, an implicit LIMIT for
 * unbounded SELECT, optional history logging, and consistent result shape.
 */
import { getPool, poolQuery } from './pool.mjs';
import { assertReadOnly, inspectSql } from './sqlGuard.mjs';
import { appError, Codes } from './errors.mjs';
import { isTransientError } from './connectionHealth.mjs';

function applyImplicitLimit(sql, limit) {
  if (/\blimit\b/i.test(sql)) return sql;
  return `${sql.replace(/;?\s*$/, '')} LIMIT ${limit}`;
}

export async function runQuery({
  connection,
  db = null,
  sql,
  args = [],
  writable = false,
  limit,
  history = null,
  snippetId = null,
  config,
}) {
  const defaultLimit = config?.defaultSelectLimit ?? 500;
  const hardLimit = config?.hardSelectLimit ?? 5_000;

  if (typeof sql !== 'string' || !sql.trim()) {
    throw appError(Codes.EMPTY_SQL, 'sql is required');
  }
  if (!writable) assertReadOnly(sql);

  const { stmts, verbs } = inspectSql(sql);
  if (!stmts.length) throw appError(Codes.EMPTY_SQL, 'No statement to run');
  if (stmts.length > 1) throw appError(Codes.MULTI_STMT, 'Run one statement at a time');

  const effectiveLimit = Math.min(Math.max(parseInt(limit, 10) || defaultLimit, 1), hardLimit);
  const verb = verbs[0];
  const originalStmt = stmts[0];
  const finalSql = (verb === 'SELECT' || verb === 'WITH')
    ? applyImplicitLimit(originalStmt, effectiveLimit)
    : originalStmt;

  const pool = getPool(connection, db);
  const started = Date.now();
  let rows, fields, dbError;
  let attempts = 0;
  for (;;) {
    attempts++;
    try {
      [rows, fields] = await poolQuery(pool, finalSql, args);
      dbError = null;
      break;
    } catch (err) {
      const normalized = err.code ? err : appError(Codes.DB_ERROR, err.message || String(err), { cause: err });
      // One automatic retry on transient connection errors (read-only queries only).
      // Writes are not retried automatically to avoid duplicate side-effects.
      if (attempts === 1 && !writable && isTransientError(normalized)) continue;
      dbError = normalized;
      break;
    }
  }
  const elapsedMs = Date.now() - started;

  if (history) {
    try {
      history.record({
        server: connection.id,
        db: db || null,
        sql: finalSql,
        args,
        elapsedMs,
        rowCount: Array.isArray(rows) ? rows.length : (rows?.affectedRows ?? null),
        verb,
        ok: !dbError,
        error: dbError ? dbError.message : null,
        snippetId,
      });
    } catch (_) { /* history is best-effort */ }
  }

  if (dbError) throw dbError;

  const isResultSet = Array.isArray(rows);
  return {
    sql: finalSql,
    verb,
    writable,
    elapsedMs,
    rowCount: isResultSet ? rows.length : (rows?.affectedRows ?? 0),
    fields: isResultSet && fields ? fields.map((f) => ({ name: f.name, type: f.type })) : [],
    rows: isResultSet ? rows : [],
    meta: isResultSet ? null : rows,
    limited: isResultSet && /\bLIMIT\b/i.test(finalSql) && !/\blimit\b/i.test(originalStmt),
    appliedLimit: effectiveLimit,
  };
}
