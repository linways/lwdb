/**
 * Regression for the reported bug: caret on the UPDATE line (incl. at/after its
 * `;`) must run the UPDATE, not the following statement.
 *
 * Mirrors the screenshot: SELECT; <blank> UPDATE; <blank> SELECT;
 */
import { chromium } from 'playwright';

const BASE = process.env.BASE || 'http://127.0.0.1:4321';
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
await page.waitForTimeout(1200);

const DOC = 'SELECT 1 AS a;\n\nUPDATE notexist_xyz SET x = 1;\n\nSELECT 3 AS c;';

async function typeDoc() {
  await page.locator('.cm-content').click();
  await page.keyboard.press('Control+A');
  await page.keyboard.press('Delete');
  await page.keyboard.type(DOC);
}

async function runAndGetSql() {
  queries.length = 0;
  await page.keyboard.press('Control+Enter');
  await page.waitForTimeout(700);
  return (queries[queries.length - 1]?.sql || '').trim();
}

// Case 1: caret at END of the UPDATE line (after the `;`) — the exact bug.
await typeDoc();
await page.keyboard.press('Control+Home');
await page.keyboard.press('ArrowDown');
await page.keyboard.press('ArrowDown'); // line 3 (UPDATE)
await page.keyboard.press('End');       // after the `;`
const endOfLine = await runAndGetSql();
console.log('caret at end of UPDATE line →', JSON.stringify(endOfLine));

// Case 2: caret in the MIDDLE of the UPDATE keyword.
await typeDoc();
await page.keyboard.press('Control+Home');
await page.keyboard.press('ArrowDown');
await page.keyboard.press('ArrowDown');
await page.keyboard.press('ArrowRight');
await page.keyboard.press('ArrowRight');
await page.keyboard.press('ArrowRight'); // UPD|ATE
const midWord = await runAndGetSql();
console.log('caret mid-UPDATE →', JSON.stringify(midWord));

// Case 3: caret on the first SELECT line still runs statement 1.
await typeDoc();
await page.keyboard.press('Control+Home');
await page.keyboard.press('ArrowRight');
const firstLine = await runAndGetSql();
console.log('caret on line 1 →', JSON.stringify(firstLine));

await browser.close();

const ok =
  /^UPDATE\b/i.test(endOfLine) &&
  /^UPDATE\b/i.test(midWord) &&
  /^SELECT 1\b/i.test(firstLine);
console.log(ok ? '\n✓ PASS' : '\n✗ FAIL');
process.exit(ok ? 0 : 1);
