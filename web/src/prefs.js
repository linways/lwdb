/**
 * User preferences for lwdb. Stored in localStorage; applied live by the
 * components that read from `store.prefs`.
 */

const STORAGE_KEY = 'lwdb:prefs:v1';

export const DEFAULT_PREFS = Object.freeze({
  // General
  defaultLimit: 500,             // implicit LIMIT applied to bare SELECTs
  confirmDestructive: true,      // confirm() before delete-snippet etc.
  writeUnlockedByDefault: false, // start sessions with writes off

  // Editor
  editorFontSize: 13,            // px
  uppercaseKeywords: true,       // CodeMirror SQL completion behavior
  showLineNumbers: true,
  wordWrap: false,

  // Results
  maxCellWidth: 360,             // px — column truncation
  nullDisplay: 'NULL',           // 'NULL' | 'empty' | 'dash'
  zebraStripes: true,
});

export function loadPrefs() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULT_PREFS };
    const parsed = JSON.parse(raw);
    return { ...DEFAULT_PREFS, ...parsed };
  } catch (_) {
    return { ...DEFAULT_PREFS };
  }
}

export function savePrefs(prefs) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs)); }
  catch (_) { /* quota — ignore */ }
}

export function resetPrefs() {
  try { localStorage.removeItem(STORAGE_KEY); } catch (_) { /* ignore */ }
  return { ...DEFAULT_PREFS };
}
