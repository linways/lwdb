/**
 * Read-only SQL guard.
 *
 * Splits the raw SQL into statements (quote- and comment-aware), then runs a
 * verb check on a comment/string-stripped copy of each statement so write
 * verbs hidden inside string literals or comments don't trip the guard.
 *
 * The original raw statement is preserved verbatim so we never mangle the SQL
 * we actually send to MySQL — earlier versions returned the stripped text and
 * accidentally erased every quoted literal.
 */
const READ_ONLY_VERBS = new Set([
  'SELECT', 'SHOW', 'DESCRIBE', 'DESC', 'EXPLAIN', 'WITH', 'USE',
]);

const WRITE_VERBS = [
  'INSERT', 'UPDATE', 'DELETE', 'REPLACE', 'MERGE',
  'CREATE', 'DROP', 'ALTER', 'TRUNCATE', 'RENAME',
  'GRANT', 'REVOKE',
  'CALL', 'LOAD', 'HANDLER', 'LOCK', 'UNLOCK',
  'SET',
];
const WRITE_VERB_RE = new RegExp(`\\b(${WRITE_VERBS.join('|')})\\b`, 'i');

/**
 * Strip strings, quoted identifiers, and comments from a SQL fragment.
 * Used only for verb/keyword analysis — NEVER for the executed text.
 */
function stripForAnalysis(sql) {
  let out = '';
  let i = 0;
  const n = sql.length;
  while (i < n) {
    const c = sql[i];
    const c2 = sql[i + 1];

    if (c === '-' && c2 === '-') { while (i < n && sql[i] !== '\n') i++; continue; }
    if (c === '#') { while (i < n && sql[i] !== '\n') i++; continue; }
    if (c === '/' && c2 === '*') {
      i += 2;
      while (i < n && !(sql[i] === '*' && sql[i + 1] === '/')) i++;
      i += 2; // skip closing */
      continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      const q = c;
      out += q;
      i++;
      while (i < n) {
        if (sql[i] === '\\' && i + 1 < n) { i += 2; continue; }
        if (sql[i] === q) { out += q; i++; break; }
        i++;
      }
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

/**
 * Split raw SQL on unquoted, uncommented semicolons. Preserves the original
 * text of each statement so the caller can hand it straight to MySQL.
 */
function splitStatements(sql) {
  const parts = [];
  let buf = '';
  // state: 'code' | 'sq' | 'dq' | 'bq' | 'line' | 'hash' | 'block'
  let state = 'code';
  let i = 0;
  const n = sql.length;

  while (i < n) {
    const c = sql[i];
    const c2 = sql[i + 1];

    if (state === 'code') {
      if (c === '-' && c2 === '-') { state = 'line'; buf += c; i++; continue; }
      if (c === '#')               { state = 'hash'; buf += c; i++; continue; }
      if (c === '/' && c2 === '*') { state = 'block'; buf += '/*'; i += 2; continue; }
      if (c === "'") { state = 'sq'; buf += c; i++; continue; }
      if (c === '"') { state = 'dq'; buf += c; i++; continue; }
      if (c === '`') { state = 'bq'; buf += c; i++; continue; }
      if (c === ';') {
        if (buf.trim()) parts.push(buf.trim());
        buf = '';
        i++;
        continue;
      }
      buf += c; i++;
      continue;
    }

    if (state === 'line' || state === 'hash') {
      buf += c;
      if (c === '\n') state = 'code';
      i++;
      continue;
    }

    if (state === 'block') {
      if (c === '*' && c2 === '/') { buf += '*/'; i += 2; state = 'code'; continue; }
      buf += c; i++;
      continue;
    }

    // sq / dq / bq — handle escape, then look for matching close
    if (c === '\\' && i + 1 < n) {
      buf += c + sql[i + 1];
      i += 2;
      continue;
    }
    buf += c;
    if ((state === 'sq' && c === "'") || (state === 'dq' && c === '"') || (state === 'bq' && c === '`')) {
      state = 'code';
    }
    i++;
  }

  if (buf.trim()) parts.push(buf.trim());
  return parts;
}

export function inspectSql(sql) {
  // Filter out comment-only or whitespace-only statements — they'd otherwise
  // be reported as having an empty verb and trigger READONLY_BLOCKED, when
  // semantically they're just no-ops.
  const stmts = splitStatements(sql).filter((s) => stripForAnalysis(s).trim().length > 0);
  const verbs = stmts.map((s) => {
    const stripped = stripForAnalysis(s).trim();
    return (stripped.match(/^(\w+)/) || [, ''])[1].toUpperCase();
  });
  const flags = stmts.map((s, i) => {
    const stripped = stripForAnalysis(s);
    return READ_ONLY_VERBS.has(verbs[i]) && !WRITE_VERB_RE.test(stripped);
  });
  return {
    stmts,
    verbs,
    allReadOnly: flags.every(Boolean),
    perStatementReadOnly: flags,
  };
}

export function assertReadOnly(sql) {
  const info = inspectSql(sql);
  if (!info.stmts.length) {
    const e = new Error('Empty SQL');
    e.code = 'EMPTY_SQL';
    throw e;
  }
  if (!info.allReadOnly) {
    const idx = info.perStatementReadOnly.findIndex((b) => !b);
    const verb = info.verbs[idx] || 'UNKNOWN';
    const e = new Error(`Blocked: ${verb}-style statement not allowed in read-only mode. Unlock writes to run this.`);
    e.code = 'READONLY_BLOCKED';
    e.verb = verb;
    throw e;
  }
  return info;
}
