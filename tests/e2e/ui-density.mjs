/**
 * UI density: the Settings → General "Interface size" select sets
 * <html data-density> and scales the app shell via zoom. The choice persists
 * across reloads. Self-contained — needs no database connection.
 */
import { chromium } from 'playwright';

const BASE = process.env.BASE || 'http://127.0.0.1:5174';
const browser = await chromium.launch({ headless: process.env.HEADFUL !== '1' });
const page = await (await browser.newContext()).newPage();
await page.goto(BASE, { waitUntil: 'networkidle' });
await page.waitForSelector('.cm-content', { timeout: 10_000 });
await page.waitForTimeout(500);

let ok = true;
const check = (c, m) => { console.log(`${c ? '✓' : '✗'} ${m}`); if (!c) ok = false; };

// Open settings (Cmd/Ctrl+,) and switch interface size to "large".
await page.keyboard.press('Control+,');
await page.waitForSelector('.settings-modal', { timeout: 2000 });
await page.waitForTimeout(200);
const densitySelect = page.locator('.settings-pane .row', { hasText: 'Interface size' }).locator('select');
await densitySelect.selectOption('large');
await page.waitForTimeout(300);

const after = await page.evaluate(() => ({
  attr: document.documentElement.getAttribute('data-density'),
  zoom: getComputedStyle(document.querySelector('.app')).zoom,
}));
check(after.attr === 'large', `data-density set to large (${after.attr})`);
check(after.zoom && after.zoom !== '1' && after.zoom !== 'normal', `.app zoom applied (${after.zoom})`);

// Persists across reload.
await page.reload({ waitUntil: 'networkidle' });
await page.waitForTimeout(600);
const persisted = await page.evaluate(() => document.documentElement.getAttribute('data-density'));
check(persisted === 'large', `density persisted across reload (${persisted})`);

await browser.close();
console.log(ok ? '\n✓ ALL PASS' : '\n✗ FAIL');
process.exit(ok ? 0 : 1);
