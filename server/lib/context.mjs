/**
 * Semantic context layer: one compact, LLM-optimized brief of a database so an
 * agent gets a map (tables, columns, keys, relations, row counts, notes) in a
 * single call instead of burning tokens on exploratory queries.
 *
 * Column grammar (token-efficient, self-explanatory):
 *   name type [pk|uniq|idx] [nn] [ai] [=default] [-> table.col[?]] [// comment]
 * A trailing `?` on an arrow marks a relation inferred from naming conventions
 * rather than a real FOREIGN KEY constraint.
 */
import { getPool, poolQuery } from './pool.mjs';

/** Candidate table names a column like `student_id` could point at. */
function targetCandidates(base) {
  const out = [base, `${base}s`, `${base}es`];
  if (base.endsWith('y')) out.push(`${base.slice(0, -1)}ies`);
  return out;
}

/**
 * Infer relations from naming conventions for columns that look like foreign
 * keys (`<base>_id`) but have no real FK constraint. A candidate target table
 * matches when it exists and its primary key is `id` or the column name itself.
 */
export function inferRelations({ columns, fks }) {
  const tables = new Map(); // lower(table) -> { name, pks: [] }
  for (const c of columns) {
    const key = c.tbl.toLowerCase();
    if (!tables.has(key)) tables.set(key, { name: c.tbl, pks: [] });
    if (c.keyKind === 'PRI') tables.get(key).pks.push(c.name);
  }
  const hasFk = new Set(fks.map((f) => `${f.tbl}::${f.col}`));

  const out = [];
  for (const c of columns) {
    if (c.keyKind === 'PRI') continue;
    if (hasFk.has(`${c.tbl}::${c.name}`)) continue;
    const m = /^(.+)_id$/i.exec(c.name);
    if (!m) continue;
    for (const candidate of targetCandidates(m[1].toLowerCase())) {
      const target = tables.get(candidate);
      if (!target) continue;
      const refCol = target.pks.includes('id') ? 'id'
        : target.pks.length === 1 && target.pks[0].toLowerCase() === c.name.toLowerCase() ? target.pks[0]
        : null;
      if (!refCol) continue;
      out.push({ tbl: c.tbl, col: c.name, refTable: target.name, refCol, kind: 'inferred' });
      break;
    }
  }
  return out;
}

/** Render one information_schema column row to the compact grammar. */
export function compactColumn(c, rel = null) {
  const parts = [c.name, c.type];
  if (c.keyKind === 'PRI') parts.push('pk');
  else if (c.keyKind === 'UNI') parts.push('uniq');
  else if (c.keyKind === 'MUL') parts.push('idx');
  if (c.nullable === 'NO' && c.keyKind !== 'PRI') parts.push('nn');
  if (/auto_increment/i.test(c.extra || '')) parts.push('ai');
  if (c.defaultValue !== null && c.defaultValue !== undefined) parts.push(`=${c.defaultValue}`);
  if (rel) parts.push(`-> ${rel.refTable}.${rel.refCol}${rel.kind === 'inferred' ? '?' : ''}`);
  if (c.comment) parts.push(`// ${c.comment}`);
  return parts.join(' ');
}

/** Group tables by their first name segment when ≥3 share it. */
function groupByPrefix(names) {
  const byPrefix = new Map();
  for (const name of names) {
    const prefix = name.split('_')[0];
    if (prefix === name) continue; // ungrouped single-word tables
    if (!byPrefix.has(prefix)) byPrefix.set(prefix, []);
    byPrefix.get(prefix).push(name);
  }
  const groups = {};
  for (const [prefix, members] of byPrefix) {
    if (members.length >= 3) groups[prefix] = members.sort();
  }
  return groups;
}

/**
 * Pure assembly: information_schema-shaped rows in, compact context out.
 * `annotations` (optional) are merged in as table/column comments.
 */
export function buildContext({ server, db, tables, columns, fks, annotations = [] }) {
  const inferred = inferRelations({ columns, fks });
  const relByCol = new Map();
  for (const f of fks) relByCol.set(`${f.tbl}::${f.col}`, { ...f, kind: 'fk' });
  for (const r of inferred) relByCol.set(`${r.tbl}::${r.col}`, r);

  const noteByTarget = new Map(); // 'tbl' or 'tbl::col' -> note
  for (const a of annotations) noteByTarget.set(a.col ? `${a.tbl}::${a.col}` : a.tbl, a.note);

  const out = {};
  for (const t of tables) out[t.name] = { rows: t.rowsApprox ?? null, columns: [] };
  for (const c of columns) {
    if (!out[c.tbl]) out[c.tbl] = { rows: null, columns: [] };
    const note = noteByTarget.get(`${c.tbl}::${c.name}`);
    const merged = note ? { ...c, comment: c.comment ? `${c.comment}; ${note}` : note } : c;
    out[c.tbl].columns.push(compactColumn(merged, relByCol.get(`${c.tbl}::${c.name}`) || null));
  }
  for (const t of tables) {
    const note = noteByTarget.get(t.name);
    const comment = [t.comment, note].filter(Boolean).join('; ');
    if (comment) out[t.name].comment = comment;
  }

  const notes = ['Row counts are storage-engine estimates, not exact.'];
  if (inferred.length) {
    notes.push('Arrows ending in ? are relations inferred from column naming, not real FOREIGN KEY constraints.');
  }

  return {
    server,
    db,
    tableCount: tables.length,
    columnCount: columns.length,
    groups: groupByPrefix(tables.map((t) => t.name)),
    tables: out,
    notes,
  };
}

/** Fetch the three information_schema result sets and assemble the context. */
export async function fetchContext(connection, db, { annotations = [] } = {}) {
  const pool = await getPool(connection, db);
  const [tables] = await poolQuery(pool, `
    SELECT TABLE_NAME AS name, TABLE_ROWS AS rowsApprox, TABLE_COMMENT AS comment
    FROM information_schema.tables WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME`, [db]);
  const [columns] = await poolQuery(pool, `
    SELECT TABLE_NAME AS tbl, COLUMN_NAME AS name, COLUMN_TYPE AS type,
           IS_NULLABLE AS nullable, COLUMN_KEY AS keyKind, COLUMN_DEFAULT AS defaultValue,
           EXTRA AS extra, COLUMN_COMMENT AS comment
    FROM information_schema.columns WHERE TABLE_SCHEMA = ?
    ORDER BY TABLE_NAME, ORDINAL_POSITION`, [db]);
  const [fks] = await poolQuery(pool, `
    SELECT TABLE_NAME AS tbl, COLUMN_NAME AS col,
           REFERENCED_TABLE_NAME AS refTable, REFERENCED_COLUMN_NAME AS refCol
    FROM information_schema.KEY_COLUMN_USAGE
    WHERE TABLE_SCHEMA = ? AND REFERENCED_TABLE_NAME IS NOT NULL`, [db]);
  return {
    ...buildContext({ server: connection.id, db, tables, columns, fks, annotations }),
    generatedAt: new Date().toISOString(),
  };
}
