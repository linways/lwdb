export class HistoryStore {
  constructor(db, { max = 10_000 } = {}) {
    this.db = db;
    this.max = max;
  }

  trim() {
    const row = this.db.prepare('SELECT COUNT(*) AS c FROM query_history').get();
    if (row && row.c > this.max) {
      const excess = row.c - this.max;
      this.db.prepare(
        `DELETE FROM query_history WHERE id IN (
           SELECT id FROM query_history ORDER BY id ASC LIMIT ?
         )`
      ).run(excess);
    }
  }

  record({ server, db: dbName, sql, args = [], elapsedMs, rowCount, verb, ok = true, error = null, snippetId = null, actor = null }) {
    this.db.prepare(
      `INSERT INTO query_history (server, db, sql, args_json, started_at, elapsed_ms, row_count, verb, ok, error, snippet_id, actor)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      server,
      dbName ?? null,
      sql,
      JSON.stringify(args),
      new Date().toISOString(),
      elapsedMs ?? null,
      rowCount ?? null,
      verb ?? null,
      ok ? 1 : 0,
      error,
      snippetId,
      actor ?? null,
    );
    // periodic trim — every ~50 inserts to keep table bounded
    if (Math.random() < 0.02) this.trim();
  }

  recent({ limit = 50, server = null, db = null, actor = null } = {}) {
    const conds = [];
    const args = [];
    if (server) { conds.push('server = ?'); args.push(server); }
    if (db) { conds.push('db = ?'); args.push(db); }
    if (actor) { conds.push('actor = ?'); args.push(actor); }
    const where = conds.length ? 'WHERE ' + conds.join(' AND ') : '';
    args.push(Math.min(Math.max(limit, 1), 500));
    return this.db.prepare(
      `SELECT id, server, db, sql, args_json, started_at, elapsed_ms, row_count, verb, ok, error, snippet_id, actor
       FROM query_history ${where}
       ORDER BY started_at DESC
       LIMIT ?`
    ).all(...args).map((r) => ({
      id: r.id,
      server: r.server,
      db: r.db,
      sql: r.sql,
      args: JSON.parse(r.args_json || '[]'),
      startedAt: r.started_at,
      elapsedMs: r.elapsed_ms,
      rowCount: r.row_count,
      verb: r.verb,
      ok: !!r.ok,
      error: r.error,
      snippetId: r.snippet_id,
      actor: r.actor || 'unknown',
    }));
  }

  clear() {
    this.db.exec('DELETE FROM query_history');
  }

  exportAll() {
    return this.recent({ limit: 500 });
  }
}
