/**
 * Verify SQL autocomplete shows table names from the live schema.
 *
 * Picks a database that has many tables, types a fragment of "SELECT * FROM x",
 * triggers Ctrl+Space, and asserts at least one completion option appears.
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

await page.goto(BASE, { waitUntil: 'networkidle' });
await page.waitForSelector('.cm-content', { timeout: 10_000 });
await page.waitForTimeout(2000); // let schema fetch settle

// Wait for schema to actually be loaded — poll for non-empty schema in store
const schemaInfo = await page.evaluate(async () => {
  for (let i = 0; i < 30; i++) {
    const r = await fetch('/api/servers').then((r) => r.json()).catch(() => null);
    if (r) break;
    await new Promise((res) => setTimeout(res, 100));
  }
  return null;
});

// Type into the editor: clear, then start a "FROM " phrase
await page.locator('.cm-content').click();
await page.keyboard.press('Control+A');
await page.keyboard.press('Delete');
await page.keyboard.type('SELECT * FROM ');
// Trigger autocomplete explicitly
await page.keyboard.press('Control+Space');
await page.waitForTimeout(600);

const tooltipVisible = await page.locator('.cm-tooltip-autocomplete').count();
const options = await page.locator('.cm-tooltip-autocomplete li').allInnerTexts().catch(() => []);

console.log('--- schemaInfo (probe) ---');
console.log(schemaInfo);
console.log('--- TABLE autocomplete (SELECT * FROM ⌃Space) ---');
console.log({ tooltipVisible, optionCount: options.length, first10: options.slice(0, 10) });

// --- Column completion test: pick a concrete table, type "table." and see columns ---
const sampleTable = options[0]; // first matched table
if (sampleTable) {
  await page.keyboard.press('Escape');
  await page.keyboard.press('Control+A');
  await page.keyboard.press('Delete');
  await page.keyboard.type(`SELECT  FROM ${sampleTable}`);
  // Move cursor back to after SELECT, then type "<tableName>."
  await page.keyboard.press('Home');
  for (const _c of 'SELECT ') await page.keyboard.press('ArrowRight');
  await page.keyboard.type(`${sampleTable}.`);
  await page.waitForTimeout(400);
  await page.keyboard.press('Control+Space');
  await page.waitForTimeout(600);
  const colTooltip = await page.locator('.cm-tooltip-autocomplete').count();
  const cols = await page.locator('.cm-tooltip-autocomplete li').allInnerTexts().catch(() => []);
  console.log(`--- COLUMN autocomplete (${sampleTable}.⌃Space) ---`);
  console.log({ tooltipVisible: colTooltip, optionCount: cols.length, first10: cols.slice(0, 10) });
}
console.log('--- console (last 10) ---');
console.log(consoleEntries.slice(-10));

await browser.close();
process.exit(tooltipVisible && options.length ? 0 : 1);
