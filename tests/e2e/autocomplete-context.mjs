/**
 * Probe contextual column autocompletion. CodeMirror's lang-sql does some
 * context-aware completion, but how much? We test four scenarios:
 *
 *   A. "<table>." + Ctrl+Space  → should list that table's columns
 *   B. "SELECT * FROM <table> WHERE " + Ctrl+Space  → should list <table>'s columns
 *   C. "SELECT  FROM <table>" with cursor between SELECT and FROM → should list columns
 *   D. "SELECT <t>." + Ctrl+Space where <t> is an alias from "FROM <tbl> AS t" → should list columns
 *
 * For each scenario we capture: tooltip visible, option count, first 8 options.
 */
import { chromium } from 'playwright';

const BASE = process.env.BASE || 'http://127.0.0.1:5173';
const HEADLESS = process.env.HEADFUL !== '1';

const browser = await chromium.launch({ headless: HEADLESS });
const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
const page = await ctx.newPage();

await page.goto(BASE, { waitUntil: 'networkidle' });
await page.waitForSelector('.cm-content', { timeout: 10_000 });
await page.waitForTimeout(2000);

// (sample table is determined below by triggering FROM completion)

// Re-grab table list by triggering the basic FROM-completion path
await page.locator('.cm-content').click();
await page.keyboard.press('Control+A');
await page.keyboard.press('Delete');
await page.keyboard.type('SELECT * FROM ');
await page.keyboard.press('Control+Space');
await page.waitForTimeout(500);
const tables = await page.locator('.cm-tooltip-autocomplete li').allInnerTexts().catch(() => []);
const TABLE = tables[0];
await page.keyboard.press('Escape');
console.log(`using sample table: ${TABLE}`);
console.log(`(${tables.length} tables found)`);
console.log('');

async function probe(label, beforeCursor, afterCursor = '') {
  await page.locator('.cm-content').click();
  await page.keyboard.press('Control+A');
  await page.keyboard.press('Delete');
  // type whole content then move cursor
  await page.keyboard.type(beforeCursor + afterCursor);
  if (afterCursor.length) {
    // move cursor left by afterCursor.length characters
    for (let i = 0; i < afterCursor.length; i++) await page.keyboard.press('ArrowLeft');
  }
  await page.keyboard.press('Control+Space');
  await page.waitForTimeout(500);
  const tooltipVisible = await page.locator('.cm-tooltip-autocomplete').count();
  const options = await page.locator('.cm-tooltip-autocomplete li').allInnerTexts().catch(() => []);
  console.log(`--- ${label} ---`);
  console.log(`  cursor: "${beforeCursor}<HERE>${afterCursor}"`);
  console.log(`  tooltip: ${tooltipVisible ? 'visible' : 'HIDDEN'}, options: ${options.length}, first8:`);
  for (const o of options.slice(0, 8)) console.log(`    ${o}`);
  await page.keyboard.press('Escape');
}

await probe('A: <table>.', `${TABLE}.`);
await probe('B: SELECT * FROM <table> WHERE ', `SELECT * FROM ${TABLE} WHERE `);
await probe('C: SELECT  FROM <table>  (cursor between SELECT and FROM)',
  'SELECT ', ` FROM ${TABLE}`);
await probe('D: aliased — SELECT t. FROM <table> t', `SELECT t.`, ` FROM ${TABLE} t`);

await browser.close();
