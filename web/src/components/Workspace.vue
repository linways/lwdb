<script setup>
import { computed, ref, watch, nextTick, onMounted, onBeforeUnmount } from 'vue';
import { store, actions, activeTab } from '../store.js';
import QueryEditor from './QueryEditor.vue';
import ResultsView from './ResultsView.vue';
import ParamStrip from './ParamStrip.vue';

const emit = defineEmits(['open-palette', 'edit-snippet']);

const splitRatio = ref(0.55);
const dragging = ref(false);
const container = ref(null);

function onMouseDown(e) {
  dragging.value = true;
  document.body.style.cursor = 'row-resize';
  e.preventDefault();
}
function onMouseMove(e) {
  if (!dragging.value) return;
  const rect = container.value.getBoundingClientRect();
  const ratio = (e.clientY - rect.top) / rect.height;
  splitRatio.value = Math.min(0.9, Math.max(0.1, ratio));
}
function onMouseUp() {
  dragging.value = false;
  document.body.style.cursor = '';
}

onMounted(() => {
  window.addEventListener('mousemove', onMouseMove);
  window.addEventListener('mouseup', onMouseUp);
});
onBeforeUnmount(() => {
  window.removeEventListener('mousemove', onMouseMove);
  window.removeEventListener('mouseup', onMouseUp);
});

const hasParamStrip = computed(() => !!activeTab.value?.snippetId);
const resultsHidden = computed(() => !!activeTab.value?.resultsHidden);

// CSS Grid auto-placement puts children into defined tracks in DOM order.
// We render the rows that are actually mounted so the results pane never
// inherits the splitter's 4px track. When results are hidden, only the
// editor + a thin restore bar are shown.
const gridStyle = computed(() => {
  const editorPart = resultsHidden.value ? '1fr' : `${splitRatio.value * 100}%`;
  const tail = resultsHidden.value ? '24px' : '4px 1fr';
  return {
    gridTemplateRows: hasParamStrip.value
      ? `auto ${editorPart} ${tail}`
      : `${editorPart} ${tail}`,
  };
});

function showResults() {
  if (activeTab.value) activeTab.value.resultsHidden = false;
}

// Sync caret/selection from the editor onto the active tab so "run statement
// at cursor" knows where the caret is even when triggered from the Run button.
function onSelection(sel) {
  if (!activeTab.value) return;
  activeTab.value.cursorOffset = sel.head;
  activeTab.value.selFrom = sel.from;
  activeTab.value.selTo = sel.to;
}

function snippetMeta() {
  if (!activeTab.value?.snippetId) return null;
  return store.snippets.find((s) => s.id === activeTab.value.snippetId) || null;
}

// --- Tab search / recently-closed reopen ---
const tabSearch = ref(false);
const tabQuery = ref('');
const tabSearchInput = ref(null);

const matchedTabs = computed(() => {
  const q = tabQuery.value.trim().toLowerCase();
  const f = (t) => !q || (t.title || '').toLowerCase().includes(q) || (t.sql || '').toLowerCase().includes(q);
  return { open: store.tabs.filter(f), closed: store.closedTabs.filter(f) };
});

function openTabSearch() {
  tabSearch.value = true;
  tabQuery.value = '';
  nextTick(() => tabSearchInput.value?.focus());
}
function pickOpen(id) { actions.selectTab(id); tabSearch.value = false; }
function pickClosed(id) { actions.reopenClosed(id); tabSearch.value = false; }
</script>

<template>
  <div class="workspace">
    <div class="tabbar">
      <div
        v-for="tab in store.tabs"
        :key="tab.id"
        class="tab"
        :class="{ active: tab.id === store.activeTabId, running: tab.running }"
        @click="actions.selectTab(tab.id)"
      >
        <span
          v-if="tab.running"
          class="tab-dot"
        />
        <span class="title">{{ tab.title }}</span>
        <span
          class="close"
          @click.stop="actions.closeTab(tab.id)"
        >×</span>
      </div>
      <button
        class="tab-add"
        title="New tab"
        @click="actions.newTab()"
      >
        +
      </button>
      <button
        class="tab-search-btn"
        title="Search tabs"
        @click="openTabSearch"
      >
        ⌕
      </button>
    </div>

    <div
      v-if="tabSearch"
      class="tab-search-overlay"
      @click.self="tabSearch = false"
      @keydown.esc="tabSearch = false"
    >
      <div class="tab-search-pop">
        <input
          ref="tabSearchInput"
          v-model="tabQuery"
          class="tab-search-input"
          placeholder="Search tabs by name or SQL…"
          @keydown.esc="tabSearch = false"
        >
        <div class="tab-search-list">
          <div
            v-for="t in matchedTabs.open"
            :key="'o' + t.id"
            class="tab-search-item"
            :class="{ active: t.id === store.activeTabId }"
            @click="pickOpen(t.id)"
          >
            <span class="t-title">{{ t.title }}</span>
            <span class="t-sql">{{ (t.sql || '').replace(/\s+/g, ' ').trim().slice(0, 80) }}</span>
          </div>
          <template v-if="matchedTabs.closed.length">
            <div class="tab-search-sep">
              Recently closed
            </div>
            <div
              v-for="t in matchedTabs.closed"
              :key="'c' + t.id"
              class="tab-search-item closed"
              @click="pickClosed(t.id)"
            >
              <span class="t-title">{{ t.title }}</span>
              <span class="t-sql">{{ (t.sql || '').replace(/\s+/g, ' ').trim().slice(0, 80) }}</span>
              <span class="t-reopen">reopen</span>
            </div>
          </template>
          <div
            v-if="!matchedTabs.open.length && !matchedTabs.closed.length"
            class="tab-search-empty"
          >
            No matching tabs
          </div>
        </div>
      </div>
    </div>

    <div
      ref="container"
      class="tab-content"
      :style="gridStyle"
    >
      <ParamStrip
        v-if="activeTab && activeTab.snippetId"
        :params="snippetMeta()?.params || []"
        :values="activeTab.snippetParams"
        :ops="activeTab.snippetOps"
        @run="actions.runActive"
      />
      <div class="editor-pane">
        <div class="editor-toolbar">
          <button
            class="btn"
            @click="emit('edit-snippet', snippetMeta() || { sql: activeTab?.sql })"
          >
            ★ save as
          </button>
          <button
            class="btn primary"
            :disabled="activeTab?.running"
            @click="actions.runActive"
          >
            {{ activeTab?.running ? 'Running…' : 'Run ⌘⏎' }}
          </button>
        </div>
        <QueryEditor
          v-if="activeTab"
          v-model="activeTab.sql"
          @run="actions.runActive"
          @selection="onSelection"
        />
      </div>
      <div
        v-if="!resultsHidden"
        class="split"
        @mousedown="onMouseDown"
      />
      <ResultsView
        v-if="!resultsHidden"
        :tab="activeTab"
        @hide="activeTab && (activeTab.resultsHidden = true)"
      />
      <button
        v-else
        class="show-results-bar"
        @click="showResults"
      >
        <span class="up-arrow">▲</span>
        show results
        <span
          v-if="activeTab?.result"
          class="meta"
        >· {{ activeTab.result.rowCount }} row{{ activeTab.result.rowCount === 1 ? '' : 's' }}</span>
      </button>
    </div>
  </div>
</template>
