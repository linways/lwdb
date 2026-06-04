<script setup>
import { ref, computed, onMounted, watch, nextTick } from 'vue';
import { store, actions } from '../store.js';

const props = defineProps({ mode: { type: String, default: 'global' } });
const emit = defineEmits(['close', 'edit-snippet', 'open-settings']);

const q = ref('');
const focusIdx = ref(0);
const inputRef = ref(null);
const mode = ref(props.mode);
const history = ref([]);
const tablesCache = ref([]);

function score(text, needle) {
  if (!needle) return 1;
  const t = text.toLowerCase();
  const n = needle.toLowerCase();
  if (t === n) return 1000;
  if (t.startsWith(n)) return 500;
  if (t.includes(n)) return 250;
  let ti = 0, ni = 0, gaps = 0, lastMatch = -2;
  while (ti < t.length && ni < n.length) {
    if (t[ti] === n[ni]) {
      if (ti !== lastMatch + 1) gaps++;
      lastMatch = ti;
      ni++;
    }
    ti++;
  }
  if (ni < n.length) return 0;
  return 100 - gaps;
}

function fuzzyFilter(items, key) {
  if (!q.value) return items.slice(0, 30);
  const needle = q.value;
  return items
    .map((it) => ({ it, s: score(key ? key(it) : String(it), needle) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s)
    .slice(0, 30)
    .map((x) => x.it);
}

const servers = computed(() => fuzzyFilter(store.servers, (s) => `${s.id} ${s.label} ${s.host}`));
const databases = computed(() => {
  if (!store.databases.length) return [];
  return fuzzyFilter(store.databases, (d) => d);
});
const tables = computed(() => fuzzyFilter(tablesCache.value, (t) => t.name));
const snippets = computed(() => fuzzyFilter(store.snippets, (s) => `${s.name} ${s.description} ${(s.tags || []).join(' ')}`));
const recent = computed(() => fuzzyFilter(history.value, (h) => `${h.sql} ${h.server} ${h.db || ''}`));

const actionsList = computed(() => fuzzyFilter([
  { id: 'new-tab', label: 'New tab', sub: 'Open a fresh query tab', run: () => { actions.newTab(); emit('close'); } },
  { id: 'new-snippet', label: 'New saved query', sub: 'Create a parametrized template', run: () => { emit('edit-snippet', null); emit('close'); } },
  { id: 'toggle-write', label: store.writable ? 'Lock writes' : 'Unlock writes', sub: store.writable ? 'Block non-SELECT statements' : 'Allow INSERT/UPDATE/DELETE/DDL', run: () => { store.writable = !store.writable; actions.toast(store.writable ? 'Writes UNLOCKED' : 'Writes locked', store.writable ? 'warn' : 'good'); emit('close'); } },
  { id: 'backup', label: 'Download backup', sub: 'Save snippets, prefs, history as JSON', run: async () => { try { const res = await fetch('/api/backup/download'); const blob = await res.blob(); const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url; a.download = `lwdb-backup-${new Date().toISOString().slice(0,10)}.json`; a.click(); URL.revokeObjectURL(url); actions.toast('Backup downloaded', 'good'); } catch (e) { actions.toast(e.message, 'error'); } emit('close'); } },
  { id: 'restore', label: 'Restore from backup file', sub: 'Pick a JSON backup (merge mode)', run: async () => {
      const input = document.createElement('input'); input.type = 'file'; input.accept = 'application/json';
      input.onchange = async () => {
        const file = input.files?.[0]; if (!file) return;
        const text = await file.text();
        try {
          const backup = JSON.parse(text);
          const res = await fetch('/api/restore', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ backup, merge: true }) });
          if (!res.ok) throw new Error((await res.json()).error?.message || res.statusText);
          await actions.refreshSnippets();
          actions.toast('Restore complete', 'good');
        } catch (e) { actions.toast(`Restore failed: ${e.message}`, 'error'); }
      };
      input.click();
      emit('close');
    } },
  { id: 'clear-history', label: 'Clear query history', sub: 'Wipe local history (irreversible)', run: async () => { if (!confirm('Clear all query history?')) return; await fetch('/api/history', { method: 'DELETE' }); actions.toast('History cleared'); emit('close'); } },
  { id: 'add-connection', label: '+ Add connection', sub: 'Open the Connections manager', run: () => { actions.openConnections(); emit('close'); } },
  { id: 'open-settings', label: 'Open settings', sub: 'Editor, results, data, about', run: () => { emit('open-settings'); emit('close'); } },
  { id: 'refresh-schema', label: 'Refresh schema (current db)', sub: 'Re-fetch table/column completions for the active db', run: async () => { await actions.refreshSchema(); emit('close'); } },
  { id: 'clear-schema-cache', label: 'Clear all cached schemas', sub: 'Force every db to re-fetch on next pick', run: () => { actions.clearSchemaCache(); emit('close'); } },
], (a) => `${a.label} ${a.sub}`));

