# Theming System Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Dark / Light / Auto theming via an extensible named-theme registry, switchable from the top bar, ⌘K, and Settings, with the CodeMirror editor following the app theme.

**Architecture:** A theme is `data-theme="<id>"` on `<html>`; CSS variables per theme live in `styles.css` blocks keyed by that attribute (with an optional structural "style layer" for future bold themes). A pure registry (`web/src/themes.js`) maps `id → {label, mode}` and resolves a pref (`auto`/`dark`/`light`) + the OS preference to a concrete theme; a thin DOM layer (`web/src/theme.js`) sets the attribute and watches `matchMedia`. The editor theme is swapped via a CodeMirror `Compartment`.

**Tech Stack:** Vue 3, CodeMirror 6 (`@codemirror/theme-one-dark`, Compartment), CSS custom properties, `window.matchMedia`, node:test, Playwright.

---

## File structure

- **Create** `web/src/themes.js` — pure registry + `resolveTheme`. No DOM.
- **Create** `web/src/theme.js` — DOM runtime: `systemPrefersDark`, `applyTheme`, `watchSystemTheme`.
- **Create** `tests/themes.test.mjs` — unit tests for the pure registry.
- **Create** `tests/e2e/theme.mjs` — toggle → `data-theme` + `--bg` change.
- **Modify** `web/src/prefs.js` — add `theme: 'auto'` default.
- **Modify** `web/src/styles.css` — split `:root` colors into `[data-theme="dark"]` / `[data-theme="light"]`.
- **Modify** `web/src/store.js` — `themeMode` state, `setTheme` action, boot apply + matchMedia watch.
- **Modify** `web/src/components/QueryEditor.vue` — editor-theme compartment following `store.themeMode`.
- **Modify** `web/src/components/TopBar.vue` — sun/moon toggle button.
- **Modify** `web/src/components/Settings.vue` — theme `<select>` in General.
- **Modify** `web/src/components/CommandPalette.vue` — "Theme: …" actions.

---

## Task 1: Theme registry (TDD)

**Files:**
- Create: `web/src/themes.js`
- Test: `tests/themes.test.mjs`

- [ ] **Step 1: Write the failing test**

Create `tests/themes.test.mjs`:
```js
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
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test tests/themes.test.mjs`
Expected: FAIL — `Cannot find module '../web/src/themes.js'`.

- [ ] **Step 3: Implement the registry**

Create `web/src/themes.js`:
```js
/**
 * Theme registry (pure — no DOM). A theme id maps to a label + a `mode`
 * ('dark' | 'light') that drives the CodeMirror editor theme and the top-bar
 * icon. Colors themselves live in styles.css under [data-theme="<id>"].
 * Adding a theme later = a CSS block + one entry here.
 */
export const THEMES = {
  dark: { id: 'dark', label: 'Dark', mode: 'dark' },
  light: { id: 'light', label: 'Light', mode: 'light' },
};

// Valid values of store.prefs.theme (what the user picks).
export const THEME_PREFS = ['auto', 'dark', 'light'];

/**
 * Resolve a stored pref ('auto' | a theme id) + the OS dark preference into a
 * concrete theme id. 'auto' follows the OS; explicit ids pass through; anything
 * unrecognized falls back to 'dark'.
 */
export function resolveTheme(pref, systemPrefersDark) {
  if (pref && Object.prototype.hasOwnProperty.call(THEMES, pref)) return pref;
  if (pref === 'auto') return systemPrefersDark ? 'dark' : 'light';
  return 'dark';
}
```

- [ ] **Step 4: Run to verify pass**

Run: `node --test tests/themes.test.mjs`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**
```bash
git add web/src/themes.js tests/themes.test.mjs
git commit -m "feat(theme): pure theme registry + resolveTheme"
```

---

## Task 2: DOM theme runtime

**Files:**
- Create: `web/src/theme.js`

- [ ] **Step 1: Implement**

Create `web/src/theme.js`:
```js
/**
 * DOM side of theming (kept out of themes.js so the registry stays pure).
 * Sets `data-theme` on <html>, reads the OS preference, and watches for changes.
 */
import { resolveTheme } from './themes.js';

export function systemPrefersDark() {
  return !!(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
}

/**
 * Resolve `pref` to a concrete theme, set it on <html>, and return the resolved
 * mode/id so callers (editor) can react.
 */
export function applyTheme(pref) {
  const id = resolveTheme(pref, systemPrefersDark());
  document.documentElement.setAttribute('data-theme', id);
  return id; // for these built-ins, id === mode
}

/**
 * Call `onChange(resolvedId)` whenever the OS light/dark preference flips.
 * Registered once at boot; the callback decides whether to act (only when the
 * current pref is 'auto').
 */
export function watchSystemTheme(onChange) {
  if (!window.matchMedia) return;
  const mq = window.matchMedia('(prefers-color-scheme: dark)');
  const handler = () => onChange(mq.matches ? 'dark' : 'light');
  mq.addEventListener('change', handler);
}
```

