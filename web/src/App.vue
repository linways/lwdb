<script setup>
import { onMounted, onBeforeUnmount, ref } from 'vue';
import { store, actions } from './store.js';
import TopBar from './components/TopBar.vue';
import Workspace from './components/Workspace.vue';
import CommandPalette from './components/CommandPalette.vue';
import SnippetEditor from './components/SnippetEditor.vue';
import Settings from './components/Settings.vue';
import ConnectionsManager from './components/ConnectionsManager.vue';
import StatusBar from './components/StatusBar.vue';
import Toast from './components/Toast.vue';

const paletteOpen = ref(false);
const paletteMode = ref('global');
const editingSnippet = ref(null);
const settingsOpen = ref(false);

function openPalette(mode = 'global') {
  paletteMode.value = mode;
  paletteOpen.value = true;
}
function closePalette() { paletteOpen.value = false; }

function onKeydown(e) {
  // Editor (CodeMirror) handles its own keys and calls preventDefault — don't
  // re-fire the same action via the global handler.
  if (e.defaultPrevented) return;

  const mod = e.metaKey || e.ctrlKey;
  const key = e.key.toLowerCase();
  const inModal = paletteOpen.value || editingSnippet.value || settingsOpen.value || store.connectionsOpen;

  // Esc — close any open modal/palette
  if (e.key === 'Escape') {
    if (paletteOpen.value) { closePalette(); return; }
    if (editingSnippet.value) { editingSnippet.value = null; return; }
    if (settingsOpen.value) { settingsOpen.value = false; return; }
    if (store.connectionsOpen) { actions.closeConnections(); return; }
  }

  // Cmd/Ctrl+, — open settings (matches OS-wide convention)
  if (mod && e.key === ',') {
    e.preventDefault();
    settingsOpen.value = !settingsOpen.value;
    return;
  }

  // Ctrl/Cmd+K — toggle palette (DBeaver Ctrl+3 ~ similar; keep K — universal modern app)
  if (mod && key === 'k') {
    e.preventDefault();
    paletteOpen.value ? closePalette() : openPalette('global');
    return;
  }

  if (inModal) return; // remaining shortcuts only when no modal open

  // Run query — Ctrl/Cmd+Enter (DBeaver: Ctrl+Enter, Ctrl+Return)
  if (mod && e.key === 'Enter') {
    e.preventDefault();
    actions.runActive();
    return;
  }
  // Run query — F5 (DBeaver alias)
  if (e.key === 'F5') {
    e.preventDefault();
    actions.runActive();
    return;
  }

  // New tab — Ctrl/Cmd+T (DBeaver: Ctrl+Shift+T new editor; keep Ctrl+T as a more universal feel)
  if (mod && key === 't' && !e.shiftKey) {
    e.preventDefault();
    actions.newTab();
    return;
  }
  // Close tab — Ctrl/Cmd+W (DBeaver: Ctrl+F4)
  if (mod && key === 'w') {
    e.preventDefault();
    actions.closeTab(store.activeTabId);
    return;
  }
  if (mod && e.key === 'F4') {
    e.preventDefault();
    actions.closeTab(store.activeTabId);
    return;
  }

  // Save current SQL as snippet — Ctrl/Cmd+S (DBeaver: Ctrl+S)
  if (mod && key === 's' && !e.shiftKey) {
    e.preventDefault();
    const tab = store.tabs.find((t) => t.id === store.activeTabId);
    if (tab) {
      const existing = tab.snippetId ? store.snippets.find((s) => s.id === tab.snippetId) : null;
      handleEditSnippet(existing || { sql: tab.sql });
    }
    return;
  }

  // Cycle tabs — Ctrl+Tab / Ctrl+Shift+Tab (works on most platforms)
  if (e.ctrlKey && e.key === 'Tab') {
    e.preventDefault();
    const idx = store.tabs.findIndex((t) => t.id === store.activeTabId);
    if (idx === -1) return;
    const nextIdx = e.shiftKey
      ? (idx - 1 + store.tabs.length) % store.tabs.length
      : (idx + 1) % store.tabs.length;
    actions.selectTab(store.tabs[nextIdx].id);
    return;
  }

  // Toggle write mode — Ctrl/Cmd+Shift+W
  if (mod && e.shiftKey && key === 'w') {
    e.preventDefault();
    store.writable = !store.writable;
    actions.toast(store.writable ? 'Writes UNLOCKED' : 'Writes locked', store.writable ? 'warn' : 'good');
  }
}

onMounted(async () => {
  window.addEventListener('keydown', onKeydown);
  await actions.init();
});
onBeforeUnmount(() => window.removeEventListener('keydown', onKeydown));

function handleEditSnippet(s) { editingSnippet.value = s || { name: '', sql: '', description: '', tags: [], defaultServer: null, defaultDb: null }; }
async function handleSaveSnippet(payload) {
  await actions.saveSnippet(payload);
  editingSnippet.value = null;
}
</script>

<template>
  <div class="app">
    <TopBar
      @open-palette="openPalette"
      @new-snippet="handleEditSnippet(null)"
      @open-settings="settingsOpen = true"
    />
    <Workspace
      @open-palette="openPalette"
      @edit-snippet="handleEditSnippet"
    />
    <StatusBar />
    <CommandPalette
      v-if="paletteOpen"
      :mode="paletteMode"
      @close="closePalette"
      @edit-snippet="handleEditSnippet"
      @open-settings="settingsOpen = true"
    />
    <SnippetEditor
      v-if="editingSnippet"
      :snippet="editingSnippet"
      @save="handleSaveSnippet"
      @cancel="editingSnippet = null"
      @delete="(id) => { actions.deleteSnippet(id); editingSnippet = null; }"
    />
    <Settings
      v-if="settingsOpen"
      @close="settingsOpen = false"
    />
    <div
      v-if="store.connectionsOpen"
      class="modal-overlay"
      @click.self="actions.closeConnections()"
    >
      <div class="modal connections-modal">
        <h2>Connections</h2>
        <div class="connections-body">
          <ConnectionsManager />
        </div>
        <div class="footer">
          <button
            class="btn primary"
            @click="actions.closeConnections()"
          >
            Done
          </button>
        </div>
      </div>
    </div>
    <Toast
      v-if="store.toast"
      :toast="store.toast"
    />
  </div>
</template>

<style scoped>
.connections-modal { width: min(820px, 100%); max-height: 80vh; }
.connections-body { padding: 14px 20px; overflow-y: auto; flex: 1; }
</style>
