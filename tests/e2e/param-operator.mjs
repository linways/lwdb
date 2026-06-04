/**
 * Verify the per-parameter operator toggle:
 *   1. Push a snippet via the API: WHERE name = :name AND trashed IS NULL
 *   2. Open it from the palette → param strip shows '=' next to :name
 *   3. Click the op toggle → it becomes '~' (LIKE %x%)
 *   4. Type a value, run, intercept the /api/snippets/:id/run request
 *      and assert the body contains ops: { name: 'like_contains' }
 *   5. Assert the response includes the rewritten SQL with LIKE
 */
import { chromium } from 'playwright';

const BASE = process.env.BASE || 'http://127.0.0.1:5173';
const HEADLESS = process.env.HEADFUL !== '1';

const browser = await chromium.launch({ headless: HEADLESS });
const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
const page = await ctx.newPage();

let runReqBody = null;
let runRespBody = null;
page.on('request', (r) => {
  if (r.url().includes('/api/snippets/') && r.url().endsWith('/run')) {
    try { runReqBody = JSON.parse(r.postData() || '{}'); } catch (_) { /* ignore */ }
  }
});
page.on('response', async (r) => {
  if (r.url().includes('/api/snippets/') && r.url().endsWith('/run')) {
    try { runRespBody = await r.json(); } catch (_) { /* ignore */ }
  }
});

await page.goto(BASE, { waitUntil: 'networkidle' });
await page.waitForSelector('.cm-content', { timeout: 10_000 });
await page.waitForTimeout(1500);

// Push a deterministic snippet via the API
const pushBody = JSON.stringify([{
  name: 'e2e-op-test',
  sql: "SELECT SCHEMA_NAME AS db FROM information_schema.schemata WHERE SCHEMA_NAME = :name",
  defaultServer: 'localdb',
}]);
await page.evaluate(async (body) => {
  await fetch('/api/snippets/push', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body,
  });
}, pushBody);
// Reload so the store picks up the new snippet via init()
await page.reload({ waitUntil: 'networkidle' });
await page.waitForSelector('.cm-content', { timeout: 10_000 });
await page.waitForTimeout(1500);

// Open the snippet via Cmd+K palette
await page.keyboard.press('Control+K');
await page.waitForSelector('.palette', { timeout: 2000 });
await page.keyboard.type('e2e-op-test');
await page.waitForTimeout(300);
await page.keyboard.press('Enter');
await page.waitForTimeout(500);

// Param strip should show '=' button
const opSymbolBefore = await page.locator('.op-toggle').first().innerText();
console.log('op symbol before:', opSymbolBefore);

// Click to cycle to '~'
await page.locator('.op-toggle').first().click();
await page.waitForTimeout(150);
const opSymbolAfter = await page.locator('.op-toggle').first().innerText();
console.log('op symbol after:', opSymbolAfter);

// Type a value and run
await page.locator('.param-strip input').first().fill('test-value');
await page.keyboard.press('Control+Enter');
await page.waitForTimeout(1500);

console.log('--- request body sent to /run ---');
console.log(runReqBody);
console.log('--- response body (sql field) ---');
console.log(runRespBody?.sql);

// Cleanup — find the snippet by name via the API and delete
await page.evaluate(async () => {
  const r = await fetch('/api/snippets').then((x) => x.json());
  const s = (r.snippets || []).find((x) => x.name === 'e2e-op-test');
  if (s) await fetch(`/api/snippets/${s.id}`, { method: 'DELETE' });
});

await browser.close();

const ok =
  opSymbolBefore.includes('=') &&
  opSymbolAfter.includes('~') &&
  runReqBody?.ops?.name === 'like_contains' &&
  runReqBody?.params?.name === 'test-value' &&
  /LIKE \?/i.test(runRespBody?.sql || '');

console.log(ok ? '\n✓ PASS' : '\n✗ FAIL');
process.exit(ok ? 0 : 1);
