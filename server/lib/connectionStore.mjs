/**
 * SQLite-backed connection store. Replaces the old dbconfs/*.txt loader as the
 * single source of connection definitions. Mirrors the PreferenceStore /
 * SnippetStore pattern. Connection objects keep the shape the rest of the app
 * expects: { id, label, kind, host, port, user, password, ... }.
 */
import { withTx } from './db.mjs';
import { isEncrypted, identityCodec } from './secret.mjs';

/** Slugify a label into a stable id: lowercase, non-alphanumerics → '-'. */
export function slugify(label) {
  const base = String(label || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return base || 'connection';
}

/** Preserve an explicitly-provided id verbatim — only sanitize invalid chars,
 *  KEEP case — so migrated/known ids like "V4-server84" stay stable across the
 *  dbconfs→store migration (existing snippets reference them by exact id). */
export function normalizeId(id) {
  const base = String(id || '')
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return base || 'connection';
}

/** Only `localhost` is local; everything else (incl. 127.0.0.1) is remote.
 *  An explicit override of 'local'|'remote' always wins. */
export function deriveKind(host, override) {
  if (override === 'local' || override === 'remote') return override;
  return host === 'localhost' ? 'local' : 'remote';
}

/** Strip the password for client-facing responses. */
export function safeConnection(conn) {
  const { password, ...rest } = conn;
  return { ...rest, hasPassword: !!password };
}

function row2conn(row) {
  if (!row) return null;
  return {
    id: row.id,
    label: row.label,
    kind: row.kind,
    host: row.host,
    port: row.port,
    user: row.user,
    password: row.password,
    color: row.color,
    group: row.group_tag,
    notes: row.notes,
    sortOrder: row.sort_order,
    writeProtected: !!row.write_protected,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class ConnectionStore {
  constructor(db, { secret = identityCodec } = {}) {
    this.db = db;
    this.secret = secret; // { encrypt, decrypt } — passwords are encrypted at rest
  }

  // row2conn returns the raw stored password; decode it for in-memory use.
  _decode(conn) {
    if (!conn) return null;
    return { ...conn, password: this.secret.decrypt(conn.password) };
  }

  all() {
    const rows = this.db.prepare('SELECT * FROM connections').all().map(row2conn).map((c) => this._decode(c));
    rows.sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === 'local' ? -1 : 1;
      if ((a.sortOrder ?? 0) !== (b.sortOrder ?? 0)) return (a.sortOrder ?? 0) - (b.sortOrder ?? 0);
      return a.label.localeCompare(b.label);
    });
    return rows;
  }

  get(id) {
    return this._decode(row2conn(this.db.prepare('SELECT * FROM connections WHERE id = ?').get(id)));
  }

  _uniqueId(desired) {
    let id = desired;
    let n = 2;
    while (this.get(id)) id = `${desired}-${n++}`;
    return id;
  }

  create(input) {
    const label = input.label || input.id;
    if (!label) throw new Error('label required');
    if (!input.host) throw new Error('host required');
    if (!input.user) throw new Error('user required');
    const desired = input.id ? normalizeId(input.id) : slugify(label);
    const id = this._uniqueId(desired);
    const now = new Date().toISOString();
    const kind = deriveKind(input.host, input.kind);
    this.db.prepare(
      `INSERT INTO connections
         (id, label, kind, host, port, user, password, color, group_tag, notes, sort_order, write_protected, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      id, label, kind, input.host, Number(input.port) || 3306, input.user,
      this.secret.encrypt(input.password || ''), input.color || null, input.group || null, input.notes || null,
      Number(input.sortOrder) || 0, input.writeProtected ? 1 : 0, now, now,
    );
    return this.get(id);
  }

  update(id, patch) {
    const existing = this.get(id);
    if (!existing) return null;
    const merged = { ...existing, ...patch };
    let kind;
    if (patch.kind === 'local' || patch.kind === 'remote') kind = patch.kind;
    else if (patch.host !== undefined) kind = deriveKind(patch.host);
    else kind = existing.kind;
    const now = new Date().toISOString();
    this.db.prepare(
      `UPDATE connections SET
         label = ?, kind = ?, host = ?, port = ?, user = ?, password = ?,
         color = ?, group_tag = ?, notes = ?, sort_order = ?, write_protected = ?, updated_at = ?
       WHERE id = ?`
    ).run(
      merged.label, kind, merged.host, Number(merged.port) || 3306, merged.user,
      this.secret.encrypt(merged.password ?? ''), merged.color ?? null, merged.group ?? null, merged.notes ?? null,
      Number(merged.sortOrder) || 0, merged.writeProtected ? 1 : 0, now, id,
    );
    return this.get(id);
  }

  delete(id) {
    return this.db.prepare('DELETE FROM connections WHERE id = ?').run(id).changes > 0;
  }

  /** Upsert by id (slug). For import files / agent pushes. Idempotent. */
  bulkUpsert(items) {
    const results = [];
    withTx(this.db, () => {
      for (const c of items) {
        if (!c || !c.host || !c.user) {
          results.push({ label: c?.label || '(unnamed)', status: 'skipped', reason: 'host and user required' });
          continue;
        }
        const id = c.id ? normalizeId(c.id) : slugify(c.label || c.host);
        if (this.get(id)) {
          this.update(id, c);
          results.push({ id, label: c.label, status: 'updated' });
        } else {
          const created = this.create({ ...c, id });
          results.push({ id: created.id, label: created.label, status: 'created' });
        }
      }
    });
    return results;
  }

  /** Count how passwords are stored at rest (for `lwdb secure status`). */
  auditEncryption() {
    const rows = this.db.prepare('SELECT password FROM connections').all();
    let encrypted = 0, plaintext = 0, empty = 0;
    for (const r of rows) {
      if (!r.password) empty++;
      else if (isEncrypted(r.password)) encrypted++;
      else plaintext++;
    }
    return { total: rows.length, encrypted, plaintext, empty };
  }

  /** Re-encrypt any legacy plaintext passwords in place. Idempotent. */
  migrateEncryption() {
    const rows = this.db.prepare('SELECT id, password FROM connections').all();
    let migrated = 0;
    withTx(this.db, () => {
      for (const r of rows) {
        if (r.password && !isEncrypted(r.password)) {
          this.db.prepare('UPDATE connections SET password = ? WHERE id = ?').run(this.secret.encrypt(r.password), r.id);
          migrated++;
        }
      }
    });
    return { migrated };
  }

  /** Full export document (INCLUDES passwords — it's a local backup file). */
  exportAll() {
    return {
      version: 1,
      connections: this.all().map((c) => ({
        id: c.id, label: c.label, kind: c.kind, host: c.host, port: c.port,
        user: c.user, password: c.password, color: c.color, group: c.group, notes: c.notes,
        sortOrder: c.sortOrder, writeProtected: c.writeProtected,
      })),
    };
  }
}
