/**
 * Column profiling: per-column nulls / distinct / min / max / top values so an
 * agent writes a correct WHERE clause on the first try instead of running
 * exploratory queries.
 *
 * Cost model: by default stats run over a bounded sample (`LIMIT sampleSize`
 * subquery, default 10k rows) so profiling stays fast on huge tables; pass
 * exact=true for a full scan. Numbers from a sample are approximations.
 */
import { quoteIdent } from './ident.mjs';
import { getPool, poolQuery } from './pool.mjs';
import { appError, Codes } from './errors.mjs';

export const DEFAULT_SAMPLE_SIZE = 10_000;
export const TOP_VALUES_MAX_DISTINCT = 50;
const MAX_TOP_COLUMNS = 12; // cap follow-up top-value queries per profile call
const AGG_CHUNK = 20; // columns per aggregate query

export function buildSampleSql(db, table, limit) {
  const n = Math.min(Math.max(parseInt(limit, 10) || 5, 1), 100);
  return `SELECT * FROM ${quoteIdent(db)}.${quoteIdent(table)} LIMIT ${n}`;
}

function sourceSql(columns, { db, table, sampleSize, exact }) {
  const target = `${quoteIdent(db)}.${quoteIdent(table)}`;
  if (exact) return target;
  const cols = columns.map(quoteIdent).join(', ');
  return `(SELECT ${cols} FROM ${target} LIMIT ${sampleSize || DEFAULT_SAMPLE_SIZE}) s`;
}

export function buildAggregateSql(columns, { db, table, sampleSize, exact = false }) {
  const aggs = columns.flatMap((c, i) => {
    const q = quoteIdent(c);
    return [
      `SUM(${q} IS NULL) AS n${i}`,
      `COUNT(DISTINCT ${q}) AS d${i}`,
      `MIN(${q}) AS mn${i}`,
      `MAX(${q}) AS mx${i}`,
    ];
  });
  return `SELECT COUNT(*) AS _n, ${aggs.join(', ')} FROM ${sourceSql(columns, { db, table, sampleSize, exact })}`;
}

export function parseAggregateRow(row, columns) {
  const rowsScanned = Number(row._n) || 0;
  const out = {};
  columns.forEach((c, i) => {
    const nulls = Number(row[`n${i}`]) || 0;
    out[c] = {
      nulls,
      nullPct: rowsScanned ? Math.round((nulls / rowsScanned) * 1000) / 10 : 0,
      distinct: Number(row[`d${i}`]) || 0,
      min: row[`mn${i}`] ?? null,
      max: row[`mx${i}`] ?? null,
    };
  });
  return { rowsScanned, columns: out };
}

export function buildTopValuesSql(column, { db, table, sampleSize, exact = false, top = 5 }) {
  const q = quoteIdent(column);
  return `SELECT ${q} AS v, COUNT(*) AS n FROM ${sourceSql([column], { db, table, sampleSize, exact })} `
    + `GROUP BY ${q} ORDER BY n DESC LIMIT ${Math.min(Math.max(parseInt(top, 10) || 5, 1), 50)}`;
}

export function shouldFetchTop(distinct, threshold = TOP_VALUES_MAX_DISTINCT) {
  return distinct > 0 && distinct <= threshold;
}

/** Orchestrate a full profile for one table. */
export async function profileTable(connection, db, table, {
  columns = null, top = 5, sampleSize = DEFAULT_SAMPLE_SIZE, exact = false,
} = {}) {
  const pool = await getPool(connection, db);

  const [colRows] = await poolQuery(pool, `
    SELECT COLUMN_NAME AS name, COLUMN_TYPE AS type
    FROM information_schema.columns
    WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION`, [db, table]);
  if (!colRows.length) throw appError(Codes.NOT_FOUND, `Table not found: ${db}.${table}`);

  const wanted = columns?.length ? colRows.filter((c) => columns.includes(c.name)) : colRows;
  if (!wanted.length) throw appError(Codes.BAD_REQUEST, 'None of the requested columns exist');
  const names = wanted.map((c) => c.name);
  const typeOf = Object.fromEntries(wanted.map((c) => [c.name, c.type]));

  let rowsScanned = 0;
  const stats = {};
  for (let i = 0; i < names.length; i += AGG_CHUNK) {
    const chunk = names.slice(i, i + AGG_CHUNK);
    const [rows] = await poolQuery(pool, buildAggregateSql(chunk, { db, table, sampleSize, exact }));
    const parsed = parseAggregateRow(rows[0], chunk);
    rowsScanned = parsed.rowsScanned;
    Object.assign(stats, parsed.columns);
  }

  const topTargets = names.filter((n) => shouldFetchTop(stats[n].distinct)).slice(0, MAX_TOP_COLUMNS);
  for (const name of topTargets) {
    const [rows] = await poolQuery(pool, buildTopValuesSql(name, { db, table, sampleSize, exact, top }));
    stats[name].top = rows.map((r) => ({ v: r.v, n: Number(r.n) }));
  }

  for (const name of names) stats[name] = { type: typeOf[name], ...stats[name] };

  return {
    server: connection.id,
    db,
    table,
    rowsScanned,
    exact: !!exact,
    notes: exact ? [] : [`Stats computed over the first ${sampleSize} rows (sample), not the full table. Use --exact for a full scan.`],
    columns: stats,
  };
}