- [ ] **Step 2: Lint**

Run: `npx eslint web/src/theme.js`
Expected: exit 0. (No unit test — it's thin DOM glue; covered by the e2e in Task 10.)

- [ ] **Step 3: Commit**
```bash
git add web/src/theme.js
git commit -m "feat(theme): DOM runtime — applyTheme + matchMedia watch"
```

---

## Task 3: Theme preference default

**Files:**
- Modify: `web/src/prefs.js`

- [ ] **Step 1: Add the default**

In `web/src/prefs.js`, add `theme: 'auto',` to `DEFAULT_PREFS` (in the General group, after `writeUnlockedByDefault`):
```js
  writeUnlockedByDefault: false, // start sessions with writes off
  theme: 'auto',                 // 'auto' (follow OS) | 'dark' | 'light'
```

- [ ] **Step 2: Verify**

Run: `node -e "import('./web/src/prefs.js').then(m => console.log('theme default:', m.DEFAULT_PREFS.theme))"`
Expected: `theme default: auto`.

- [ ] **Step 3: Commit**
```bash
git add web/src/prefs.js
git commit -m "feat(theme): default theme pref 'auto'"
```

---

## Task 4: CSS — split into dark + light theme blocks

**Files:**
- Modify: `web/src/styles.css`

- [ ] **Step 1: Replace the `:root` block**

The current top of `styles.css` is one `:root` with all variables. Replace lines 1–19 (the `:root { … }` block) with: `:root` keeping only the theme-independent tokens, plus two theme blocks. New content:
```css
:root {
  --font-sans: ui-sans-serif, -apple-system, "Segoe UI", Roboto, sans-serif;
  --font-mono: ui-monospace, "JetBrains Mono", "Fira Code", Menlo, monospace;
  --r: 6px;
}

[data-theme="dark"] {
  --bg: #0b0c0e;
  --bg-2: #121316;
  --bg-3: #181a1f;
  --bg-hover: #1f222a;
  --border: #2a2d35;
  --border-strong: #3a3e48;
  --text: #e6e7ea;
  --text-dim: #9aa0a8;
  --text-faint: #62676f;
  --accent: #5ad1ff;
  --accent-dim: #2a7693;
  --warn: #f5b54a;
  --danger: #ff6b6b;
  --good: #6fcf73;
}

[data-theme="light"] {
  --bg: #ffffff;
  --bg-2: #f5f6f8;
  --bg-3: #eceef2;
  --bg-hover: #e3e7ec;
  --border: #d8dce2;
  --border-strong: #c0c6cf;
  --text: #1b1e23;
  --text-dim: #5a636e;
  --text-faint: #899099;
  --accent: #0b87c2;
  --accent-dim: #b8e2f2;
  --warn: #b9770a;
  --danger: #c63a3c;
  --good: #2f8f3a;
}
```
(Leave the rest of `styles.css` — `* { box-sizing }`, `html, body, #app`, and all component rules — unchanged.)

- [ ] **Step 2: Verify the SPA still builds**

Run: `npm run build`
Expected: build succeeds. (Theme won't switch yet — no attribute is set until Task 5; but the dark block is the only one matched once we set `data-theme="dark"`.)

- [ ] **Step 3: Commit**
```bash
git add web/src/styles.css
git commit -m "feat(theme): split CSS vars into dark + light theme blocks"
```

---

## Task 5: Store wiring (state, action, boot, watch)

**Files:**
- Modify: `web/src/store.js`

- [ ] **Step 1: Import the theme helpers**

At the top of `web/src/store.js`, after the existing imports, add:
```js
import { THEME_PREFS } from './themes.js';
import { applyTheme, systemPrefersDark, watchSystemTheme } from './theme.js';
import { resolveTheme } from './themes.js';
```

- [ ] **Step 2: Add `themeMode` to the reactive store and apply on boot**

In the `reactive({ … })` store object, add `themeMode` next to `prefs` (initialised from the saved pref). Add after the line `prefs: { ...initialPrefs },`:
```js
  themeMode: resolveTheme(initialPrefs.theme, systemPrefersDark()), // 'dark' | 'light'
```

Immediately **after** the `export const store = reactive({ … });` statement (so it runs at import time, before first paint — no flash), add:
```js
// Apply the saved theme to <html> as early as possible.
store.themeMode = applyTheme(store.prefs.theme);
```

- [ ] **Step 3: Add the `setTheme` action**

In the `actions` object, add (e.g. after `resetPrefs` / near the other pref actions):
```js
  /** Set the theme pref ('auto' | 'dark' | 'light'), persist, and apply. */
  setTheme(pref) {
    const next = THEME_PREFS.includes(pref) ? pref : 'auto';
    store.prefs.theme = next;            // persisted by the prefs watcher
    store.themeMode = applyTheme(next);  // updates <html> data-theme
    toast(`Theme: ${next}`, 'good');
  },
```

- [ ] **Step 4: Watch the OS preference in `init()`**

In `init()`, add as the first line inside the function body:
```js
    watchSystemTheme(() => { if (store.prefs.theme === 'auto') store.themeMode = applyTheme('auto'); });
```

- [ ] **Step 5: Verify build + lint**

Run: `npm run build && npx eslint web/src/store.js`
Expected: build OK, eslint exit 0.

- [ ] **Step 6: Commit**
```bash
git add web/src/store.js
git commit -m "feat(theme): store themeMode + setTheme + boot apply + OS watch"
```

---

## Task 6: Editor theme follows the app theme

**Files:**
- Modify: `web/src/components/QueryEditor.vue`

- [ ] **Step 1: Add a theme compartment + editor-theme builder**

In `web/src/components/QueryEditor.vue`, near the other compartments (`sqlCompartment`, `appearanceCompartment`, `gutterCompartment`), add:
```js
const themeCompartment = new Compartment();
```
Add a builder function (next to `buildAppearance` / `buildGutter`):
```js
// Light surface theme (var-driven) for when oneDark is off. Dark uses oneDark.
const lightEditorTheme = EditorView.theme({
  '&': { backgroundColor: 'var(--bg-2)', color: 'var(--text)' },
  '.cm-gutters': { backgroundColor: 'var(--bg-2)', color: 'var(--text-faint)', border: 'none' },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--text)' },
  '.cm-activeLine': { backgroundColor: 'var(--bg-3)' },
  '.cm-activeLineGutter': { backgroundColor: 'var(--bg-3)' },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection': { backgroundColor: 'var(--bg-hover)' },
}, { dark: false });

function editorThemeFor(mode) {
  return mode === 'dark' ? [oneDark] : [lightEditorTheme];
}
```

- [ ] **Step 2: Use the compartment instead of the static `oneDark`**

In the `onMounted` extensions array, **remove** the bare `oneDark,` line and **replace** it with:
```js
      themeCompartment.of(editorThemeFor(store.themeMode)),
```

- [ ] **Step 3: Reconfigure on theme change**

Add a watcher (next to the existing `watch(() => store.schema?.fetchedAt, …)`):
```js
watch(
  () => store.themeMode,
  (mode) => {
    if (!view) return;
    view.dispatch({ effects: themeCompartment.reconfigure(editorThemeFor(mode)) });
  },
);
```
(`watch` is already imported in this file; `Compartment`, `EditorView`, `oneDark` are already imported.)

- [ ] **Step 4: Verify build + lint**

Run: `npm run build && npx eslint web/src/components/QueryEditor.vue`
Expected: build OK, eslint clean.

- [ ] **Step 5: Commit**
```bash
git add web/src/components/QueryEditor.vue
git commit -m "feat(theme): editor theme follows store.themeMode (oneDark/light)"
```

---

## Task 7: Top-bar toggle

**Files:**
- Modify: `web/src/components/TopBar.vue`

- [ ] **Step 1: Add a toggle handler**

In `<script setup>` of `TopBar.vue` (it already imports `store, actions`), add:
```js
function toggleTheme() {
  actions.setTheme(store.themeMode === 'dark' ? 'light' : 'dark');
}
```

- [ ] **Step 2: Add the button to the template**

Add this button into the top bar's right-hand controls (near the other top-bar buttons; place it just before the settings/gear button — match the existing button markup style). Use a class `theme-toggle` (the e2e test targets it):
```html
<button
  class="chip theme-toggle"
  :title="`Theme: ${store.themeMode} (click to toggle)`"
  @click="toggleTheme"
>
  {{ store.themeMode === 'dark' ? '☾' : '☀' }}
</button>
```
(If the bar has a dedicated right-side container/`spacer`, put it there; otherwise alongside the other `chip`/icon buttons. Keep it consistent with neighbors.)

- [ ] **Step 3: Verify build**

Run: `npm run build`
Expected: build OK.

- [ ] **Step 4: Commit**
```bash
git add web/src/components/TopBar.vue
git commit -m "feat(theme): top-bar sun/moon toggle"
```

---

## Task 8: Settings dropdown

**Files:**
- Modify: `web/src/components/Settings.vue`

- [ ] **Step 1: Add a Theme row to the General section**

`Settings.vue` renders the General panel under `<section v-if="active === 'general'">` (around line 135). Add a theme control inside it, matching how other prefs rows are structured in that section (label + control). Use:
```html
<label class="row">
  <span>Theme</span>
  <select :value="store.prefs.theme" @change="actions.setTheme($event.target.value)">
    <option value="auto">Auto (follow OS)</option>
    <option value="dark">Dark</option>
    <option value="light">Light</option>
  </select>
</label>
```
> Match the exact row markup/classes the General section already uses for its other settings (e.g. the `defaultLimit` / `confirmDestructive` rows). The key behavior: bind the current value from `store.prefs.theme` and call `actions.setTheme(...)` on change (do NOT write `store.prefs.theme` directly — `setTheme` also applies the theme).

- [ ] **Step 2: Verify build**

Run: `npm run build`
Expected: build OK.

- [ ] **Step 3: Commit**
```bash
git add web/src/components/Settings.vue
git commit -m "feat(theme): Settings → General theme selector"
```

---

## Task 9: Command palette actions

**Files:**
- Modify: `web/src/components/CommandPalette.vue`

- [ ] **Step 1: Add three theme actions**

In `CommandPalette.vue`, the `actionsList` is an array of `{ id, label, sub, run }` objects (around line 55). Add these entries (e.g. after the `open-settings` action):
```js
  { id: 'theme-auto', label: 'Theme: Auto', sub: 'Follow the OS light/dark setting', run: () => { actions.setTheme('auto'); emit('close'); } },
  { id: 'theme-dark', label: 'Theme: Dark', sub: 'Use the dark theme', run: () => { actions.setTheme('dark'); emit('close'); } },
  { id: 'theme-light', label: 'Theme: Light', sub: 'Use the light theme', run: () => { actions.setTheme('light'); emit('close'); } },
```
(`actions` is already imported in this file.)

- [ ] **Step 2: Verify build + lint**

Run: `npm run build && npx eslint web/src/components/CommandPalette.vue`
Expected: build OK; eslint exit 0 (run `--fix` if only stylistic warnings, then rebuild).

- [ ] **Step 3: Commit**
```bash
git add web/src/components/CommandPalette.vue
git commit -m "feat(theme): palette Theme: Auto/Dark/Light actions"
```

---

## Task 10: E2E + full verification

**Files:**
- Create: `tests/e2e/theme.mjs`

- [ ] **Step 1: Write the e2e test**

Create `tests/e2e/theme.mjs`:
```js
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
```

- [ ] **Step 2: Run it against a built server**
```bash
npm run build
node --no-warnings=ExperimentalWarning server/index.mjs &
SRV=$!; sleep 2
BASE=http://127.0.0.1:4321 node tests/e2e/theme.mjs
RC=$?
kill $SRV 2>/dev/null
echo "exit: $RC"
```
Expected: every line `✓`, `✓ ALL PASS`, exit 0.

- [ ] **Step 3: Full suite**

Run: `npm test && npx eslint . && npm run build`
Expected: all unit tests pass (includes `themes.test.mjs`), eslint clean, build OK.

- [ ] **Step 4: Regression e2e sweep (built server, BASE forced)**
```bash
node --no-warnings=ExperimentalWarning server/index.mjs & SRV=$!; sleep 2
BASE=http://127.0.0.1:4321 sh -c 'for t in tests/e2e/*.mjs; do node "$t" >/dev/null 2>&1 && echo "✓ $(basename $t)" || echo "✗ $(basename $t)"; done'
kill $SRV 2>/dev/null
```
Expected: all e2e tests `✓` (including the new `theme.mjs`).

- [ ] **Step 5: Commit**
```bash
git add tests/e2e/theme.mjs
git commit -m "test(e2e): theme toggle flips data-theme + --bg + editor"
```

---

## Self-Review

- **Spec coverage:** registry + resolve (T1) · DOM apply/watch (T2) · default `auto` pref (T3) · dark/light CSS blocks (T4) · `themeMode`/`setTheme`/boot/OS-watch (T5) · editor follows theme (T6) · top-bar toggle (T7) · Settings dropdown (T8) · ⌘K actions (T9) · e2e + verify (T10). All spec sections map to a task. The "optional style layer / p10k" path needs no task now — it's enabled by the `[data-theme]`-keyed CSS already established in T4.
- **Type/name consistency:** `resolveTheme(pref, systemPrefersDark)`, `applyTheme(pref)→id`, `THEME_PREFS`, `store.themeMode`, `actions.setTheme(pref)`, `editorThemeFor(mode)`, `themeCompartment`, `.theme-toggle` — all consistent across tasks.
- **No placeholders:** every code step is complete. Two UI-wiring notes (Settings row markup, TopBar button placement) point at concrete existing patterns and give the exact binding behavior, not vague instructions.
- **FOUC:** theme is applied at store-module import (T5 Step 2), before first paint.
- **Editor light theme** adds no dependency (drops `oneDark`, uses a var-driven `EditorView.theme` + existing `defaultHighlightStyle`).
