/**
 * Verify the localStorage schema cache:
 *   1. Clear all cached schemas → load page → first db pick should HIT /schema.
 *   2. Reload page → same db should be auto-selected → /schema NOT hit.
 *   3. Click the refresh chip → /schema IS hit again.
 */
import { chromium } from 'playwright';

const BASE = process.env.BASE || 'http://127.0.0.1:5173';
const HEADLESS = process.env.HEADFUL !== '1';

const browser = await chromium.launch({ headless: HEADLESS });
const ctx = await browser.newContext({
  viewport: { width: 1400, height: 900 },
});
const page = await ctx.newPage();

let schemaCallCount = 0;
const schemaCalls = [];
page.on('request', (r) => {
  if (r.url().includes('/schema')) {
    schemaCallCount++;
    schemaCalls.push(r.url());
  }
});

// --- 1) Cold load — clear cache first ---
await page.goto(BASE, { waitUntil: 'domcontentloaded' });
await page.evaluate(() => {
  for (let i = localStorage.length - 1; i >= 0; i--) {
    const k = localStorage.key(i);
    if (k && k.startsWith('lwdb:schema:')) localStorage.removeItem(k);
  }
});

// Reload after clearing so init() runs fresh
schemaCallCount = 0;
schemaCalls.length = 0;
await page.reload({ waitUntil: 'networkidle' });
await page.waitForSelector('.cm-content', { timeout: 10_000 });
await page.waitForTimeout(2000);

const coldCalls = schemaCallCount;
console.log(`cold load: ${coldCalls} /schema call(s)`);

// --- 2) Warm reload — same db should not re-fetch ---
schemaCallCount = 0;
schemaCalls.length = 0;
await page.reload({ waitUntil: 'networkidle' });
await page.waitForSelector('.cm-content', { timeout: 10_000 });
await page.waitForTimeout(1500);

const warmCalls = schemaCallCount;
console.log(`warm reload: ${warmCalls} /schema call(s)`);

// Check the cache indicator is visible (cache-dot on the schema chip)
const cacheDotCount = await page.locator('.schema-chip .cache-dot').count();
console.log(`schema chip shows cached indicator: ${cacheDotCount > 0}`);

// --- 3) Click refresh chip → expect a /schema call ---
schemaCallCount = 0;
schemaCalls.length = 0;
await page.locator('.schema-chip').click();
await page.waitForTimeout(1200);
const refreshCalls = schemaCallCount;
console.log(`after refresh click: ${refreshCalls} /schema call(s)`);

// Verify autocomplete still works after cache hit
await page.locator('.cm-content').click();
await page.keyboard.press('Control+A');
await page.keyboard.press('Delete');
await page.keyboard.type('SELECT * FROM ');
await page.keyboard.press('Control+Space');
await page.waitForTimeout(500);
const options = await page.locator('.cm-tooltip-autocomplete li').allInnerTexts().catch(() => []);
console.log(`autocomplete after cache hit: ${options.length} options · first: ${options[0]}`);

await browser.close();

const ok =
  coldCalls >= 1 &&
  warmCalls === 0 &&
  refreshCalls >= 1 &&
  options.length > 0 &&
  cacheDotCount > 0;

console.log(ok ? '\n✓ PASS' : '\n✗ FAIL');
process.exit(ok ? 0 : 1);
