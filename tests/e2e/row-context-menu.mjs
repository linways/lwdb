/**
 * Verify the row right-click context menu generates correct SQL.
 *
 *  1. Pick a table that has a primary key (we ask schema endpoint).
 *  2. Run SELECT * FROM <table> LIMIT 1.
 *  3. Right-click the row.
 *  4. Click "Copy as INSERT" → assert clipboard has INSERT INTO `table` ...
 *  5. Repeat for UPDATE and DELETE → assert WHERE uses the PK col.
 */
import { chromium } from 'playwright';

const BASE = process.env.BASE || 'http://127.0.0.1:5173';
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

// Force a fresh schema fetch (so it has primaryKeys)
await page.evaluate(() => {
  for (let i = localStorage.length - 1; i >= 0; i--) {
    const k = localStorage.key(i);
    if (k && k.startsWith('lwdb:schema:')) localStorage.removeItem(k);
  }
});
await page.reload({ waitUntil: 'networkidle' });
await page.waitForSelector('.cm-content', { timeout: 10_000 });
await page.waitForTimeout(2000);

// Find a table with a single-column primary key via schema
const target = await page.evaluate(async () => {
  const res = await fetch('/api/servers/localdb/databases/CCM/schema');
  const j = await res.json();
  const pks = j.primaryKeys || {};
  for (const [name, cols] of Object.entries(pks)) {
    if (cols.length === 1 && j.tables[name]?.length >= 2) return { name, pk: cols[0], cols: j.tables[name] };
  }
  return null;
});
console.log('target:', target);
if (!target) { console.log('no suitable table found'); await browser.close(); process.exit(0); }

await page.locator('.cm-content').click();
await page.keyboard.press('Control+A');
await page.keyboard.press('Delete');
await page.keyboard.type(`SELECT * FROM ${target.name} LIMIT 1`);
await page.keyboard.press('Control+Enter');
await page.waitForTimeout(1500);

const row = page.locator('.grid tbody tr').first();
const rowCount = await page.locator('.grid tbody tr').count();
console.log('row count:', rowCount);
if (!rowCount) { console.log('no rows returned, cant test'); await browser.close(); process.exit(1); }

async function pickMenuItem(label) {
  await row.click({ button: 'right' });
  await page.waitForSelector('.context-menu', { timeout: 2000 });
  await page.locator('.ctx-item', { hasText: label }).first().click();
  await page.waitForTimeout(300);
  return await page.evaluate(() => navigator.clipboard.readText());
}

const insertSql = await pickMenuItem('Copy as INSERT');
console.log('--- INSERT ---'); console.log(insertSql);

const updateSql = await pickMenuItem('Copy as UPDATE');
console.log('--- UPDATE ---'); console.log(updateSql);

const deleteSql = await pickMenuItem('Copy as DELETE');
console.log('--- DELETE ---'); console.log(deleteSql);

await browser.close();

const ok =
  insertSql.startsWith(`INSERT INTO \`${target.name}\``) &&
  updateSql.startsWith(`UPDATE \`${target.name}\``) &&
  updateSql.includes(`WHERE \`${target.pk}\` =`) &&
  deleteSql.startsWith(`DELETE FROM \`${target.name}\``) &&
  deleteSql.includes(`WHERE \`${target.pk}\` =`);

console.log(ok ? '\n✓ PASS' : '\n✗ FAIL');
process.exit(ok ? 0 : 1);