const groups = computed(() => {
  const g = [];
  if (mode.value === 'pickServer') {
    if (servers.value.length) g.push({ title: 'Servers', items: servers.value.map((s) => ({ ...s, kind: 'server' })) });
    return g;
  }
  if (mode.value === 'pickDb') {
    if (databases.value.length) g.push({ title: `Databases on ${store.currentServer}`, items: databases.value.map((d) => ({ kind: 'db', name: d })) });
    return g;
  }
  if (snippets.value.length) g.push({ title: 'Saved queries', items: snippets.value.map((s) => ({ kind: 'snippet', ...s })) });
  if (tables.value.length) g.push({ title: 'Tables', items: tables.value.map((t) => ({ kind: 'table', ...t })) });
  if (databases.value.length && q.value) g.push({ title: 'Databases', items: databases.value.map((d) => ({ kind: 'db', name: d })) });
  if (servers.value.length && q.value) g.push({ title: 'Servers', items: servers.value.map((s) => ({ ...s, kind: 'server' })) });
  if (recent.value.length) g.push({ title: 'Recent queries', items: recent.value.map((h) => ({ kind: 'recent', ...h })) });
  if (actionsList.value.length) g.push({ title: 'Actions', items: actionsList.value.map((a) => ({ kind: 'action', ...a })) });
  return g;
});

const flat = computed(() => groups.value.flatMap((g) => g.items));

watch(q, () => { focusIdx.value = 0; });

function activate(item) {
  if (!item) return;
  switch (item.kind) {
    case 'server':
      actions.selectServer(item.id);
      emit('close');
      break;
    case 'db':
      actions.selectDatabase(item.name);
      emit('close');
      break;
    case 'table':
      actions.openTable(item.name);
      emit('close');
      break;
    case 'snippet':
      actions.openSnippetInTab(item);
      emit('close');
      break;
    case 'recent':
      actions.newTab({ title: 'Recent', sql: item.sql });
      emit('close');
      break;
    case 'action':
      item.run();
      break;
  }
}

// The text to put on the clipboard for a given row (null = not copyable).
function copyTextFor(item) {
  switch (item.kind) {
    case 'db':
    case 'table':
    case 'snippet': return item.name;
    case 'server': return item.id;
    case 'recent': return item.sql;
    default: return null;
  }
}

async function onCopy(item) {
  const text = copyTextFor(item);
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
    actions.toast(`Copied "${text.length > 40 ? text.slice(0, 40) + '…' : text}"`, 'good');
  } catch (err) {
    actions.toast(`Copy failed: ${err.message}`, 'error');
  }
}

function onKey(e) {
  if (e.key === 'ArrowDown') { focusIdx.value = Math.min(flat.value.length - 1, focusIdx.value + 1); e.preventDefault(); }
  else if (e.key === 'ArrowUp') { focusIdx.value = Math.max(0, focusIdx.value - 1); e.preventDefault(); }
  else if (e.key === 'Enter') { activate(flat.value[focusIdx.value]); e.preventDefault(); }
}

async function loadHistory() {
  try {
    const { history: h } = await fetch('/api/history?limit=20').then((r) => r.json());
    history.value = h.filter((x) => x.ok);
  } catch (_) { /* ignore */ }
}

