/**
 * Verify the results pane hide/show behaviour:
 *   1. Run a query → results pane visible
 *   2. Click `×` on results toolbar → pane hidden, "show results" bar visible
 *   3. Click the bar → pane visible again
 *   4. Hide, then run another query → pane auto-restores
 */
import { chromium } from 'playwright';

const BASE = process.env.BASE || 'http://127.0.0.1:5173';
const HEADLESS = process.env.HEADFUL !== '1';

const browser = await chromium.launch({ headless: HEADLESS });
const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
const page = await ctx.newPage();

await page.goto(BASE, { waitUntil: 'networkidle' });
await page.waitForSelector('.cm-content', { timeout: 10_000 });
await page.waitForTimeout(2000);

// Run a query
await page.locator('.cm-content').click();
await page.keyboard.press('Control+A');
await page.keyboard.press('Delete');
await page.keyboard.type('SELECT 1 AS r');
await page.keyboard.press('Control+Enter');
await page.waitForTimeout(800);

const visibleAfterRun = await page.locator('.results-pane').count();
const showBarAfterRun = await page.locator('.show-results-bar').count();
console.log('after run:', { resultsPane: visibleAfterRun, showBar: showBarAfterRun });

// Hide
await page.locator('.results-toolbar .action.close').click();
await page.waitForTimeout(300);
const visibleAfterHide = await page.locator('.results-pane').count();
const showBarAfterHide = await page.locator('.show-results-bar').count();
const showBarText = showBarAfterHide ? await page.locator('.show-results-bar').innerText() : null;
console.log('after hide:', { resultsPane: visibleAfterHide, showBar: showBarAfterHide, showBarText });

// Click show bar
await page.locator('.show-results-bar').click();
await page.waitForTimeout(300);
const visibleAfterShow = await page.locator('.results-pane').count();
const showBarAfterShow = await page.locator('.show-results-bar').count();
console.log('after show click:', { resultsPane: visibleAfterShow, showBar: showBarAfterShow });

// Hide again, then run a new query — should auto-restore
await page.locator('.results-toolbar .action.close').click();
await page.waitForTimeout(200);
await page.keyboard.press('Control+Enter');
await page.waitForTimeout(800);
const visibleAfterRerun = await page.locator('.results-pane').count();
const showBarAfterRerun = await page.locator('.show-results-bar').count();
console.log('after re-run while hidden:', { resultsPane: visibleAfterRerun, showBar: showBarAfterRerun });

await browser.close();

const ok =
  visibleAfterRun === 1 && showBarAfterRun === 0 &&
  visibleAfterHide === 0 && showBarAfterHide === 1 &&
  visibleAfterShow === 1 && showBarAfterShow === 0 &&
  visibleAfterRerun === 1 && showBarAfterRerun === 0;
console.log(ok ? '\n✓ PASS' : '\n✗ FAIL');
process.exit(ok ? 0 : 1);
