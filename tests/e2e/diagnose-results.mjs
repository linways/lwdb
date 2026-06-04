/**
 * Diagnose the "successful query shows nothing" bug.
 *
 * Drives the SPA, runs a SELECT 1+1 on localdb, and dumps:
 *  - tab.result after the query (via window hooks if exposed, else DOM)
 *  - what the results pane actually contains in the DOM
 *  - console errors
 *  - network response
 */
import { chromium } from 'playwright';

const BASE = process.env.BASE || 'http://127.0.0.1:5173';
const HEADLESS = process.env.HEADFUL !== '1';

const browser = await chromium.launch({ headless: HEADLESS });
const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
const page = await ctx.newPage();

const consoleEntries = [];
page.on('console', (msg) => consoleEntries.push({ type: msg.type(), text: msg.text() }));
page.on('pageerror', (err) => consoleEntries.push({ type: 'pageerror', text: err.message }));

const requests = [];
page.on('request', (r) => {
  if (r.url().includes('/api/')) requests.push({ method: r.method(), url: r.url() });
});
const responses = [];
page.on('response', async (r) => {
  if (r.url().includes('/api/query') || r.url().includes('/api/snippets/') && r.request().method() === 'POST') {
    try {
      const body = await r.text();
      responses.push({ status: r.status(), url: r.url(), bodyPreview: body.slice(0, 400) });
    } catch (_) { /* ignore */ }
  }
});

console.log(`opening ${BASE}`);
await page.goto(BASE, { waitUntil: 'networkidle' });

// Wait for initial connection setup
await page.waitForSelector('.topbar', { timeout: 10_000 });
await page.waitForTimeout(1500); // let init() finish

// Confirm we have a server picked
const srvLabel = await page.locator('.chip').nth(0).innerText();
const dbLabel = await page.locator('.chip').nth(1).innerText();
console.log('topbar after init:', { srvLabel, dbLabel });

// Replace the editor SQL with a simple query.
// CodeMirror is hard to drive with `fill`, so we'll set the doc programmatically
// via Vue store if exposed, else use Ctrl+A + Type.
await page.locator('.cm-content').click();
await page.keyboard.press('Control+A');
await page.keyboard.type('SELECT 1+1 AS r');
await page.waitForTimeout(200);

// Click Run
const runButton = page.locator('button.btn.primary');
await runButton.click();
await page.waitForTimeout(1500); // wait for query result

// Capture state
const errorRow = await page.locator('.error-row').count();
const emptyState = await page.locator('.empty-state').count();
const gridWrap = await page.locator('.grid-wrap').count();
const gridRows = await page.locator('.grid tbody tr').count();
const toastVisible = await page.locator('.toast').count();
const toastText = toastVisible ? await page.locator('.toast').innerText() : null;

// Inspect computed sizes
const sizes = await page.evaluate(() => {
  const pane = document.querySelector('.results-pane');
  const wrap = document.querySelector('.grid-wrap');
  const tbody = document.querySelector('.grid tbody');
  return {
    pane: pane ? { w: pane.clientWidth, h: pane.clientHeight, scrollH: pane.scrollHeight } : null,
    gridWrap: wrap ? { w: wrap.clientWidth, h: wrap.clientHeight, scrollH: wrap.scrollHeight } : null,
    tbody: tbody ? { w: tbody.clientWidth, h: tbody.clientHeight, rows: tbody.children.length } : null,
  };
});

// Try to extract Vue tab state via window — not exposed by default, so look at DOM hints
const hints = await page.evaluate(() => {
  const grid = document.querySelector('.grid');
  return {
    gridHTML: grid ? grid.outerHTML.slice(0, 600) : null,
  };
});

console.log('--- counts ---');
console.log({ errorRow, emptyState, gridWrap, gridRows, toastVisible, toastText });
console.log('--- sizes ---');
console.log(sizes);
console.log('--- grid html preview ---');
console.log(hints.gridHTML);
console.log('--- requests ---');
console.log(requests);
console.log('--- /api/query responses ---');
console.log(responses);
console.log('--- console ---');
console.log(consoleEntries.slice(-20));

await browser.close();
