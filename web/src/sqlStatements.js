/**
 * Quote- and comment-aware SQL statement splitting, with character ranges.
 *
 * Shared by:
 *   - the editor's "run statement at cursor" behaviour (DBeaver-style)
 *   - the autocomplete source, to scope FROM/JOIN scanning to one statement
 *
 * We never strip the statement text we return — callers send it to MySQL
 * verbatim. The scanner only tracks state to find unquoted `;` boundaries.
 */

/**
 * Split SQL into statements. Returns `[{ text, from, to }]` where `from`/`to`
 * are absolute character offsets into the original string (`to` is the index
 * of the terminating `;`, or the end of input for the last statement).
 * Whitespace/comment-only chunks are dropped.
 */
export function splitStatements(sql) {
  const parts = [];
  const n = sql.length;
  let i = 0;
  let start = 0;
  let state = 'code'; // code | line | block | sq | dq | bq

  const push = (end) => {
    const text = sql.slice(start, end);
    if (text.trim()) parts.push({ text, from: start, to: end });
  };

  while (i < n) {
    const c = sql[i];
    const c2 = sql[i + 1];

    if (state === 'code') {
      if (c === '-' && c2 === '-') { state = 'line'; i += 2; continue; }
      if (c === '#') { state = 'line'; i += 1; continue; }
      if (c === '/' && c2 === '*') { state = 'block'; i += 2; continue; }
      if (c === "'") { state = 'sq'; i += 1; continue; }
      if (c === '"') { state = 'dq'; i += 1; continue; }
      if (c === '`') { state = 'bq'; i += 1; continue; }
      if (c === ';') { push(i); start = i + 1; i += 1; continue; }
      i += 1;
      continue;
    }
    if (state === 'line') { if (c === '\n') state = 'code'; i += 1; continue; }
    if (state === 'block') {
      if (c === '*' && c2 === '/') { i += 2; state = 'code'; continue; }
      i += 1;
      continue;
    }
    // string / quoted-identifier states
    if ((state === 'sq' || state === 'dq') && c === '\\' && i + 1 < n) { i += 2; continue; }
    if ((state === 'sq' && c === "'") || (state === 'dq' && c === '"') || (state === 'bq' && c === '`')) {
      state = 'code';
      i += 1;
      continue;
    }
    i += 1;
  }
  push(n);
  return parts;
}

/** The statement whose range contains `offset` (falls back to the nearest prior one). */
export function statementAt(sql, offset) {
  const stmts = splitStatements(sql);
  if (!stmts.length) return { text: sql, from: 0, to: sql.length };
  const hit = stmts.find((s) => offset >= s.from && offset <= s.to);
  if (hit) return hit;
  for (let k = stmts.length - 1; k >= 0; k--) {
    if (stmts[k].to < offset) return stmts[k];
  }
  return stmts[0];
}

/**
 * Decide what to execute given the caret/selection:
 *   - a non-empty selection → that selection verbatim
 *   - otherwise the single statement under the caret
 *   - if there's only one statement, just run it
 *
 * Returns `{ sql, kind, index, total }`.
 */
export function pickStatement(sql, { cursorOffset = 0, selFrom = null, selTo = null } = {}) {
  if (selFrom != null && selTo != null && selTo > selFrom) {
    const sel = sql.slice(selFrom, selTo).trim();
    if (sel) return { sql: sel, kind: 'selection', index: 0, total: 1 };
  }
  const stmts = splitStatements(sql);
  if (stmts.length <= 1) {
    return { sql: sql.trim(), kind: 'single', index: 0, total: Math.max(stmts.length, 1) };
  }
  let idx = stmts.findIndex((s) => cursorOffset >= s.from && cursorOffset <= s.to);
  if (idx === -1) {
    for (let k = stmts.length - 1; k >= 0; k--) {
      if (stmts[k].to < cursorOffset) { idx = k; break; }
    }
    if (idx === -1) idx = 0;
  }
  return { sql: stmts[idx].text.trim(), kind: 'at-cursor', index: idx, total: stmts.length };
}
