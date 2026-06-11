# Theming System — Design

**Date:** 2026-06-08
**Status:** Approved (pending spec review)
**Topic:** Add light/dark + Auto theming via an extensible named-theme registry, switchable from the top bar, ⌘K, and Settings. Architected as "CSS variables + an optional style layer" so a bold (e.g. Powerlevel10k-style) theme is a future drop-in — no full theme engine.

## Problem

The UI is a single hardcoded dark theme: `web/src/styles.css` defines ~18 color variables under one `:root`, and the SQL editor hardcodes the `oneDark` CodeMirror theme. There's no way to switch to light, follow the OS preference, or add new themes.

## Goals

- **Dark + Light + Auto** out of the box. Auto follows the OS (`prefers-color-scheme`) and updates live when it changes.
- Switchable from three places: a **top-bar toggle**, a **⌘K palette action**, and a **Settings → Appearance** dropdown — all through one action.
- The **CodeMirror editor theme follows** the app theme.
- Persisted in the existing prefs (localStorage), default **`auto`**.
- **Extensible:** a theme = a set of CSS variables + an optional per-theme style layer. Adding a theme later (including a richly-styled one like a p10k-inspired theme) = one CSS block + one registry entry, with no architectural change.

## Non-goals (YAGNI)

- No user-authored / importable custom themes, no in-app color editor (full theme engine).
- No bundled Nerd Font / icon pack now. (A future bold theme can opt into one; not in scope.)
- No server-side theme storage — it's a client/localStorage pref like the others.
- We ship **Dark + Light** themes now; the p10k-style theme is explicitly *future work the architecture enables*, not built here.

## How a theme works

A theme is identified by `data-theme="<id>"` set on `<html>` (`document.documentElement`).

- **Colors** live in `styles.css` blocks keyed by the attribute: `[data-theme="dark"] { --bg: …; … }` and `[data-theme="light"] { … }`. Every one of the existing ~18 color variables is defined in both blocks.
- **Optional style layer:** a theme may add structural CSS in the same attribute scope (e.g. a future `[data-theme="p10k"] .chip { … }`). Built-in Dark/Light only supply variables.
- **Non-color tokens** (`--font-sans`, `--font-mono`, `--r` radius) stay in `:root` (theme-independent).
- The attribute is **always set** (default resolved on boot), so nothing relies on bare `:root` for colors.

CodeMirror can't be themed by CSS variables, so the registry names an **editor theme** per app theme; the editor is reconfigured via a CodeMirror `Compartment` when the theme changes.

## Components

### 1. `web/src/themes.js` (new — pure, testable)
The registry and resolution logic. No DOM access.
```js
// id → metadata. `mode` drives the editor theme + the top-bar icon.
export const THEMES = {
  dark:  { id: 'dark',  label: 'Dark',  mode: 'dark'  },
  light: { id: 'light', label: 'Light', mode: 'light' },
};
export const THEME_PREFS = ['auto', 'dark', 'light']; // valid values of prefs.theme

// Resolve a pref + the OS preference into a concrete theme id.
//   resolveTheme('auto', true)  -> 'dark'
//   resolveTheme('auto', false) -> 'light'
//   resolveTheme('light', *)    -> 'light'
//   resolveTheme('bogus', *)    -> 'dark'  (fallback)
export function resolveTheme(pref, systemPrefersDark) {
  if (pref === 'dark' || pref === 'light') return pref;
  if (pref === 'auto') return systemPrefersDark ? 'dark' : 'light';
  return 'dark';
}
```

### 2. `web/src/theme.js` (new — DOM/runtime side, kept out of themes.js so the registry stays pure)
- `systemPrefersDark()` → reads `window.matchMedia('(prefers-color-scheme: dark)').matches`.
- `applyTheme(pref)` → computes `resolveTheme(pref, systemPrefersDark())`, sets `document.documentElement.setAttribute('data-theme', id)`. Returns the resolved id (so callers can pick the editor theme).
- `watchSystemTheme(onChange)` → registers a `matchMedia(...).addEventListener('change', …)` listener; called once at boot, invokes `onChange` only while the pref is `auto`.

### 3. `web/src/store.js`
- `setTheme(pref)` action: validate against `THEME_PREFS` (fallback `auto`), set `store.prefs.theme = pref` (persists via the existing prefs watcher), call `applyTheme(pref)`, and reconfigure the editor (see §4) for the resolved mode. Also expose the resolved mode on the store (`store.themeMode`) for the editor + top-bar icon.
- On `init()`: `applyTheme(store.prefs.theme)` and `watchSystemTheme(() => { if (store.prefs.theme === 'auto') reapply })`.

