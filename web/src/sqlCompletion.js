/**
 * From-clause-aware bare column completion for the SQL editor.
 *
 * CodeMirror's @codemirror/lang-sql resolves dot-prefixed completions (`t.` →
 * columns of `t`) and aliases declared with `AS x` or bare-alias `tbl x`. What
 * it does *not* do is scope bare-word completions to whichever tables are
 * referenced in the current statement's FROM/JOIN list — so typing in a WHERE
 * clause just lists every table.
 *
 * This source fills that gap. It scans the *current statement*, picks out
 * referenced tables (quote-aware, so backticked identifiers work and string
 * literals are skipped), and offers each table's columns as bare completions.
 *
 * It deliberately stays silent when the caret is in a table-name position
 * (right after FROM / JOIN / UPDATE / INTO) so the schema source can offer
 * table names there instead of columns.
 */
import { statementAt } from './sqlStatements.js';

// True when the text immediately before the caret word is a clause keyword
// that expects a table name next.
const TABLE_POSITION_RE = /(?:\bfrom\b|\bjoin\b|\bupdate\b|\binto\b)\s+$/i;

/**
 * Walk the doc once, character-by-character, tracking comment + quote state.
 * Returns an array of { name } for every table named after a table-introducing
 * keyword: FROM / JOIN (SELECT, DELETE), UPDATE, and INTO (INSERT/REPLACE INTO).
 * An optional `db.` schema qualifier is allowed and stripped to the table name.
 */
export function extractReferencedTables(docText) {
  // Strip comments and string content while preserving structure so the keyword
  // scan won't be fooled by a `FROM`/`UPDATE` sitting in a comment or string.
  // Backticked identifiers ARE preserved (we want the table name).
  let clean = '';
  let i = 0;
  const n = docText.length;
  while (i < n) {
    const c = docText[i];
    const c2 = docText[i + 1];
    if (c === '-' && c2 === '-') { while (i < n && docText[i] !== '\n') i++; clean += ' '; continue; }
    if (c === '#')               { while (i < n && docText[i] !== '\n') i++; clean += ' '; continue; }
    if (c === '/' && c2 === '*') {
      i += 2;
      while (i < n && !(docText[i] === '*' && docText[i + 1] === '/')) i++;
      i += 2;
      clean += ' '; continue;
    }
    if (c === "'" || c === '"') {
      const q = c; i++;
      while (i < n) {
        if (docText[i] === '\\' && i + 1 < n) { i += 2; continue; }
        if (docText[i] === q) { i++; break; }
        i++;
      }
      clean += ' '; continue;
    }
    // Backticked identifier: keep the inner text so we can match the table name.
    if (c === '`') {
      i++;
      while (i < n && docText[i] !== '`') { clean += docText[i]; i++; }
      i++; // skip closing backtick
      continue;
    }
    clean += c;
    i++;
  }

  const tables = [];
  // Optional `db.` qualifier, then the table identifier. We keep the part after
  // the last dot (the table), since lwdb completes columns for a table name.
  const re = /\b(?:FROM|JOIN|UPDATE|INTO)\s+(?:[A-Za-z_][A-Za-z_0-9]*\.)?([A-Za-z_][A-Za-z_0-9]*)/gi;
  let m;
  while ((m = re.exec(clean)) !== null) {
    tables.push({ name: m[1] });
  }
  return tables;
}

/**
 * DBeaver-style short alias for a table name: initials of its word parts
 * (snake_case + camelCase), e.g. student_total_mark → "stm". Single-word tables
 * collapse to their first letter (settings → "s").
 * ponytail: no cross-table dedupe — two tables starting alike share an alias;
 * the user edits the rare collision. Add a uniquifier if it bites.
 */
export function aliasFor(table) {
  const parts = String(table).replace(/[`"]/g, '')
    .split(/[_\s]+/)
    .flatMap((p) => p.split(/(?<=[a-z0-9])(?=[A-Z])/))
    .filter(Boolean);
  if (parts.length > 1) return parts.map((p) => p[0].toLowerCase()).join('').slice(0, 4);
  return (parts[0] || String(table)).slice(0, 1).toLowerCase();
}

/**
 * Wrap a completion source so that, when the caret is in a table-name position
 * (after FROM/JOIN/UPDATE/INTO), completing a known table also inserts a
 * generated alias — like DBeaver's "insert table aliases". `enabled()` gates it
 * (a pref); `schemaRef.value.tables` identifies which options are real tables.
 */
export function withTableAlias(source, { enabled, schemaRef }) {
  return async (context) => {
    const result = await source(context);
    if (!result || !result.options || !enabled || !enabled()) return result;

    const word = context.matchBefore(/[\w]*/);
    if (!word) return result;
    const docText = context.state.doc.toString();
    const stmt = statementAt(docText, context.pos);
    if (!TABLE_POSITION_RE.test(docText.slice(stmt.from, word.from))) return result;

    const tables = new Set(Object.keys((schemaRef.value && schemaRef.value.tables) || {}).map((t) => t.toLowerCase()));
    if (!tables.size) return result;

    return {
      ...result,
      options: result.options.map((o) => {
        if (typeof o.apply === 'function') return o;
        if (!tables.has(String(o.label).toLowerCase())) return o;
        return { ...o, apply: `${o.label} ${aliasFor(o.label)} ` };
      }),
    };
  };
}

/**
 * Build a CodeMirror completion source that, when the cursor is at a bare
 * identifier (not preceded by `.`), suggests columns from any table listed in
 * the document's FROM/JOIN clauses.
 *
 * @param schemaRef  An object exposing `.value.tables` — the live store schema.
 * @returns A CompletionSource function compatible with @codemirror/autocomplete.
 */
export function fromAwareColumnSource(schemaRef) {
  return (context) => {
    const word = context.matchBefore(/[\w]*/);
    if (!word) return null;
    if (word.from === word.to && !context.explicit) return null;

    // If the char before the word is '.', let lang-sql handle it (dot-completion).
    if (word.from > 0 && context.state.sliceDoc(word.from - 1, word.from) === '.') return null;

    const schema = (schemaRef.value && schemaRef.value.tables) || {};
    if (!schema || !Object.keys(schema).length) return null;

    const docText = context.state.doc.toString();

    // Scope to the statement under the caret — don't pull tables from sibling
    // statements in the same editor.
    const stmt = statementAt(docText, context.pos);

    // If the caret is in a table-name position (after FROM/JOIN/UPDATE/INTO),
    // stay silent so the schema source offers table names, not columns.
    const beforeWord = docText.slice(stmt.from, word.from);
    if (TABLE_POSITION_RE.test(beforeWord)) return null;

    const refs = extractReferencedTables(stmt.text);
    if (!refs.length) return null;

    // Match referenced names case-insensitively against the schema (MySQL on
    // Linux is case-sensitive on identifiers, but the user could mix cases in
    // queries; we'd rather over-suggest than miss).
    const schemaLower = new Map();
    for (const t of Object.keys(schema)) schemaLower.set(t.toLowerCase(), t);

    const seen = new Set();
    const options = [];
    for (const { name } of refs) {
      const realName = schemaLower.get(name.toLowerCase());
      if (!realName) continue;
      const cols = schema[realName];
      if (!cols) continue;
      for (const col of cols) {
        const key = `${col}|${realName}`;
        if (seen.has(key)) continue;
        seen.add(key);
        options.push({
          label: col,
          type: 'property',
          detail: realName,
          boost: 1, // rank above plain keywords
        });
      }
    }
    if (!options.length) return null;

    return {
      from: word.from,
      options,
      validFor: /^\w*$/,
    };
  };
}
