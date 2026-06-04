/**
 * Cell-level value actions in the result grid:
 *   - double-click a JSON cell → value viewer opens, pretty-prints the JSON
 *   - "Copy formatted" puts indented JSON on the clipboard
 *   - right-click a cell → "Copy <col>" copies just that cell's raw value
 */
import { chromium } from 'playwright';

const BASE = process.env.BASE || 'http://127.0.0.1:4321';
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

// Run a query that returns a JSON column (ec_rule.rule on CCM).
await page.locator('.cm-content').click();
await page.keyboard.press('Control+A');
await page.keyboard.press('Delete');
await page.keyboard.type('SELECT id, name, rule FROM ec_rule WHERE rule IS NOT NULL LIMIT 5');
await page.keyboard.press('Control+Enter');
await page.waitForSelector('.grid tbody tr', { timeout: 8000 });
await page.waitForTimeout(500);

// The 3rd column (rule) of the first row holds JSON — double-click it.
const ruleCell = page.locator('.grid tbody tr').first().locator('td').nth(2);
await ruleCell.dblclick();
await page.waitForSelector('.value-viewer', { timeout: 2000 });

const tag = (await page.locator('.value-viewer .vv-tag').innerText()).trim();
const pretty = await page.locator('.value-viewer pre').innerText();
const isMultiline = pretty.includes('\n');     // pretty JSON spans lines
const parses = (() => { try { JSON.parse(pretty); return true; } catch { return false; } })();
console.log({ tag, isMultiline, parses, firstLine: pretty.split('\n')[0] });

// Copy formatted JSON
await page.locator('.btn', { hasText: 'Copy formatted' }).click();
await page.waitForTimeout(200);
const clipFormatted = await page.evaluate(() => navigator.clipboard.readText());
const clipParses = (() => { try { JSON.parse(clipFormatted); return true; } catch { return false; } })();

// Close the viewer
await page.locator('.value-viewer .btn.primary').click();
await page.waitForTimeout(150);

// Right-click the name cell → "Copy name"
const nameCell = page.locator('.grid tbody tr').first().locator('td').nth(1);
const nameText = (await nameCell.innerText()).trim();
await nameCell.click({ button: 'right' });
await page.waitForSelector('.ctx-item, .context-menu-item, [class*="ctx"], .palette-item', { timeout: 1500 }).catch(() => {});
await page.waitForTimeout(200);
// The menu item label is "Copy name"
await page.getByText('Copy name', { exact: false }).first().click();
await page.waitForTimeout(200);
const clipCell = await page.evaluate(() => navigator.clipboard.readText());

console.log({ nameText, clipCell, clipFormattedParses: clipParses });

await browser.close();

const ok =
  tag === 'JSON' && isMultiline && parses &&
  clipParses &&
  clipCell === nameText;
console.log(ok ? '\n✓ PASS' : '\n✗ FAIL');
process.exit(ok ? 0 : 1);
