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

/**
 * First non-whitespace offset of each statement (where its content begins).
 * The caret "belongs" to a statement from its content-start up to (but not
 * including) the next statement's content-start — so the terminating `;` and
 * the blank lines after it map to the statement that just ended, which is what
 * a user expects when the caret sits at the end of a statement's line.
 */
function contentStart(stmt) {
  return stmt.from + (stmt.text.length - stmt.text.trimStart().length);
}

/** Index of the statement the caret is in (last whose content-start ≤ offset). */
function indexAtOffset(stmts, offset) {
  let idx = 0;
  for (let k = 0; k < stmts.length; k++) {
    if (contentStart(stmts[k]) <= offset) idx = k;
    else break;
  }
  return idx;
}

/** The statement the caret is in (falls back to the first). */
export function statementAt(sql, offset) {
  const stmts = splitStatements(sql);
  if (!stmts.length) return { text: sql, from: 0, to: sql.length };
  return stmts[indexAtOffset(stmts, offset)];
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
  const idx = indexAtOffset(stmts, cursorOffset);
  return { sql: stmts[idx].text.trim(), kind: 'at-cursor', index: idx, total: stmts.length };
}
