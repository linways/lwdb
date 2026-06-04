/**
 * Two regressions in one run:
 *
 *  CASE 1 — run the statement under the caret (DBeaver-style).
 *    Editor holds two statements. Caret in #1 → Ctrl+Enter runs only #1.
 *    Caret in #2 → runs only #2. No "Run one statement at a time" error.
 *
 *  CASE 2 — after FROM, suggest TABLE names, not columns of a table
 *    referenced in a sibling statement.
 */
import { chromium } from 'playwright';

const BASE = process.env.BASE || 'http://127.0.0.1:5174';
const HEADLESS = process.env.HEADFUL !== '1';

const browser = await chromium.launch({ headless: HEADLESS });
const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
const page = await ctx.newPage();

const queries = [];
page.on('request', (r) => {
  if (r.method() === 'POST' && r.url().endsWith('/api/query')) {
    try { queries.push(JSON.parse(r.postData() || '{}')); } catch (_) { /* ignore */ }
  }
});

await page.goto(BASE, { waitUntil: 'networkidle' });
await page.waitForSelector('.cm-content', { timeout: 10_000 });
await page.waitForTimeout(2000);

// Grab the active db's schema so we can pick a real table + its columns.
const schema = await page.evaluate(async () => {
  const r = await fetch('/api/servers/localdb/databases/CCM/schema').then((x) => x.json());
  return r;
});
const tableNames = Object.keys(schema.tables);
const T = tableNames.find((t) => (schema.tables[t] || []).length >= 2) || tableNames[0];
const cols = schema.tables[T];
const longCol = [...cols].sort((a, b) => b.length - a.length)[0];
const prefix = T.slice(0, Math.min(4, T.length));
console.log(`sample table T=${T}, longCol=${longCol}, prefix=${prefix}`);

async function setDoc(text) {
  await page.locator('.cm-content').click();
  await page.keyboard.press('Control+A');
  await page.keyboard.press('Delete');
  await page.keyboard.type(text);
}

// ---------------- CASE 1 ----------------
queries.length = 0;
await setDoc('SELECT 1 AS a;\nSELECT 2 AS b;');
// Move caret into statement #1 (line 1)
await page.keyboard.press('Control+Home');
await page.keyboard.press('ArrowRight'); // inside "SELECT 1 AS a"
await page.keyboard.press('Control+Enter');
await page.waitForTimeout(800);
const ran1 = queries[queries.length - 1]?.sql || '';
console.log('CASE1 caret-in-#1 ran:', JSON.stringify(ran1));

queries.length = 0;
// Move caret into statement #2 (last line)
await page.keyboard.press('Control+End');
await page.keyboard.press('ArrowLeft');
await page.keyboard.press('Control+Enter');
await page.waitForTimeout(800);
const ran2 = queries[queries.length - 1]?.sql || '';
console.log('CASE1 caret-in-#2 ran:', JSON.stringify(ran2));

const case1ok =
  /SELECT 1 AS a/i.test(ran1) && !/SELECT 2/i.test(ran1) &&
  /SELECT 2 AS b/i.test(ran2) && !/SELECT 1/i.test(ran2);
console.log('CASE1', case1ok ? 'PASS' : 'FAIL');

// ---------------- CASE 2 ----------------
// Sibling statement references T (so its columns are in scope doc-wide),
// then a fresh FROM <prefix> where we expect TABLE names.
await setDoc(`SELECT * FROM ${T};\nSELECT * FROM ${prefix}`);
await page.keyboard.press('Control+End'); // caret right after the prefix
await page.keyboard.press('Control+Space');
await page.waitForTimeout(600);
const opts = await page.locator('.cm-tooltip-autocomplete li').allInnerTexts().catch(() => []);
console.log(`CASE2 options (${opts.length}), first6:`, opts.slice(0, 6));

// A table suggestion for T shows just "T"; a leaked column shows "<col> <T>".
const columnLeaked = opts.some((o) => o.includes(longCol) && o.includes(T));
const hasTableMatch = opts.some((o) => o.toLowerCase().includes(prefix.toLowerCase()));
const case2ok = hasTableMatch && !columnLeaked;
console.log(`CASE2 hasTableMatch=${hasTableMatch} columnLeaked=${columnLeaked} →`, case2ok ? 'PASS' : 'FAIL');

await browser.close();
const ok = case1ok && case2ok;
console.log(ok ? '\n✓ ALL PASS' : '\n✗ FAIL');
process.exit(ok ? 0 : 1);
