/**
 * Recently-used databases: picking a db records it per-server, and the db
 * picker surfaces a "Recently used" group (existing dbs only) above the full
 * list. Also asserts the top-bar copy-chip copies the selected db name.
 *
 * Needs a reachable server whose db list loads. Override with SERVER= to pick
 * a specific one (default: the first server's auto-selected db).
 */
import { chromium } from 'playwright';

const BASE = process.env.BASE || 'http://127.0.0.1:5174';
const browser = await chromium.launch({ headless: process.env.HEADFUL !== '1' });
const ctx = await browser.newContext({
  viewport: { width: 1400, height: 900 },
  permissions: ['clipboard-read', 'clipboard-write'],
});
const page = await ctx.newPage();
await page.goto(BASE, { waitUntil: 'networkidle' });
await page.waitForSelector('.cm-content', { timeout: 10_000 });
await page.waitForTimeout(1500);

let ok = true;
const check = (c, m) => { console.log(`${c ? '✓' : '✗'} ${m}`); if (!c) ok = false; };

// Open the db picker and pick the first database.
await page.locator('.chip').nth(1).click();
await page.waitForSelector('.palette', { timeout: 2000 });
await page.waitForTimeout(400);
const firstRow = page.locator('.palette-item').first();
const dbName = (await firstRow.innerText()).replace(/[↺▣⧉]/g, '').replace(/\s+/g, ' ').trim();
await firstRow.click();
await page.waitForTimeout(1200);

// Top-bar copy-chip should now exist and copy the db name.
const copyChip = page.locator('.copy-chip');
check(await copyChip.count() === 1, 'top-bar copy-chip present after selecting a db');
await copyChip.click();
await page.waitForTimeout(300);
const clip = await page.evaluate(() => navigator.clipboard.readText());
check(!!clip && dbName.includes(clip), `copy-chip copied the db name (${clip})`);

// Re-open the picker: a "Recently used" group should list the db we just picked.
await page.locator('.chip').nth(1).click();
await page.waitForSelector('.palette', { timeout: 2000 });
await page.waitForTimeout(400);
const groups = await page.locator('.palette-group').allInnerTexts();
check(groups.some((t) => /recently used/i.test(t)), `"Recently used" group shown (${groups.join(' | ')})`);

const topRow = page.locator('.palette-item').first();
const topText = (await topRow.innerText()).replace(/\s+/g, ' ').trim();
check(topText.includes(clip), `recent group's first row is the picked db (${topText})`);

// copy-btn sits before .meta in DOM order (next to the name, not far-right).
const order = await topRow.evaluate((el) => {
  const kids = [...el.children];
  return { copy: kids.findIndex((k) => k.classList.contains('copy-btn')), meta: kids.findIndex((k) => k.classList.contains('meta')) };
});
check(order.copy > -1 && order.meta > -1 && order.copy < order.meta, `copy-btn before .meta (copy@${order.copy}, meta@${order.meta})`);

await browser.close();
console.log(ok ? '\n✓ ALL PASS' : '\n✗ FAIL');
process.exit(ok ? 0 : 1);
