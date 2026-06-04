/**
 * Verify Ctrl+Enter:
 *   - Runs the active query exactly once
 *   - Does NOT insert a blank line in the editor
 *   - Editor SQL contents are unchanged after the run
 */
import { chromium } from 'playwright';

const BASE = process.env.BASE || 'http://127.0.0.1:5173';
const HEADLESS = process.env.HEADFUL !== '1';

const browser = await chromium.launch({ headless: HEADLESS });
const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
const page = await ctx.newPage();

let queryCalls = 0;
page.on('request', (r) => {
  if (r.method() === 'POST' && r.url().endsWith('/api/query')) queryCalls++;
});

await page.goto(BASE, { waitUntil: 'networkidle' });
await page.waitForSelector('.cm-content', { timeout: 10_000 });
await page.waitForTimeout(1500);

const SQL = 'SELECT 1+1 AS r';
await page.locator('.cm-content').click();
await page.keyboard.press('Control+A');
await page.keyboard.press('Delete');
await page.keyboard.type(SQL);

const sqlBefore = await page.locator('.cm-content').innerText();
queryCalls = 0;
await page.keyboard.press('Control+Enter');
await page.waitForTimeout(1000);
const sqlAfter = await page.locator('.cm-content').innerText();

console.log({ sqlBefore: JSON.stringify(sqlBefore), sqlAfter: JSON.stringify(sqlAfter), queryCalls });

// Wait for results to render
const gridRows = await page.locator('.grid tbody tr').count();
console.log({ gridRows });

await browser.close();

const ok = sqlBefore === sqlAfter && queryCalls === 1 && gridRows === 1;
console.log(ok ? '\n✓ PASS' : '\n✗ FAIL');
process.exit(ok ? 0 : 1);
