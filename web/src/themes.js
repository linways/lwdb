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
