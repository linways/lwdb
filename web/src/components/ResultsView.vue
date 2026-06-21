<script setup>
import { computed, ref, watch, nextTick, onMounted, onBeforeUnmount } from 'vue';
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

// Reset the virtual window + scroll to top whenever the result or filter
// changes — otherwise a leftover window from a previous (longer) result can
// land past the new row count, showing only a row or two of many.
watch([result, filter], () => {
  visibleStart.value = 0;
  visibleEnd.value = 60;
  selectedCell.value = null;
  selectedRow.value = null;
  nextTick(() => {
    if (wrapRef.value) {
      wrapRef.value.scrollTop = 0;
      onScroll({ target: wrapRef.value });
    }
  });
});
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
const selectedCell = ref(null); // { row, col } — single-click selects; Ctrl/Cmd+C copies
const selectedRow = ref(null);  // a row object — selected by clicking its # gutter

// A cell and a row selection are mutually exclusive.
function selectCell(row, col) {
  selectedCell.value = { row, col };
  selectedRow.value = null;
}
function selectRow(row) {
  selectedRow.value = row;
  selectedCell.value = null;
}

// Tab-separated row values (no header) — pastes cleanly into a spreadsheet.
function rowTsv(row) {
  return cols.value.map((c) => cellRaw(row[c])).join('\t');
}

// Copy the selected cell or row on Ctrl/Cmd+C — unless the user has a real text
// selection (then let the browser copy that instead).
function onKeydown(e) {
  if (!(e.ctrlKey || e.metaKey) || (e.key !== 'c' && e.key !== 'C')) return;
  if (window.getSelection?.().toString()) return;
  if (selectedCell.value) {
    const { row, col } = selectedCell.value;
    copy(cellRaw(row[col]), `Copied ${col}`);
  } else if (selectedRow.value) {
    copy(rowTsv(selectedRow.value), 'Copied row');
  }
}
onMounted(() => window.addEventListener('keydown', onKeydown));
onBeforeUnmount(() => window.removeEventListener('keydown', onKeydown));

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
  const table = tableFromSql(result.value?.sql || '');
  const pks = (table && store.schema?.primaryKeys?.[table]) || [];
  valueViewer.value = {
    column: col,
    row,
    table,
    pks,
    raw: cellRaw(v),
    draft: cellRaw(v),
    pretty,
    isJson,
    isNull: v === null || v === undefined,
    saving: false,
  };
}

function unlockWrites() {
  store.writable = true;
  actions.toast('Writes unlocked — edits will modify the database', 'warn');
}

// Prettify the JSON draft in place (no-op if it isn't valid JSON).
function formatDraft() {
  try { valueViewer.value.draft = JSON.stringify(JSON.parse(valueViewer.value.draft), null, 2); }
  catch (_) { actions.toast('Not valid JSON', 'warn'); }
}

