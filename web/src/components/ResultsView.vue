<script setup>
import { computed, ref } from 'vue';
import { store, actions } from '../store.js';
import { tableFromSql, rowToInsert, rowToUpdate, rowToDelete } from '../sqlGen.js';
import ContextMenu from './ContextMenu.vue';

const props = defineProps({ tab: { type: Object, default: null } });
defineEmits(['hide']);

const filter = ref('');
const wrapRef = ref(null);
const visibleStart = ref(0);
const visibleEnd = ref(60);
const rowHeight = 24;
const buffer = 20;

const result = computed(() => props.tab?.result || null);
const error = computed(() => props.tab?.error || null);

const rows = computed(() => result.value?.rows || []);
const cols = computed(() => {
  if (!result.value || !rows.value.length) return result.value?.fields?.map((f) => f.name) || [];
  return Object.keys(rows.value[0]);
});

const filtered = computed(() => {
  const q = filter.value.trim().toLowerCase();
  if (!q) return rows.value;
  return rows.value.filter((r) =>
    Object.values(r).some((v) => v != null && String(v).toLowerCase().includes(q))
  );
});

const visibleRows = computed(() => filtered.value.slice(visibleStart.value, visibleEnd.value));
const totalHeight = computed(() => filtered.value.length * rowHeight);
const offsetTop = computed(() => visibleStart.value * rowHeight);

function onScroll(e) {
  const top = e.target.scrollTop;
  const cap = filtered.value.length;
  const visibleCount = Math.ceil(e.target.clientHeight / rowHeight);
  const start = Math.max(0, Math.floor(top / rowHeight) - buffer);
  const end = Math.min(cap, start + visibleCount + buffer * 2);
  visibleStart.value = start;
  visibleEnd.value = end;
}

function isNumeric(v) {
  return typeof v === 'number' || (typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v));
}