### 4. `web/src/components/QueryEditor.vue`
- Add a `themeCompartment` (CodeMirror `Compartment`). Build the editor-theme extension from the resolved mode: **`dark` → `[oneDark]`**, **`light` → `[]`** (no extra dependency — `syntaxHighlighting(defaultHighlightStyle)` already renders a light scheme; CM's default surface is light). A small `EditorView.theme` sets the editor background to `var(--bg-2)` and text to `var(--text)` so the editor surface matches the app in both modes.
- `oneDark` moves out of the static extension list into `themeCompartment.of(editorThemeFor(mode))`.
- Watch `store.themeMode`; on change, `view.dispatch({ effects: themeCompartment.reconfigure(editorThemeFor(mode)) })`.

### 5. `web/src/prefs.js`
- Add `theme: 'auto'` to `DEFAULT_PREFS`.

### 6. `web/src/styles.css`
- Move the color variables out of `:root` into `[data-theme="dark"]` (same values as today) and add a new `[data-theme="light"]` block with a tasteful light mapping of all ~18 variables (light surfaces, dark text, accessible accent/warn/danger/good). `:root` keeps `--font-*` and `--r`.

### 7. `web/src/components/TopBar.vue`
- A small icon button (sun when light, moon when dark — reflects `store.themeMode`). Click toggles **explicitly** between `light` and `dark` via `actions.setTheme(...)` (a quick flip; Auto lives in Settings/palette). Tooltip names the current theme.

### 8. `web/src/components/Settings.vue`
- In the Appearance area, a theme `<select>` bound to `store.prefs.theme` with options **Auto · Dark · Light**, calling `actions.setTheme(...)` on change.

### 9. `web/src/components/CommandPalette.vue`
- Action items "Theme: Auto", "Theme: Dark", "Theme: Light" → `actions.setTheme(<id>)` (matches the existing action-item shape; reuse the palette's action mechanism).

## Data flow

1. **Boot** (`init`): `applyTheme(prefs.theme)` sets `data-theme`; `store.themeMode` set to the resolved mode; editor builds with the matching editor theme; `watchSystemTheme` registered.
2. **User switches** (top-bar / ⌘K / Settings) → `setTheme(pref)` → persist + `applyTheme` (updates `data-theme` + `themeMode`) + reconfigure editor compartment. CSS variables cascade instantly; the editor restyles via the compartment.
3. **OS flips while on `auto`** → matchMedia listener re-applies → `data-theme` + editor follow live.

## Error handling / edge cases

- Unknown/legacy `prefs.theme` value → `resolveTheme` falls back to `dark`; `setTheme` coerces invalid input to `auto`.
- `matchMedia` unavailable (very old webview) → `systemPrefersDark()` returns `false` (→ light under auto); no crash.
- SSR/`document` absent: N/A (SPA only, `ssr:false`).

## Testing

- **Unit (`node:test`)** on `web/src/themes.js` (pure): `resolveTheme` for `auto`+dark OS, `auto`+light OS, explicit `dark`/`light` pass-through, and unknown→`dark` fallback; `THEME_PREFS` membership.
- **E2E (Playwright)** `tests/e2e/theme.mjs`: load app; read `document.documentElement.getAttribute('data-theme')` and `getComputedStyle(documentElement).getPropertyValue('--bg')`; click the top-bar toggle; assert `data-theme` flips and `--bg` changes; assert the editor surface (`.cm-editor` background) changed too. Run with `BASE=http://127.0.0.1:4321` per the e2e convention.
- **Regression:** existing unit + e2e suites still green; `npm run build` + `npx eslint .` clean.

## Extensibility note (how a p10k-style theme lands later — not built now)

1. Add `[data-theme="p10k"] { …vibrant vars… }` plus an optional style layer (`[data-theme="p10k"] .chip { …powerline segments… }`, `.statusbar { … }`) in `styles.css`.
2. Add `p10k: { id:'p10k', label:'Powerline', mode:'dark' }` to `THEMES` (so it appears in Settings/⌘K and picks the dark editor theme).
3. (Optional) opt that theme into an icon font, scoped to its attribute.

No engine, no schema — just data + CSS.

## Open questions

None outstanding.
