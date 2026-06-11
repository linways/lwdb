/**
 * Annotations: human/agent-authored notes on tables and columns, stored in
 * lwdb's SQLite and merged into `lwdb context` output as comments. One note
 * per target — (server, db, tbl) for a table, (server, db, tbl, col) for a
 * column — upserts replace in place.
 */
import { randomUUID } from 'node:crypto';

function rowToObj(r) {
  if (!r) return null;
  return {
    id: r.id, server: r.server, db: r.db, tbl: r.tbl, col: r.col ?? null,
    note: r.note, source: r.source, createdAt: r.created_at, updatedAt: r.updated_at,
  };
}

function requireString(value, name) {
  if (typeof value !== 'string' || !value.trim()) {
    throw Object.assign(new Error(`${name} is required`), { code: 'BAD_REQUEST' });
  }
  return value.trim();
}

export class AnnotationStore {
  constructor(db) {
    this.db = db;
  }

  upsert({ server, db, tbl, col = null, note, source = 'human' }) {
    server = requireString(server, 'server');
    db = requireString(db, 'db');
    tbl = requireString(tbl, 'tbl');
    note = requireString(note, 'note');
    const now = new Date().toISOString();

    const existing = this.db.prepare(
      'SELECT * FROM annotations WHERE server = ? AND db = ? AND tbl = ? AND IFNULL(col, \'\') = IFNULL(?, \'\')',
    ).get(server, db, tbl, col);

    if (existing) {
      this.db.prepare('UPDATE annotations SET note = ?, source = ?, updated_at = ? WHERE id = ?')
        .run(note, source, now, existing.id);
      return rowToObj({ ...existing, note, source, updated_at: now });
    }

    const id = randomUUID();
    this.db.prepare(
      `INSERT INTO annotations (id, server, db, tbl, col, note, source, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, server, db, tbl, col, note, source, now, now);
    return rowToObj({ id, server, db, tbl, col, note, source, created_at: now, updated_at: now });
  }

  list({ server, db, tbl } = {}) {
    const where = [];
    const args = [];
    if (server) { where.push('server = ?'); args.push(server); }
    if (db) { where.push('db = ?'); args.push(db); }
    if (tbl) { where.push('tbl = ?'); args.push(tbl); }
    const sql = `SELECT * FROM annotations${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY tbl, IFNULL(col, '')`;
    return this.db.prepare(sql).all(...args).map(rowToObj);
  }

  remove({ server, db, tbl, col = null }) {
    const result = this.db.prepare(
      'DELETE FROM annotations WHERE server = ? AND db = ? AND tbl = ? AND IFNULL(col, \'\') = IFNULL(?, \'\')',
    ).run(server, db, tbl, col);
    return result.changes > 0;
  }
}
