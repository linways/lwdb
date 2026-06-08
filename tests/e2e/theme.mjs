/**
 * Theme toggle: clicking the top-bar toggle flips <html data-theme> and the
 * computed --bg, and restyles the editor surface.
 */
import { chromium } from 'playwright';

const BASE = process.env.BASE || 'http://127.0.0.1:4321';
const browser = await chromium.launch({ headless: process.env.HEADFUL !== '1' });
const page = await (await browser.newContext()).newPage();
await page.goto(BASE, { waitUntil: 'networkidle' });
await page.waitForSelector('.cm-content', { timeout: 10_000 });
await page.waitForTimeout(500);

const read = () => page.evaluate(() => ({
  theme: document.documentElement.getAttribute('data-theme'),
  bg: getComputedStyle(document.documentElement).getPropertyValue('--bg').trim(),
}));

const before = await read();
await page.locator('.theme-toggle').click();
await page.waitForTimeout(300);
const after = await read();

let ok = true;
const check = (c, m) => { console.log(`${c ? '✓' : '✗'} ${m}`); if (!c) ok = false; };
check(before.theme && after.theme && before.theme !== after.theme, `data-theme flipped (${before.theme} → ${after.theme})`);
check(before.bg && after.bg && before.bg !== after.bg, `--bg changed (${before.bg} → ${after.bg})`);
check(['dark', 'light'].includes(after.theme), `resolved to a known theme (${after.theme})`);

await browser.close();
console.log(ok ? '\n✓ ALL PASS' : '\n✗ FAIL');
process.exit(ok ? 0 : 1);
