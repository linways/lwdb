/**
 * Verify the Settings modal:
 *   1. Open via gear button
 *   2. Switch to Results tab, change "NULL displayed as" → dash
 *   3. Close, run SELECT NULL, see "—" instead of "NULL"
 *   4. Open via Cmd+, shortcut
 *   5. Switch to Editor, change font size to 18 — visible in the editor
 *   6. Reload page — prefs persist (font size is still 18)
 */
import { chromium } from 'playwright';

const BASE = process.env.BASE || 'http://127.0.0.1:5173';
const HEADLESS = process.env.HEADFUL !== '1';

const browser = await chromium.launch({ headless: HEADLESS });
const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
const page = await ctx.newPage();

await page.goto(BASE, { waitUntil: 'networkidle' });
await page.evaluate(() => localStorage.removeItem('lwdb:prefs:v1'));
await page.reload({ waitUntil: 'networkidle' });
await page.waitForSelector('.cm-content', { timeout: 10_000 });
await page.waitForTimeout(1500);

// 1. Open via gear button
await page.locator('.gear-btn').click();
const visible1 = await page.locator('.settings-modal').count();
console.log('1. gear button opens settings:', visible1 === 1);

// 2. Results tab → null display = dash
await page.locator('.settings-tab', { hasText: 'Results' }).click();
await page.locator('.settings-pane select').selectOption('dash');

// 3. Close, run SELECT NULL, expect "—"
await page.locator('.btn.primary', { hasText: 'Done' }).click();
await page.waitForTimeout(200);
await page.locator('.cm-content').click();
await page.keyboard.press('Control+A');
await page.keyboard.press('Delete');
await page.keyboard.type('SELECT NULL AS n');
await page.keyboard.press('Control+Enter');
await page.waitForTimeout(800);
const cellText = await page.locator('.grid tbody td').first().innerText();
console.log(`3. NULL displayed as: "${cellText}"  (expected: "—")`);

// 4. Cmd+, opens settings again
await page.keyboard.press('Control+,');
const visible2 = await page.locator('.settings-modal').count();
console.log('4. Cmd+, opens settings:', visible2 === 1);

// 5. Editor tab, change font size to 18
await page.locator('.settings-tab', { hasText: 'Editor' }).click();
const fontInput = page.locator('.settings-pane input[type="number"]').first();
await fontInput.fill('18');
await page.locator('.btn.primary', { hasText: 'Done' }).click();
await page.waitForTimeout(200);

// font size only applies when the editor is rebuilt — open a new tab so it picks up
await page.locator('.tab-add').click();
await page.waitForTimeout(300);
const fontSize = await page.evaluate(() => {
  const cm = document.querySelector('.cm-editor');
  return cm ? getComputedStyle(cm).fontSize : null;
});
console.log(`5. editor fontSize after change + new tab: ${fontSize} (expected: 18px)`);

// 6. Reload, font size persists
await page.reload({ waitUntil: 'networkidle' });
await page.waitForSelector('.cm-content', { timeout: 10_000 });
await page.waitForTimeout(1500);
await page.locator('.tab-add').click();
await page.waitForTimeout(300);
const fontSizeAfterReload = await page.evaluate(() => {
  const cm = document.querySelector('.cm-editor');
  return cm ? getComputedStyle(cm).fontSize : null;
});
console.log(`6. fontSize after reload: ${fontSizeAfterReload} (expected: 18px)`);

await browser.close();
const ok = visible1 === 1 && cellText === '—' && visible2 === 1 &&
           fontSize === '18px' && fontSizeAfterReload === '18px';
console.log(ok ? '\n✓ PASS' : '\n✗ FAIL');
process.exit(ok ? 0 : 1);
