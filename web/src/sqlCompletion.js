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
 * Returns an array of { name } for every table referenced in a FROM or JOIN.
 */
export function extractReferencedTables(docText) {
  // Strip comments and string content while preserving structure so a simple
  // /\b(FROM|JOIN)\b/ scan won't be fooled by a `FROM` sitting in a comment
  // or string. Backticked identifiers ARE preserved (we want the table name).
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
  const re = /\b(?:FROM|JOIN)\s+([A-Za-z_][A-Za-z_0-9]*)/gi;
  let m;
  while ((m = re.exec(clean)) !== null) {
    tables.push({ name: m[1] });
  }
  return tables;
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
