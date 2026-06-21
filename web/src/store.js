import { reactive, computed, watch } from 'vue';
import { api } from './api.js';
import { loadPrefs, savePrefs, DEFAULT_PREFS } from './prefs.js';
import { pickStatement, parseUseStatement } from './sqlStatements.js';
import { updateCellSql } from './sqlGen.js';
import { THEME_PREFS, resolveTheme } from './themes.js';
import { applyTheme, systemPrefersDark, watchSystemTheme } from './theme.js';

// localStorage-backed schema cache. Linways AMS schemas are nearly identical
// across colleges, so once we've fetched a db's table/column map there's
// little reason to refetch on every db switch. Refresh is user-triggered.
// Bump the version segment whenever the schema response shape changes; old
// localStorage entries with a different prefix are simply ignored.
const SCHEMA_CACHE_PREFIX = 'lwdb:schema:v2:';
function schemaCacheKey(server, db) { return `${SCHEMA_CACHE_PREFIX}${server}:${db}`; }
function readSchemaCache(server, db) {
  try {
    const raw = localStorage.getItem(schemaCacheKey(server, db));
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || !parsed.tables) return null;
    return parsed;
  } catch (_) { return null; }
}
function writeSchemaCache(server, db, schema) {
  try { localStorage.setItem(schemaCacheKey(server, db), JSON.stringify(schema)); }
  catch (_) { /* quota exceeded — ignore, schema just won't be cached */ }
}

// Recently-used databases, most-recent-first, capped per server. Stored in
// localStorage so the db picker can surface "Recently used" across reloads.
const RECENT_DBS_MAX = 5;
const VALID_DENSITY = ['compact', 'comfortable', 'large'];
function recentDbsKey(server) { return `lwdb:recentDbs:${server}`; }
function readRecentDbs(server) {
  try {
    const list = JSON.parse(localStorage.getItem(recentDbsKey(server)) || '[]');
    return Array.isArray(list) ? list : [];
  } catch (_) { return []; }
}

// Density → zoom factor. In the Tauri desktop app we use the native webview
// zoom (re-renders crisply, like Ctrl-+); CSS transform-scale is only a browser
// fallback (it rescales rasterized pixels, so it looks blurry at 1.12/1.28).
const DENSITY_ZOOM = { compact: 1, comfortable: 1.12, large: 1.28 };
const isTauri = typeof window !== 'undefined' && !!window.__TAURI_INTERNALS__;

function applyDensity(pref) {
  const d = VALID_DENSITY.includes(pref) ? pref : 'compact';
  if (isTauri) {
    // Native zoom — no CSS scaling, so it stays crisp.
    document.documentElement.removeAttribute('data-density');
    import('@tauri-apps/api/webview')
      .then(({ getCurrentWebview }) => getCurrentWebview().setZoom(DENSITY_ZOOM[d] || 1))
      .catch(() => { document.documentElement.setAttribute('data-density', d); }); // fall back to CSS
  } else {
    document.documentElement.setAttribute('data-density', d);
  }
  return d;
}

let tabSeq = 1;
function blankTab() {
  const id = tabSeq++;
  return {
    id,
    title: `Query ${id}`,
    sql: 'SELECT 1;',
    snippetId: null,
    snippetParams: {},
    snippetOps: {},        // { paramName: 'eq' | 'like_contains' | ... } — see snippets.mjs
    running: false,
    result: null,
    error: null,
    resultsHidden: false,
    // caret / selection, synced from the editor — drives "run statement at cursor"
    cursorOffset: 0,
    selFrom: 0,
    selTo: 0,
  };
}

const initialPrefs = loadPrefs();

// Remember the last read-only/writable choice across launches (falls back to
// the writeUnlockedByDefault pref the first time, before any toggle).
const WRITABLE_KEY = 'lwdb:writable';
function readWritable(fallback) {
  try { const v = localStorage.getItem(WRITABLE_KEY); return v === null ? fallback : v === '1'; }
  catch (_) { return fallback; }
}

