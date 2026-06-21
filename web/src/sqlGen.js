/**
 * SQL fragment generators for the result-row context menu.
 *
 * The MySQL escaping here is intentionally minimal — we are generating SQL
 * for a human to inspect and run, not for unattended execution. We always
 * single-quote string values and double up embedded quotes (the only
 * portable thing across MySQL versions). Backslashes are escaped because
 * MySQL treats `\` as an escape character by default.
 */

function escapeIdent(name) {
  return '`' + String(name).replace(/`/g, '``') + '`';
}

function formatValue(v) {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? '1' : '0';
  if (typeof v === 'object') {
    // Object/array — store as JSON string
    return formatValue(JSON.stringify(v));
  }
  const s = String(v);
  // dateStrings: true on the server returns dates as strings already.
  const escaped = s.replace(/\\/g, '\\\\').replace(/'/g, "''");
  return `'${escaped}'`;
}

/**
 * Walk SQL once, tracking quote/comment state, and return the first table
 * after FROM or UPDATE. Returns null if none found.
 */
export function tableFromSql(sql) {
  if (!sql) return null;
  let clean = '';
  let i = 0;
  const n = sql.length;
  while (i < n) {
    const c = sql[i];
    const c2 = sql[i + 1];
    if (c === '-' && c2 === '-') { while (i < n && sql[i] !== '\n') i++; clean += ' '; continue; }
    if (c === '#')               { while (i < n && sql[i] !== '\n') i++; clean += ' '; continue; }
    if (c === '/' && c2 === '*') {
      i += 2;
      while (i < n && !(sql[i] === '*' && sql[i + 1] === '/')) i++;
      i += 2;
      clean += ' '; continue;
    }
    if (c === "'" || c === '"') {
      const q = c; i++;
      while (i < n) {
        if (sql[i] === '\\' && i + 1 < n) { i += 2; continue; }
        if (sql[i] === q) { i++; break; }
        i++;
      }
      clean += ' '; continue;
    }
    if (c === '`') {
      i++;
      while (i < n && sql[i] !== '`') { clean += sql[i]; i++; }
      i++;
      continue;
    }
    clean += c;
    i++;
  }
  const m = clean.match(/\b(?:FROM|UPDATE|INTO)\s+([A-Za-z_][A-Za-z_0-9]*)/i);
  return m ? m[1] : null;
}

/** Build INSERT INTO table (cols) VALUES (values). */
export function rowToInsert(table, row, columns) {
  const cols = columns.filter((c) => row[c] !== undefined);
  const colList = cols.map(escapeIdent).join(', ');
  const valList = cols.map((c) => formatValue(row[c])).join(', ');
  return `INSERT INTO ${escapeIdent(table)} (${colList}) VALUES (${valList});`;
}

/**
 * Build UPDATE table SET col=val,... WHERE pk=val.
 * If no primaryKey is provided, the WHERE clause uses every non-null column
 * to identify the row — safer than guessing, even if verbose.
 */
export function rowToUpdate(table, row, columns, primaryKey = []) {
  const setCols = columns.filter((c) => row[c] !== undefined);
  const setClause = setCols
    .map((c) => `${escapeIdent(c)} = ${formatValue(row[c])}`)
    .join(', ');
  const whereCols = primaryKey.length
    ? primaryKey.filter((c) => row[c] !== undefined)
    : setCols.filter((c) => row[c] !== null && row[c] !== undefined);
  const whereClause = whereCols
    .map((c) => `${escapeIdent(c)} = ${formatValue(row[c])}`)
    .join(' AND ');
  return `UPDATE ${escapeIdent(table)} SET ${setClause} WHERE ${whereClause};`;
}

/**
 * Build an UPDATE for a single cell: SET col = newValue WHERE <identity>.
 * The WHERE uses the ORIGINAL row (primary key if known, else every column with
 * its old value) so it targets the exact row even when the edited column is part
 * of the key. `LIMIT 1` bounds the no-PK case to one row.
 */
export function updateCellSql(table, primaryKey, row, col, newValue) {
  const set = `${escapeIdent(col)} = ${formatValue(newValue)}`;
  const whereCols = (primaryKey && primaryKey.length ? primaryKey : Object.keys(row))
    .filter((c) => row[c] !== undefined);
  const where = whereCols
    .map((c) => (row[c] === null
      ? `${escapeIdent(c)} IS NULL`
      : `${escapeIdent(c)} = ${formatValue(row[c])}`))
    .join(' AND ');
  return `UPDATE ${escapeIdent(table)} SET ${set} WHERE ${where} LIMIT 1;`;
}

/** Build DELETE FROM table WHERE pk=val (or all non-null cols if no PK). */
export function rowToDelete(table, row, columns, primaryKey = []) {
  const whereCols = primaryKey.length
    ? primaryKey.filter((c) => row[c] !== undefined)
    : columns.filter((c) => row[c] !== null && row[c] !== undefined);
  const whereClause = whereCols
    .map((c) => `${escapeIdent(c)} = ${formatValue(row[c])}`)
    .join(' AND ');
  return `DELETE FROM ${escapeIdent(table)} WHERE ${whereClause};`;
}
