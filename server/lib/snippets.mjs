import { randomUUID } from 'node:crypto';
import { withTx } from './db.mjs';

const PARAM_RE = /:([a-zA-Z_][a-zA-Z0-9_]*)/g;

// Supported per-param operator overrides. Each entry knows how to rewrite the
// comparison preceding the placeholder and how to transform the bound value.
const OPERATORS = {
  eq:             { sqlOp: '=',         wrap: (v) => v },
  neq:            { sqlOp: '<>',        wrap: (v) => v },
  like:           { sqlOp: 'LIKE',      wrap: (v) => v },          // user provides their own % wildcards
  like_contains:  { sqlOp: 'LIKE',      wrap: (v) => `%${v}%` },
  like_starts:    { sqlOp: 'LIKE',      wrap: (v) => `${v}%` },
  like_ends:      { sqlOp: 'LIKE',      wrap: (v) => `%${v}` },
  not_like:       { sqlOp: 'NOT LIKE',  wrap: (v) => `%${v}%` },
};

export function extractParams(sql) {
  const seen = new Set();
  const out = [];
  let m;
  while ((m = PARAM_RE.exec(sql)) !== null) {
    if (!seen.has(m[1])) {
      seen.add(m[1]);
      out.push(m[1]);
    }
  }
  return out;
}

/**
 * Rewrite the comparison directly preceding `:param` to use `newSqlOp`.
 * Matches `=`, `<>`, `!=`, `LIKE`, `NOT LIKE` (whitespace tolerant), so e.g.
 * `WHERE name = :name` becomes `WHERE name LIKE :name`. Only the occurrence
 * directly adjacent (modulo whitespace) is rewritten — other text is untouched.
 */
function rewriteOperator(sql, param, newSqlOp) {
  const re = new RegExp(
    `(?:!=|<>|=|\\bNOT\\s+LIKE\\b|\\bLIKE\\b)(\\s*):${param}(?![A-Za-z0-9_])`,
    'gi',
  );
  return sql.replace(re, `${newSqlOp}$1:${param}`);
}

/**
 * Bind named placeholders to mysql2 positional args, honoring per-param
 * operator overrides. `operators` maps param name → operator key (see OPERATORS).
 * If unset for a param, the SQL and value are unchanged.
 */
export function bindParams(sql, values, operators = {}) {
  let working = sql;

  // First, apply each operator override to the SQL so the comparison verb
  // changes before we substitute placeholders.
  for (const [name, opKey] of Object.entries(operators)) {
    if (!opKey || opKey === 'eq') continue;
    const op = OPERATORS[opKey];
    if (!op) {
      throw Object.assign(new Error(`Unknown operator '${opKey}' for :${name}`), {
        code: 'BAD_REQUEST',
        param: name,
      });
    }
    working = rewriteOperator(working, name, op.sqlOp);
  }

  // Then collapse all :param placeholders to positional ?, in order.
  const order = [];
  const bound = working.replace(PARAM_RE, (_, name) => {
    order.push(name);
    return '?';
  });

  const args = order.map((n) => {
    if (!(n in values)) {
      throw Object.assign(new Error(`Missing parameter: ${n}`), { code: 'MISSING_PARAM', param: n });
    }
    const op = OPERATORS[operators[n]] || OPERATORS.eq;
    return op.wrap(values[n]);
  });
  return { sql: bound, args };
}

export const SUPPORTED_OPERATORS = Object.freeze(Object.keys(OPERATORS));

function row2snippet(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    sql: row.sql,
    tags: JSON.parse(row.tags_json || '[]'),
    defaultServer: row.default_server,
    defaultDb: row.default_db,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    params: extractParams(row.sql),
  };
}

export class SnippetStore {
  constructor(db) {
    this.db = db;
  }

  list() {
    const rows = this.db.prepare('SELECT * FROM snippets ORDER BY name').all();
    return rows.map(row2snippet);
  }

  get(id) {
    const row = this.db.prepare('SELECT * FROM snippets WHERE id = ?').get(id);
    return row2snippet(row);
  }

  findByName(name) {
    const row = this.db.prepare('SELECT * FROM snippets WHERE LOWER(name) = LOWER(?)').get(name);
    return row2snippet(row);
  }

  create({ name, description = '', sql, tags = [], defaultServer = null, defaultDb = null }) {
    if (!name || !sql) throw new Error('name and sql required');
    const id = randomUUID();
    const now = new Date().toISOString();
    this.db.prepare(
      `INSERT INTO snippets (id, name, description, sql, tags_json, default_server, default_db, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(id, name, description, sql, JSON.stringify(tags), defaultServer, defaultDb, now, now);
    return this.get(id);
  }

  update(id, patch) {
    const existing = this.get(id);
    if (!existing) return null;
    const merged = { ...existing, ...patch };
    const now = new Date().toISOString();
    this.db.prepare(
      `UPDATE snippets SET name = ?, description = ?, sql = ?, tags_json = ?, default_server = ?, default_db = ?, updated_at = ?
       WHERE id = ?`
    ).run(
      merged.name,
      merged.description || '',
      merged.sql,
      JSON.stringify(merged.tags || []),
      merged.defaultServer ?? null,
      merged.defaultDb ?? null,
      now,
      id,
    );
    return this.get(id);
  }

  remove(id) {
    const info = this.db.prepare('DELETE FROM snippets WHERE id = ?').run(id);
    return info.changes > 0;
  }

  /* import/export are sync because sqlite is sync; suffix not needed */
  exportAll() {
    return this.db.prepare('SELECT * FROM snippets').all().map(row2snippet);
  }

  importAll(items, { merge = false } = {}) {
    const insert = this.db.prepare(
      `INSERT OR REPLACE INTO snippets (id, name, description, sql, tags_json, default_server, default_db, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    withTx(this.db, () => {
      if (!merge) this.db.exec('DELETE FROM snippets');
      for (const s of items) {
        insert.run(
          s.id || randomUUID(),
          s.name,
          s.description || '',
          s.sql,
          JSON.stringify(s.tags || []),
          s.defaultServer ?? null,
          s.defaultDb ?? null,
          s.createdAt || new Date().toISOString(),
          s.updatedAt || new Date().toISOString(),
        );
      }
    });
  }

  /**
   * Bulk upsert by name (case-insensitive). Designed for AI-agent bulk pushes
   * where the agent doesn't know existing IDs. Existing rows are updated in
   * place; new ones inserted. Returns per-row outcome.
   */
  bulkUpsert(items) {
    const results = [];
    withTx(this.db, () => {
      for (const s of items) {
        if (!s || !s.name || !s.sql) {
          results.push({ name: s?.name || '(unnamed)', status: 'skipped', reason: 'name and sql required' });
          continue;
        }
        const existing = this.findByName(s.name);
        if (existing) {
          this.update(existing.id, s);
          results.push({ id: existing.id, name: s.name, status: 'updated' });
        } else {
          const created = this.create(s);
          results.push({ id: created.id, name: created.name, status: 'created' });
        }
      }
    });
    return results;
  }
}
