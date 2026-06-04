/**
 * Column autocomplete must work across all DML forms, not just SELECT…FROM:
 *   - UPDATE <t> SET <caret>            → t's columns
 *   - UPDATE <t> SET x=1 WHERE <caret>  → t's columns
 *   - INSERT INTO <t> (<caret>)         → t's columns
 *   - DELETE FROM <t> WHERE <caret>     → t's columns
 *   - SELECT <caret> FROM <t>           → t's columns (baseline)
 * And after the table keyword itself (UPDATE <caret>) it should offer TABLES.
 */
import { chromium } from 'playwright';

const BASE = process.env.BASE || 'http://127.0.0.1:4321';
const HEADLESS = process.env.HEADFUL !== '1';

const browser = await chromium.launch({ headless: HEADLESS });
const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
const page = await ctx.newPage();

await page.goto(BASE, { waitUntil: 'networkidle' });
await page.waitForSelector('.cm-content', { timeout: 10_000 });
await page.waitForTimeout(1500);

// Pick a real table + its columns from the active db's schema.
const schema = await page.evaluate(() =>
  fetch('/api/servers/localdb/databases/CCM/schema').then((r) => r.json()));
const T = Object.keys(schema.tables).find((t) => (schema.tables[t] || []).length >= 2);
const cols = schema.tables[T];
const colSet = new Set(cols);
console.log(`table=${T}, cols(${cols.length}) e.g. ${cols.slice(0, 3).join(', ')}`);

// Type `prefix`, then optionally move caret left by `back` chars, Ctrl+Space,
// and return the completion option labels.
async function suggestionsFor(text, back = 0) {
  await page.locator('.cm-content').click();
  await page.keyboard.press('Control+A');
  await page.keyboard.press('Delete');
  await page.keyboard.type(text);
  for (let i = 0; i < back; i++) await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('Control+Space');
  await page.waitForTimeout(450);
  // option label is the first token of each row's text
  const opts = await page.locator('.cm-tooltip-autocomplete li').allInnerTexts().catch(() => []);
  await page.keyboard.press('Escape');
  return opts.map((o) => o.trim());
}

// A column suggestion renders as label(col) + detail(table). allInnerTexts may
// concatenate them ("createdByDLRules"), so strip the table-name suffix and
// also accept a bare column label.
function columnHits(opts) {
  return opts.filter((o) => {
    const flat = o.replace(/\s+/g, '');
    if (flat.endsWith(T)) {
      const cand = flat.slice(0, flat.length - T.length);
      if (colSet.has(cand)) return true;
    }
    return colSet.has(flat);
  }).length;
}

const cases = [
  { name: 'UPDATE … SET <caret>',          text: `UPDATE ${T} SET `,                 back: 0, want: 'cols' },
  { name: 'UPDATE … WHERE <caret>',        text: `UPDATE ${T} SET x = 1 WHERE `,     back: 0, want: 'cols' },
  { name: 'INSERT INTO t (<caret>)',       text: `INSERT INTO ${T} ()`,              back: 1, want: 'cols' },
  { name: 'DELETE FROM t WHERE <caret>',   text: `DELETE FROM ${T} WHERE `,          back: 0, want: 'cols' },
  { name: 'SELECT <caret> FROM t',         text: `SELECT  FROM ${T}`,                back: (` FROM ${T}`).length, want: 'cols' },
];

let allOk = true;
for (const c of cases) {
  const opts = await suggestionsFor(c.text, c.back);
  const hits = columnHits(opts);
  const ok = c.want === 'cols' ? hits > 0 : true;
  if (!ok) allOk = false;
  console.log(`${ok ? '✓' : '✗'} ${c.name}  → ${hits} column hit(s); first: ${opts.slice(0, 4).join(' | ')}`);
}

// Table position after UPDATE should offer TABLES, not columns.
const afterUpdate = await suggestionsFor(`UPDATE ${T.slice(0, 3)}`, 0);
const afterUpdateHasTable = afterUpdate.some((o) => o.toLowerCase().includes(T.slice(0, 3).toLowerCase()));
const afterUpdateLeaksCols = columnHits(afterUpdate) > 0;
const tableOk = afterUpdateHasTable && !afterUpdateLeaksCols;
if (!tableOk) allOk = false;
console.log(`${tableOk ? '✓' : '✗'} UPDATE <caret> offers tables (hasTable=${afterUpdateHasTable} leaksCols=${afterUpdateLeaksCols})`);

await browser.close();
console.log(allOk ? '\n✓ ALL PASS' : '\n✗ FAIL');
process.exit(allOk ? 0 : 1);
