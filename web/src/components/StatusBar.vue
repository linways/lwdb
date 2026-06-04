<script setup>
import { computed } from 'vue';
import { store, activeTab } from '../store.js';

const isMac = /Mac|iPhone|iPad/.test(navigator.platform);
const kbdMeta = isMac ? '⌘' : 'Ctrl';

const isBusy = computed(() => store.loadingDbs || store.loadingTables || activeTab.value?.running);
const connHealthy = computed(() => !!store.currentServer && !!store.databases.length);
const activeServer = computed(() => store.servers.find((s) => s.id === store.currentServer));
const lastElapsed = computed(() => activeTab.value?.result?.elapsedMs ?? null);
</script>

<template>
  <div
    class="statusbar"
    :class="{ busy: isBusy }"
  >
    <span
      class="dot"
      :class="{ ok: connHealthy && !isBusy, busy: isBusy, idle: !connHealthy && !isBusy }"
    />
    <span v-if="isBusy">{{ activeTab?.running ? 'running query…' : (store.loadingDbs ? 'connecting…' : 'loading tables…') }}</span>
    <span v-else-if="activeServer">{{ activeServer.host }}<span v-if="activeServer.port !== 3306">:{{ activeServer.port }}</span></span>
    <span v-else>not connected</span>
    <span class="sep">·</span>
    <span>{{ store.tables.length }} table{{ store.tables.length === 1 ? '' : 's' }}</span>
    <span class="sep">·</span>
    <span>{{ store.snippets.length }} saved</span>
    <span class="sep">·</span>
    <span>{{ store.tabs.length }} tab{{ store.tabs.length === 1 ? '' : 's' }}</span>
    <span
      v-if="lastElapsed !== null"
      class="sep"
    >·</span>
    <span v-if="lastElapsed !== null">last: {{ lastElapsed }}ms</span>
    <span class="spacer" />
    <span class="hint"><span class="kbd">{{ kbdMeta }}K</span> search</span>
    <span class="hint"><span class="kbd">{{ kbdMeta }}⏎</span> run</span>
  </div>
</template>

<style scoped>
.statusbar {
  display: flex;
  align-items: center;
  gap: 8px;
  height: 22px;
  padding: 0 10px;
  border-top: 1px solid var(--border);
  background: var(--bg-2);
  font-size: 11px;
  color: var(--text-dim);
  font-family: var(--font-mono);
}
.dot {
  width: 7px; height: 7px; border-radius: 50%;
  background: var(--text-faint);
}
.dot.ok { background: var(--good); box-shadow: 0 0 4px rgba(111,207,115,0.6); }
.dot.idle { background: var(--text-faint); }
.dot.busy {
  background: var(--accent);
  box-shadow: 0 0 6px rgba(90, 209, 255, 0.7);
  animation: pulse 1.1s ease-in-out infinite;
}
.sep { color: var(--border-strong); }
.spacer { flex: 1; }
.hint { display: inline-flex; gap: 4px; align-items: center; }
.kbd {
  background: var(--bg-3);
  border: 1px solid var(--border);
  border-radius: 3px;
  padding: 0 4px;
  font-size: 10px;
  color: var(--text-dim);
}
</style>
