export class PreferenceStore {
  constructor(db) {
    this.db = db;
  }

  get(key, fallback = null) {
    const row = this.db.prepare('SELECT value_json FROM preferences WHERE key = ?').get(key);
    if (!row) return fallback;
    try { return JSON.parse(row.value_json); } catch { return fallback; }
  }

  set(key, value) {
    this.db.prepare(
      `INSERT INTO preferences (key, value_json) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json`
    ).run(key, JSON.stringify(value));
  }

  all() {
    const rows = this.db.prepare('SELECT key, value_json FROM preferences').all();
    const out = {};
    for (const r of rows) { try { out[r.key] = JSON.parse(r.value_json); } catch { /* skip */ } }
    return out;
  }

  importAll(map = {}) {
    const stmt = this.db.prepare('INSERT INTO preferences (key, value_json) VALUES (?, ?)');
    this.db.exec('BEGIN');
    try {
      this.db.exec('DELETE FROM preferences');
      for (const [k, v] of Object.entries(map)) stmt.run(k, JSON.stringify(v));
      this.db.exec('COMMIT');
    } catch (err) {
      try { this.db.exec('ROLLBACK'); } catch (_) { /* ignore */ }
      throw err;
    }
  }
}