async function loadTables() {
  tablesCache.value = store.tables;
}

onMounted(async () => {
  await nextTick();
  inputRef.value?.focus();
  await loadHistory();
  await loadTables();
});

watch(() => store.tables, (v) => { tablesCache.value = v; });
</script>

<template>
  <div
    class="palette-overlay"
    @click.self="emit('close')"
  >
    <div
      class="palette"
      @keydown="onKey"
    >
      <div class="breadcrumb">
        <span v-if="mode === 'pickServer'">Pick server</span>
        <span v-else-if="mode === 'pickDb'">Pick database <span class="chip-sm">{{ store.currentServer }}</span></span>
        <span v-else>
          <span
            v-if="store.currentServer"
            class="chip-sm"
          >{{ store.currentServer }}</span>
          <span
            v-if="store.currentDb"
            class="chip-sm"
          >{{ store.currentDb }}</span>
          <span v-if="!store.currentServer">Search anything…</span>
        </span>
      </div>
      <input
        ref="inputRef"
        v-model="q"
        class="palette-input"
        :placeholder="mode === 'pickServer' ? 'Filter servers' : mode === 'pickDb' ? 'Filter databases (try: stthomas)' : 'Search tables, snippets, history, actions…'"
      >
      <div class="palette-list">
        <template
          v-for="(group, gi) in groups"
          :key="gi"
        >
          <div class="palette-group">
            {{ group.title }}
          </div>
          <div
            v-for="(item, ii) in group.items"
            :key="`${gi}-${ii}-${item.id || item.name}`"
            class="palette-item"
            :class="{ focused: flat.indexOf(item) === focusIdx }"
            @mouseenter="focusIdx = flat.indexOf(item)"
            @click="activate(item)"
          >
            <span class="icon">
              <span v-if="item.kind === 'server'">⊙</span>
              <span v-else-if="item.kind === 'db'">▣</span>
              <span v-else-if="item.kind === 'table'">≡</span>
              <span v-else-if="item.kind === 'snippet'">★</span>
              <span v-else-if="item.kind === 'recent'">↺</span>
              <span v-else>→</span>
            </span>
            <span v-if="item.kind === 'server'"><span
              class="cmd-dot"
              :style="{ background: item.color || 'transparent' }"
            />{{ item.label }}<span class="sub">{{ item.host }}:{{ item.port }}</span></span>
            <span v-else-if="item.kind === 'db'">{{ item.name }}</span>
            <span v-else-if="item.kind === 'table'">{{ item.name }}<span
              v-if="item.rowsApprox"
              class="sub"
            >~{{ item.rowsApprox }} rows</span></span>
            <span v-else-if="item.kind === 'snippet'">{{ item.name }}<span class="sub">{{ item.description }}</span></span>
            <span v-else-if="item.kind === 'recent'"><code style="font-family: var(--font-mono); font-size: 11.5px; color: var(--text-dim);">{{ item.sql.slice(0, 80) }}{{ item.sql.length > 80 ? '…' : '' }}</code></span>
            <span v-else>{{ item.label }}<span class="sub">{{ item.sub }}</span></span>
            <span class="meta">
              <span v-if="item.kind === 'snippet' && item.params?.length">:{{ item.params.join(' :') }}</span>
              <span v-else-if="item.kind === 'recent'">{{ item.server }}/{{ item.db || '' }}</span>
            </span>
            <button
              v-if="copyTextFor(item)"
              class="copy-btn"
              :title="`Copy ${copyTextFor(item)}`"
              @click.stop="onCopy(item)"
            >
              ⧉
            </button>
          </div>
        </template>
        <div
          v-if="!flat.length"
          class="palette-empty"
        >
          No matches.
        </div>
      </div>
      <div class="palette-hint">
        <span><span class="kbd">↑↓</span> navigate</span>
        <span><span class="kbd">⏎</span> open</span>
        <span><span class="kbd">esc</span> close</span>
      </div>
    </div>
  </div>
</template>