export const store = reactive({
  servers: [],
  currentServer: null,
  databases: [],
  currentDb: null,
  recentDbs: {},            // { [serverId]: [db, ...] } most-recent-first, max RECENT_DBS_MAX
  tables: [],
  tableFilter: '',
  schema: { tables: {}, columnCount: 0, fetchedAt: null }, // { tableName: [col, ...] } for the active (server, db)
  snippets: [],
  snippetFilter: '',
  tabs: [blankTab()],
  closedTabs: [],           // recently-closed tabs (slim, most-recent-first) for reopening
  activeTabId: 1,
  writable: readWritable(!!initialPrefs.writeUnlockedByDefault),
  loadingDbs: false,
  loadingTables: false,
  loadingSchema: false,
  toast: null,
  connectionsOpen: false,
  prefs: { ...initialPrefs },
  themeMode: resolveTheme(initialPrefs.theme, systemPrefersDark()), // 'dark' | 'light'
});

// Apply the saved theme + density to <html> as early as possible (before first paint).
store.themeMode = applyTheme(store.prefs.theme);
applyDensity(store.prefs.uiDensity);

// Persist open tabs (content only — not the volatile result/error/running) so
// closing and reopening lwdb keeps your in-progress queries, like DBeaver scripts.
const TABS_KEY = 'lwdb:tabs';
function slimTab(t) {
  return { id: t.id, title: t.title, sql: t.sql, snippetId: t.snippetId, snippetParams: t.snippetParams, snippetOps: t.snippetOps };
}
function saveTabs() {
  try {
    localStorage.setItem(TABS_KEY, JSON.stringify({
      tabs: store.tabs.map(slimTab),
      closed: store.closedTabs,
      activeTabId: store.activeTabId,
      seq: tabSeq, // persist the counter so "Query N" never reuses a number
    }));
  } catch (_) { /* quota — ignore */ }
}
(function restoreTabs() {
  try {
    const saved = JSON.parse(localStorage.getItem(TABS_KEY) || 'null');
    if (!saved || !Array.isArray(saved.tabs) || !saved.tabs.length) return;
    store.tabs = saved.tabs.map((t) => ({ ...blankTab(), ...t }));
    store.closedTabs = Array.isArray(saved.closed) ? saved.closed : [];
    store.activeTabId = store.tabs.some((t) => t.id === saved.activeTabId) ? saved.activeTabId : store.tabs[0].id;
    // Continue numbering from the persisted counter; fall back to max id seen.
    const maxId = Math.max(0, ...store.tabs.map((t) => t.id), ...store.closedTabs.map((t) => t.id || 0));
    tabSeq = Math.max(saved.seq || 0, maxId + 1);
  } catch (_) { /* corrupt — start fresh */ }
})();
// Re-runs only when persisted fields change (the getter never reads result/error).
watch(
  () => JSON.stringify(store.tabs.map(slimTab)) + '@' + store.activeTabId + '#' + store.closedTabs.length + '#' + tabSeq,
  saveTabs,
);

/** Record `db` as the most-recently-used on `server` (deduped, capped). */
function pushRecentDb(server, db) {
  if (!server || !db) return;
  const list = [db, ...readRecentDbs(server).filter((d) => d !== db)].slice(0, RECENT_DBS_MAX);
  try { localStorage.setItem(recentDbsKey(server), JSON.stringify(list)); } catch (_) { /* quota — ignore */ }
  store.recentDbs[server] = list;
}

// Persist prefs whenever they change.
watch(() => ({ ...store.prefs }), (val) => savePrefs(val), { deep: true });

// Remember the read-only/writable toggle so it survives a restart.
watch(() => store.writable, (v) => {
  try { localStorage.setItem(WRITABLE_KEY, v ? '1' : '0'); } catch (_) { /* quota — ignore */ }
});

export const activeTab = computed(() => store.tabs.find((t) => t.id === store.activeTabId));

export const filteredTables = computed(() => {
  const q = store.tableFilter.toLowerCase().trim();
  if (!q) return store.tables;
  return store.tables.filter((t) => t.name.toLowerCase().includes(q));
});