// Persist the edited value back to the DB, then reflect it in the grid.
async function saveCell() {
  const vv = valueViewer.value;
  if (!vv || vv.saving || vv.draft === vv.raw) return;
  if (!store.writable) { actions.toast('Unlock writes first (read-only)', 'warn'); return; }
  vv.saving = true;
  try {
    await actions.updateCell({ table: vv.table, pks: vv.pks, row: vv.row, col: vv.column, newValue: vv.draft });
    vv.row[vv.column] = vv.draft; // reflect in the grid without a re-query
    actions.toast(`Updated ${vv.column}`, 'good');
    valueViewer.value = null;
  } catch (e) {
    actions.toast(`Update failed: ${e.message}`, 'error');
    if (valueViewer.value) valueViewer.value.saving = false;
  }
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
              <th class="rownum">
                #
              </th>
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
              :class="{ rowsel: selectedRow === r }"
              :style="{ height: rowHeight + 'px' }"
            >
              <td
                class="rownum"
                title="Click to select row · ⌘/Ctrl+C to copy"
                @click="selectRow(r)"
              >
                {{ visibleStart + idx + 1 }}
              </td>
              <td
                v-for="c in cols"
                :key="c"
                :class="{ null: r[c] === null || r[c] === undefined, num: isNumeric(r[c]), selected: selectedCell && selectedCell.row === r && selectedCell.col === c }"
                :style="{ maxWidth: (store.prefs.maxCellWidth || 360) + 'px' }"
                :title="(fmt(r[c]) || '') + '\n\n(click to select · ⌘/Ctrl+C to copy · double-click to view)'"
                @contextmenu="openCellMenu($event, r, c)"
                @click="selectCell(r, c)"
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
          <textarea
            v-model="valueViewer.draft"
            class="vv-edit"
            spellcheck="false"
            :placeholder="valueViewer.isNull ? 'NULL' : ''"
          />
        </div>
        <div
          v-if="!store.writable && valueViewer.draft !== valueViewer.raw"
          class="vv-readonly"
        >
          🔒 lwdb is in <strong>read-only</strong> mode — your edit won't be saved until you unlock writes.
          <button
            class="btn warn"
            @click="unlockWrites"
          >
            Unlock writes
          </button>
        </div>
        <div class="footer">
          <span
            class="vv-edit-note"
            :class="{ warn: valueViewer.table && !store.writable }"
          >
            <template v-if="!valueViewer.table">
              Read-only — no single table detected in the query
            </template>
            <template v-else-if="!store.writable">
              🔒 Read-only mode — unlock writes to edit
            </template>
            <template v-else-if="!valueViewer.pks.length">
              ⚠ no primary key — matches by full row
            </template>
            <template v-else>
              Editing by {{ valueViewer.pks.join(', ') }}
            </template>
          </span>
          <div
            class="spacer"
            style="flex:1"
          />
          <button
            v-if="valueViewer.isJson"
            class="btn ghost"
            @click="formatDraft"
          >
            Format
          </button>
          <button
            class="btn ghost"
            @click="copy(valueViewer.draft, 'Value copied')"
          >
            Copy
          </button>
          <button
            v-if="valueViewer.table && !store.writable"
            class="btn warn"
            @click="unlockWrites"
          >
            Unlock to edit
          </button>
          <button
            v-else
            class="btn primary"
            :disabled="!valueViewer.table || valueViewer.draft === valueViewer.raw || valueViewer.saving"
            @click="saveCell"
          >
            {{ valueViewer.saving ? 'Updating…' : 'Update' }}
          </button>
          <button
            class="btn ghost"
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
/* must beat zebra/hover bg rules (higher specificity) — selection always shows */
.grid td.selected { background: var(--sel) !important; color: #fff; }
.grid tr.rowsel td { background: var(--sel) !important; color: #fff; }
/* row-number gutter */
.grid th.rownum, .grid td.rownum {
  width: 1%; white-space: nowrap; text-align: right;
  color: var(--text-faint); background: var(--bg-3);
  user-select: none; cursor: pointer; font-variant-numeric: tabular-nums;
}
.grid tr.rowsel td.rownum { color: #fff; }
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
.value-viewer .vv-edit {
  width: 100%; min-height: 220px; resize: vertical;
  box-sizing: border-box; padding: 10px 12px;
  background: var(--bg-2); border: 1px solid var(--border); border-radius: var(--r);
  color: var(--text); font-family: var(--font-mono); font-size: 12.5px; line-height: 1.5;
  white-space: pre; tab-size: 2;
}
.value-viewer .vv-edit:focus { border-color: var(--accent-dim); outline: none; }
.value-viewer .vv-edit-note { font-size: 11px; color: var(--text-faint); }
.value-viewer .vv-edit-note.warn { color: var(--warn); font-weight: 600; }
.value-viewer .vv-readonly {
  display: flex; align-items: center; gap: 12px;
  margin: 0 16px; padding: 8px 12px;
  font-size: 12px; color: var(--text);
  background: rgba(245, 181, 74, 0.12);
  border: 1px solid var(--warn); border-radius: var(--r);
}
.value-viewer .vv-readonly .btn { margin-left: auto; }
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
