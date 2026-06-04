/**
 * The database picker shows a copy button per row. Clicking it copies the
 * db name to the clipboard and does NOT select the db (palette stays open).
 */
import { chromium } from 'playwright';

const BASE = process.env.BASE || 'http://127.0.0.1:5174';
const HEADLESS = process.env.HEADFUL !== '1';

const browser = await chromium.launch({ headless: HEADLESS });
const ctx = await browser.newContext({
  viewport: { width: 1400, height: 900 },
  permissions: ['clipboard-read', 'clipboard-write'],
});
const page = await ctx.newPage();

await page.goto(BASE, { waitUntil: 'networkidle' });
await page.waitForSelector('.cm-content', { timeout: 10_000 });
await page.waitForTimeout(1500);

// Open the database picker via the db chip (2nd chip: srv, db, schema).
const dbChip = page.locator('.chip').nth(1);
const dbChipBefore = (await dbChip.innerText()).replace(/\s+/g, ' ').trim();
await dbChip.click();
await page.waitForSelector('.palette', { timeout: 2000 });
await page.waitForTimeout(300);

// Focus the first db row, grab its name, click its copy button.
const firstRow = page.locator('.palette-item').first();
await firstRow.hover();
const rowText = (await firstRow.innerText()).replace(/\s+/g, ' ').trim();
await firstRow.locator('.copy-btn').click();
await page.waitForTimeout(300);

const paletteStillOpen = await page.locator('.palette').count();
const clip = await page.evaluate(() => navigator.clipboard.readText());
const toast = await page.locator('.toast').count();

console.log({ rowText, clip, paletteStillOpen, dbChipBefore, toast });

await browser.close();

const ok =
  paletteStillOpen === 1 &&            // copy did NOT activate/close
  clip && rowText.includes(clip);      // clipboard holds the row's db name
console.log(ok ? '\n✓ PASS' : '\n✗ FAIL');
process.exit(ok ? 0 : 1);
