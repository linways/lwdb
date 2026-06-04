import { reactive, computed, watch } from 'vue';
import { api } from './api.js';
import { loadPrefs, savePrefs, DEFAULT_PREFS } from './prefs.js';
import { pickStatement } from './sqlStatements.js';

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

export const store = reactive({
  servers: [],
  currentServer: null,
  databases: [],
  currentDb: null,
  tables: [],
  tableFilter: '',
  schema: { tables: {}, columnCount: 0, fetchedAt: null }, // { tableName: [col, ...] } for the active (server, db)
  snippets: [],
  snippetFilter: '',
  tabs: [blankTab()],
  activeTabId: 1,
  writable: !!initialPrefs.writeUnlockedByDefault,
  loadingDbs: false,
  loadingTables: false,
  loadingSchema: false,
  toast: null,
  connectionsOpen: false,
  prefs: { ...initialPrefs },
});

// Persist prefs whenever they change.
watch(() => ({ ...store.prefs }), (val) => savePrefs(val), { deep: true });

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

  /** Reset all user prefs to defaults. */
  resetPrefs() {
    Object.assign(store.prefs, DEFAULT_PREFS);
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
    store.tabs.splice(idx, 1);
    if (!store.tabs.length) store.tabs.push(blankTab());
    if (store.activeTabId === id) store.activeTabId = store.tabs[Math.max(0, idx - 1)].id;
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
