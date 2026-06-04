/**
 * Reproduce: clicking a non-localhost server in the palette appears to do nothing.
 *
 * Steps:
 *   1. Open palette via Cmd+K.
 *   2. Switch to "pickServer" mode by clicking the srv chip.
 *   3. Click V4-server84 (or V3-server63 if 84 missing).
 *   4. Observe: does store.currentServer change? does palette close? does the
 *      srv chip update? are network requests sent?
 */
import { chromium } from 'playwright';

const BASE = process.env.BASE || 'http://127.0.0.1:5173';
const HEADLESS = process.env.HEADFUL !== '1';
const TARGET = process.env.TARGET_SERVER || 'V3-server63';

const browser = await chromium.launch({ headless: HEADLESS });
const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
const page = await ctx.newPage();

const requests = [];
const consoleEntries = [];
page.on('console', (msg) => consoleEntries.push({ type: msg.type(), text: msg.text() }));
page.on('pageerror', (err) => consoleEntries.push({ type: 'pageerror', text: err.message }));
page.on('request', (r) => {
  if (r.url().includes('/api/')) requests.push({ method: r.method(), url: r.url() });
});

await page.goto(BASE, { waitUntil: 'networkidle' });
await page.waitForSelector('.topbar', { timeout: 10_000 });
await page.waitForTimeout(2000); // let init settle on localdb

console.log('=== INITIAL ===');
console.log('srv chip:', await page.locator('.chip').nth(0).innerText());
console.log('db chip:', await page.locator('.chip').nth(1).innerText());

// Click the srv chip → opens palette in pickServer mode
await page.locator('.chip').nth(0).click();
await page.waitForTimeout(400);
const paletteOpen = await page.locator('.palette').count();
console.log('palette open after srv chip click:', paletteOpen);

// Get the list of server items in the palette
const items = await page.locator('.palette-item').allInnerTexts();
console.log('palette items:', items.slice(0, 10));

requests.length = 0;
// Click target server
const targetItem = page.locator('.palette-item').filter({ hasText: TARGET });
const targetCount = await targetItem.count();
console.log(`target item "${TARGET}" count:`, targetCount);
await targetItem.first().click();
await page.waitForTimeout(3000);

console.log('=== AFTER CLICK ===');
const paletteStillOpen = await page.locator('.palette').count();
console.log('palette still open:', paletteStillOpen);
console.log('srv chip:', await page.locator('.chip').nth(0).innerText());
console.log('db chip:', await page.locator('.chip').nth(1).innerText());

const apiCalls = requests.filter((r) => r.url.includes('/api/'));
console.log('api calls after click:');
apiCalls.forEach((c) => console.log(`  ${c.method} ${c.url}`));

console.log('--- console (last 10) ---');
consoleEntries.slice(-10).forEach((e) => console.log(`  [${e.type}] ${e.text}`));

await browser.close();