export const filteredSnippets = computed(() => {
  const q = store.snippetFilter.toLowerCase().trim();
  if (!q) return store.snippets;
  return store.snippets.filter((s) =>
    s.name.toLowerCase().includes(q) ||
    (s.description || '').toLowerCase().includes(q) ||
    (s.tags || []).some((t) => t.toLowerCase().includes(q))
  );
});

function toast(msg, kind = 'info') {
  const id = Date.now() + Math.random();
  store.toast = { msg, kind, id };
  setTimeout(() => { if (store.toast && store.toast.id === id) store.toast = null; }, 3500);
}

export const actions = {
  toast,

  async init() {
    watchSystemTheme(() => { if (store.prefs.theme === 'auto') store.themeMode = applyTheme('auto'); });
    try {
      const { servers } = await api.servers();
      store.servers = servers;
      const saved = localStorage.getItem('lwdb:lastServer');
      const initial = servers.find((s) => s.id === saved) || servers.find((s) => s.kind === 'local') || servers[0];
      if (initial) await this.selectServer(initial.id);
      await this.refreshSnippets();
    } catch (err) {
      toast(`Init failed: ${err.message}`, 'error');
    }
  },

  async selectServer(id) {
    store.currentServer = id;
    store.currentDb = null;
    store.databases = [];
    store.tables = [];
    localStorage.setItem('lwdb:lastServer', id);
    store.recentDbs[id] = readRecentDbs(id);
    if (!id) return;
    store.loadingDbs = true;
    try {
      const { databases } = await api.databases(id);
      store.databases = databases;
      const saved = localStorage.getItem(`lwdb:lastDb:${id}`);
      const initial = databases.includes(saved) ? saved : databases[0];
      if (initial) await this.selectDatabase(initial);
    } catch (err) {
      toast(`Cannot connect to ${id}: ${err.message}`, 'error');
    } finally {
      store.loadingDbs = false;
    }
  },

  async selectDatabase(db) {
    store.currentDb = db;
    store.tables = [];
    store.schema = { tables: {}, columnCount: 0, fetchedAt: null, cached: false };
    if (!db) return;
    localStorage.setItem(`lwdb:lastDb:${store.currentServer}`, db);
    pushRecentDb(store.currentServer, db);

    // Schema: hit the localStorage cache if we have one — schemas are nearly
    // identical across colleges and rarely change, so don't re-fetch.
    const cached = readSchemaCache(store.currentServer, db);
    if (cached) {
      store.schema = { ...cached, cached: true };
    } else {
      store.loadingSchema = true;
      try {
        const r = await api.schema(store.currentServer, db);
        store.schema = { ...r, cached: false };
        writeSchemaCache(store.currentServer, db, r);
      } catch (err) {
         
        console.warn('[lwdb] schema fetch failed', err);
      } finally {
        store.loadingSchema = false;
      }
    }

    // Tables are cheap and freshness matters for the table list — fetch every time.
    store.loadingTables = true;
    try {
      const { tables } = await api.tables(store.currentServer, db);
      store.tables = tables;
    } catch (err) {
      toast(`Tables load failed: ${err.message}`, 'error');
    } finally {
      store.loadingTables = false;
    }
  },

  openConnections() { store.connectionsOpen = true; },
  closeConnections() { store.connectionsOpen = false; },

  /** Reload the server list from the backing store (after add/edit/delete). */
  async reloadServers(selectId = null) {
    const { servers } = await api.servers();
    store.servers = servers;
    if (selectId && servers.find((s) => s.id === selectId)) {
      await this.selectServer(selectId);
    } else if (store.currentServer && !servers.find((s) => s.id === store.currentServer)) {
      // current server was deleted — fall back to the first available
      if (servers[0]) await this.selectServer(servers[0].id);
      else { store.currentServer = null; store.databases = []; store.tables = []; }
    }
  },

  async saveConnection(payload) {
    try {
      const saved = payload.id && payload._editing
        ? await api.updateConnection(payload.id, payload)
        : await api.createConnection(payload);
      await this.reloadServers(saved.connection.id);
      toast(payload._editing ? 'Connection updated' : 'Connection added', 'good');
      return saved.connection;
    } catch (err) { toast(err.message, 'error'); throw err; }
  },

  async deleteConnection(id) {
    if (store.prefs.confirmDestructive && !confirm('Delete this connection?')) return;
    try {
      await api.deleteConnection(id);
      await this.reloadServers();
      toast('Connection deleted', 'good');
    } catch (err) { toast(err.message, 'error'); }
  },

  async testConnection(payload) {
    return api.testConnection(payload); // caller handles ok/err for inline UI feedback
  },

  /** Force a fresh fetch of the active db's schema, bypassing cache. */
  async refreshSchema() {
    if (!store.currentServer || !store.currentDb) return;
    store.loadingSchema = true;
    try {
      const r = await api.schema(store.currentServer, store.currentDb);
      store.schema = { ...r, cached: false };
      writeSchemaCache(store.currentServer, store.currentDb, r);
      toast(`Schema refreshed · ${Object.keys(r.tables).length} tables · ${r.columnCount} columns`, 'good');
    } catch (err) {
      toast(`Schema refresh failed: ${err.message}`, 'error');
    } finally {
      store.loadingSchema = false;
    }
  },

  /** Set the theme pref ('auto' | 'dark' | 'light'), persist, and apply. */
  setTheme(pref) {
    const next = THEME_PREFS.includes(pref) ? pref : 'auto';
    store.prefs.theme = next;            // persisted by the prefs watcher
    store.themeMode = applyTheme(next);  // updates <html> data-theme
    toast(`Theme: ${next}`, 'good');
  },

  /** Set the UI density pref ('compact' | 'comfortable' | 'large'), persist, and apply. */
  setDensity(pref) {
    const next = VALID_DENSITY.includes(pref) ? pref : 'compact';
    store.prefs.uiDensity = next; // persisted by the prefs watcher
    applyDensity(next);           // updates <html> data-density
    toast(`Interface: ${next}`, 'good');
  },

  /** Reset all user prefs to defaults. */
  resetPrefs() {
    Object.assign(store.prefs, DEFAULT_PREFS);
    store.themeMode = applyTheme(store.prefs.theme); // re-apply — theme is a pref too
    applyDensity(store.prefs.uiDensity);             // density is a pref too
    toast('Settings reset to defaults', 'good');
  },

  /** Drop all cached schemas. */
  clearSchemaCache() {
    const keys = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith(SCHEMA_CACHE_PREFIX)) keys.push(k);
    }
    keys.forEach((k) => localStorage.removeItem(k));
    toast(`Cleared ${keys.length} cached schema${keys.length === 1 ? '' : 's'}`, 'good');
  },

  newTab(initial = {}) {
    const t = { ...blankTab(), ...initial };
    store.tabs.push(t);
    store.activeTabId = t.id;
    return t;
  },

  closeTab(id) {
    const idx = store.tabs.findIndex((t) => t.id === id);
    if (idx === -1) return;
    const closed = store.tabs[idx];
    // Remember tabs with actual content so they can be reopened.
    const keep = store.prefs.keepClosedTabs ?? 10;
    if (keep > 0 && (closed.sql || '').trim()) {
      store.closedTabs = [slimTab(closed), ...store.closedTabs.filter((t) => t.id !== closed.id)].slice(0, keep);
    }
    // Closing the only tab: clear it in place rather than remove + recreate,
    // which would needlessly bump the "Query N" counter each time.
    if (store.tabs.length === 1) {
      Object.assign(closed, {
        sql: 'SELECT 1;', snippetId: null, snippetParams: {}, snippetOps: {},
        result: null, error: null, running: false, resultsHidden: false,
      });
      return;
    }
    store.tabs.splice(idx, 1);
    if (store.activeTabId === id) store.activeTabId = store.tabs[Math.max(0, idx - 1)].id;
  },

  /** Reopen a recently-closed tab, restoring its original name + content. */
  reopenClosed(id) {
    const i = store.closedTabs.findIndex((t) => t.id === id);
    if (i === -1) return;
    const [t] = store.closedTabs.splice(i, 1);
    const tab = { ...blankTab(), ...t };
    if (store.tabs.some((x) => x.id === tab.id)) tab.id = tabSeq++; // avoid collision with an open tab
    store.tabs.push(tab);
    store.activeTabId = tab.id;
  },

  selectTab(id) {
    store.activeTabId = id;
  },

  async runActive() {
    const tab = store.tabs.find((t) => t.id === store.activeTabId);
    if (!tab) return;
    if (!store.currentServer) { toast('Pick a server first', 'warn'); return; }
    tab.running = true;
    tab.error = null;
    tab.resultsHidden = false; // running re-opens the panel if hidden
    try {
      let result;
      if (tab.snippetId) {
        result = await api.runSnippet(tab.snippetId, {
          params: tab.snippetParams,
          ops: tab.snippetOps,
          server: store.currentServer,
          db: store.currentDb,
          writable: store.writable,
        });
      } else {
        // DBeaver-style: run the statement under the caret (or the selection),
        // not the whole editor. Lets multiple statements live in one tab.
        const target = pickStatement(tab.sql, {
          cursorOffset: tab.cursorOffset,
          selFrom: tab.selFrom,
          selTo: tab.selTo,
        });
        // `USE <db>` won't stick on a pooled connection (each query is routed to
        // a pool keyed by the selected db), so intercept it and switch the active
        // db + header the same way the picker does.
        const useDb = parseUseStatement(target.sql);
        if (useDb) {
          const match = store.databases.find((d) => d.toLowerCase() === useDb.toLowerCase()) || useDb;
          await actions.selectDatabase(match);
          toast(`Using database ${match}`, 'good');
          return; // handled — don't send USE to MySQL
        }
        result = await api.query({
          server: store.currentServer,
          db: store.currentDb,
          sql: target.sql,
          writable: store.writable,
          limit: store.prefs.defaultLimit,
        });
        if (target.kind === 'at-cursor' && target.total > 1) {
          toast(`Ran statement ${target.index + 1} of ${target.total}`, 'info');
        } else if (target.kind === 'selection') {
          toast('Ran selection', 'info');
        }
      }
      tab.result = result;
    } catch (err) {
      tab.error = err.message;
      toast(err.message, 'error');
    } finally {
      tab.running = false;
    }
  },

  /**
   * Persist a single edited cell as an UPDATE. Requires writes unlocked and a
   * detected table; targets the row by PK (or full original row if no PK).
   * Returns the affected row count.
   */
  async updateCell({ table, pks, row, col, newValue }) {
    if (!store.writable) throw new Error('writes are locked — unlock first');
    if (!store.currentServer) throw new Error('no server selected');
    if (!table) throw new Error('no table detected in the query');
    const sql = updateCellSql(table, pks || [], row, col, newValue);
    const result = await api.query({
      server: store.currentServer,
      db: store.currentDb,
      sql,
      writable: true,
      limit: 1,
    });
    return result;
  },

  openTable(name) {
    const safe = name.replace(/`/g, '');
    this.newTab({
      title: name,
      sql: `SELECT * FROM \`${safe}\`;`,
    });
  },

  async openSnippetInTab(snippet) {
    const params = {};
    const ops = {};
    (snippet.params || []).forEach((p) => { params[p] = ''; ops[p] = 'eq'; });
    this.newTab({
      title: `★ ${snippet.name}`,
      sql: snippet.sql,
      snippetId: snippet.id,
      snippetParams: params,
      snippetOps: ops,
    });
  },

  async refreshSnippets() {
    try {
      const { snippets } = await api.snippets();
      store.snippets = snippets;
    } catch (err) {
      toast(`Snippets load failed: ${err.message}`, 'error');
    }
  },

  async saveSnippet(payload) {
    try {
      if (payload.id) {
        await api.updateSnippet(payload.id, payload);
        toast('Snippet updated');
      } else {
        await api.createSnippet(payload);
        toast('Snippet saved');
      }
      await this.refreshSnippets();
    } catch (err) {
      toast(err.message, 'error');
    }
  },

  async deleteSnippet(id) {
    if (store.prefs.confirmDestructive && !confirm('Delete this snippet?')) return;
    try {
      await api.deleteSnippet(id);
      await this.refreshSnippets();
      toast('Snippet deleted');
    } catch (err) {
      toast(err.message, 'error');
    }
  },
};
