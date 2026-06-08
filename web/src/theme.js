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