function fmt(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

function nullLabel() {
  switch (store.prefs.nullDisplay) {
    case 'empty': return '';
    case 'dash':  return '—';
    default:      return 'NULL';
  }
}

function copyCsv() {
  const data = filtered.value;
  if (!data.length) return;
  const head = cols.value.join(',');
  const escape = (v) => {
    if (v === null || v === undefined) return '';
    const s = typeof v === 'object' ? JSON.stringify(v) : String(v);
    if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
    return s;
  };
  const body = data.map((r) => cols.value.map((c) => escape(r[c])).join(',')).join('\n');
  navigator.clipboard?.writeText(`${head}\n${body}`);
}

function copyJson() {
  navigator.clipboard?.writeText(JSON.stringify(filtered.value, null, 2));
}

const contextMenu = ref(null); // { x, y, items }
const valueViewer = ref(null); // { column, raw, pretty, isJson }

async function copy(text, label = 'Copied to clipboard') {
  try {
    await navigator.clipboard?.writeText(text);
    actions.toast(label, 'good');
  } catch (err) {
    actions.toast(`Copy failed: ${err.message}`, 'error');
  }
}

// Raw clipboard string for a single cell value.
function cellRaw(v) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

// Pretty-print a cell value if it's JSON; returns { pretty, isJson }.
function prettyValue(v) {
  const raw = cellRaw(v);
  const trimmed = raw.trim();
  if (trimmed && (trimmed[0] === '{' || trimmed[0] === '[')) {
    try {
      return { pretty: JSON.stringify(JSON.parse(trimmed), null, 2), isJson: true };
    } catch (_) { /* not valid JSON — fall through */ }
  }
  return { pretty: raw, isJson: false };
}

function openValueViewer(row, col) {
  const v = row[col];
  const { pretty, isJson } = prettyValue(v);
  valueViewer.value = {
    column: col,
    raw: cellRaw(v),
    pretty,
    isJson,
    isNull: v === null || v === undefined,
  };
}

function rowAsCsv(row) {
  const head = cols.value.join(',');
  const esc = (v) => {
    if (v === null || v === undefined) return '';
    const s = typeof v === 'object' ? JSON.stringify(v) : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const body = cols.value.map((c) => esc(row[c])).join(',');
  return `${head}\n${body}`;
}

function openCellMenu(event, row, col) {
  event.preventDefault();
  const sql = result.value?.sql || '';
  const table = tableFromSql(sql);
  const pks = (table && store.schema?.primaryKeys?.[table]) || [];

  const items = [];

  // Cell-level actions first — they're the most common.
  if (col) {
    const { isJson } = prettyValue(row[col]);
    items.push(
      { label: `Copy ${col}`, hint: 'cell value', run: () => copy(cellRaw(row[col]), `Copied ${col}`) },
      { label: 'View value', hint: isJson ? 'JSON' : 'text', run: () => openValueViewer(row, col) },
      { separator: true },
    );
  }

  if (table) {
    items.push(
      { label: 'Copy as INSERT', run: () => copy(rowToInsert(table, row, cols.value), 'INSERT copied') },
      { label: 'Copy as UPDATE', hint: pks.length ? `WHERE ${pks.join(', ')}` : 'WHERE all cols', run: () => copy(rowToUpdate(table, row, cols.value, pks), 'UPDATE copied') },
      { label: 'Copy as DELETE', danger: true, hint: pks.length ? `WHERE ${pks.join(', ')}` : 'WHERE all cols', run: () => copy(rowToDelete(table, row, cols.value, pks), 'DELETE copied') },
      { separator: true },
    );
  }
  items.push(
    { label: 'Copy row as CSV', run: () => copy(rowAsCsv(row), 'Row CSV copied') },
    { label: 'Copy row as JSON', run: () => copy(JSON.stringify(row, null, 2), 'Row JSON copied') },
  );
  if (!table) {
    items.push(
      { separator: true },
      { label: 'No table detected in SQL', run: () => {} },
    );
  }

  // clamp position so the menu doesn't overflow the viewport
  const menuW = 280;
  const menuH = items.length * 30 + 16;
  const x = Math.min(event.clientX, window.innerWidth - menuW - 8);
  const y = Math.min(event.clientY, window.innerHeight - menuH - 8);
  contextMenu.value = { x, y, items };
}

function downloadCsv() {
  const data = filtered.value;
  if (!data.length) return;
  const head = cols.value.join(',');
  const escape = (v) => {
    if (v === null || v === undefined) return '';
    const s = typeof v === 'object' ? JSON.stringify(v) : String(v);
    if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
    return s;
  };
  const body = data.map((r) => cols.value.map((c) => escape(r[c])).join(',')).join('\n');
  const blob = new Blob([`${head}\n${body}`], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `lwdb-${Date.now()}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}
</script>

<template>
  <div class="results-pane">
    <div
      v-if="tab?.running"
      class="run-progress"
    />
    <div class="results-toolbar">
      <input
        v-model="filter"
        class="filter"
        placeholder="Filter rows…"
      >
      <span
        v-if="result"
        class="stat"
      >
        {{ filtered.length }}<span style="color:var(--text-faint)">/{{ rows.length }}</span> rows
      </span>
      <span
        v-if="result"
        class="stat"
      >· {{ result.elapsedMs }} ms</span>
      <span
        v-if="result?.limited"
        style="color: var(--warn); font-size: 11px;"
      >· LIMIT {{ result.appliedLimit }} applied</span>
      <div class="spacer" />
      <button
        class="action"
        :disabled="!filtered.length"
        @click="copyCsv"
      >
        copy csv
      </button>
      <button
        class="action"
        :disabled="!filtered.length"
        @click="copyJson"
      >
        copy json
      </button>
      <button
        class="action"
        :disabled="!filtered.length"
        @click="downloadCsv"
      >
        download csv
      </button>
      <button
        class="action close"
        title="Hide results pane"
        @click="$emit('hide')"
      >
        ×
      </button>
    </div>
    <div
      v-if="error"
      class="error-row"
    >
      {{ error }}
    </div>
    <div
      v-else-if="!result"
      class="empty-state"
    >
      <div>No results yet</div>
      <div class="hint">
        Press <span class="kbd">⌘⏎</span> to run · <span class="kbd">⌘K</span> to search
      </div>
    </div>
    <div
      v-else-if="!rows.length"
      class="empty-state"
    >
      <div>{{ result.verb }} affected {{ result.rowCount }} row(s)</div>
    </div>
    <div
      v-else
      ref="wrapRef"
      class="grid-wrap"
      :class="{ zebra: store.prefs.zebraStripes }"
      @scroll="onScroll"
    >
      <div :style="{ height: totalHeight + 'px', position: 'relative' }">
        <table
          class="grid"
          :style="{ position: 'absolute', top: offsetTop + 'px', left: 0 }"
        >
          <thead>
            <tr>
              <th
                v-for="c in cols"
                :key="c"
              >
                {{ c }}
              </th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="(r, idx) in visibleRows"
              :key="visibleStart + idx"
              :style="{ height: rowHeight + 'px' }"
            >
              <td
                v-for="c in cols"
                :key="c"
                :class="{ null: r[c] === null || r[c] === undefined, num: isNumeric(r[c]) }"
                :style="{ maxWidth: (store.prefs.maxCellWidth || 360) + 'px' }"
                :title="(fmt(r[c]) || '') + '\n\n(double-click to view · right-click for more)'"
                @contextmenu="openCellMenu($event, r, c)"
                @dblclick="openValueViewer(r, c)"
              >
                {{ r[c] === null || r[c] === undefined ? nullLabel() : fmt(r[c]) }}
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
    <ContextMenu
      v-if="contextMenu"
      :x="contextMenu.x"
      :y="contextMenu.y"
      :items="contextMenu.items"
      @close="contextMenu = null"
    />

    <div
      v-if="valueViewer"
      class="modal-overlay"
      @click.self="valueViewer = null"
      @keydown.esc="valueViewer = null"
    >
      <div class="modal value-viewer">
        <h2>
          {{ valueViewer.column }}
          <span class="vv-tag">{{ valueViewer.isNull ? 'NULL' : (valueViewer.isJson ? 'JSON' : 'text') }}</span>
          <span class="vv-len">{{ valueViewer.raw.length }} chars</span>
        </h2>
        <div class="vv-body">
          <pre v-if="!valueViewer.isNull">{{ valueViewer.pretty }}</pre>
          <div
            v-else
            class="vv-null"
          >
            NULL
          </div>
        </div>
        <div class="footer">
          <div
            class="spacer"
            style="flex:1"
          />
          <button
            class="btn ghost"
            :disabled="valueViewer.isNull"
            @click="copy(valueViewer.raw, 'Value copied')"
          >
            Copy raw
          </button>
          <button
            v-if="valueViewer.isJson"
            class="btn ghost"
            @click="copy(valueViewer.pretty, 'Formatted JSON copied')"
          >
            Copy formatted
          </button>
          <button
            class="btn primary"
            @click="valueViewer = null"
          >
            Done
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.value-viewer { width: min(760px, 100%); max-height: 82vh; }
.value-viewer h2 {
  display: flex; align-items: center; gap: 10px;
  font-family: var(--font-mono);
}
.value-viewer .vv-tag {
  font-size: 10px; letter-spacing: 0.5px; text-transform: uppercase;
  color: var(--accent); background: var(--bg-3);
  border: 1px solid var(--border); border-radius: 4px; padding: 1px 6px;
}
.value-viewer .vv-len { font-size: 11px; color: var(--text-faint); font-weight: 400; }
.value-viewer .vv-body {
  flex: 1; overflow: auto; padding: 12px 16px;
  background: var(--bg);
}
.value-viewer .vv-body pre {
  margin: 0;
  font-family: var(--font-mono);
  font-size: 12.5px;
  line-height: 1.5;
  color: var(--text);
  white-space: pre-wrap;
  word-break: break-word;
}
.value-viewer .vv-null {
  color: var(--text-faint); font-style: italic; font-family: var(--font-mono);
}
</style>
