import test from 'node:test';
import assert from 'node:assert/strict';

import { THEMES, THEME_PREFS, resolveTheme } from '../web/src/themes.js';

test('THEMES has dark and light with a mode', () => {
  assert.equal(THEMES.dark.mode, 'dark');
  assert.equal(THEMES.light.mode, 'light');
  assert.deepEqual(THEME_PREFS, ['auto', 'dark', 'light']);
});

test('resolveTheme: auto follows the OS preference', () => {
  assert.equal(resolveTheme('auto', true), 'dark');
  assert.equal(resolveTheme('auto', false), 'light');
});

test('resolveTheme: explicit values pass through', () => {
  assert.equal(resolveTheme('dark', false), 'dark');
  assert.equal(resolveTheme('light', true), 'light');
});

test('resolveTheme: unknown falls back to dark', () => {
  assert.equal(resolveTheme('bogus', false), 'dark');
  assert.equal(resolveTheme(undefined, true), 'dark');
});
