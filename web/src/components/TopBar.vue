<script setup>
import { computed } from 'vue';
import { store, actions } from '../store.js';

const emit = defineEmits(['open-palette', 'new-snippet', 'open-settings']);

const serverLabel = computed(() => {
  const s = store.servers.find((x) => x.id === store.currentServer);
  return s ? s.label : 'pick server';
});

const isMac = /Mac|iPhone|iPad/.test(navigator.platform);
const kbdMeta = isMac ? '⌘' : 'Ctrl';

function toggleWritable() {
  store.writable = !store.writable;
}

function toggleTheme() {
  actions.setTheme(store.themeMode === 'dark' ? 'light' : 'dark');
}
</script>

<template>
  <div class="topbar">
    <div class="brand">
      lw<span>db</span>
    </div>
    <button
      class="chip"
      :class="{ loading: store.loadingDbs }"
      @click="emit('open-palette', 'pickServer')"
    >
      <span class="label">srv</span>
      <span class="val">{{ serverLabel }}</span>
      <span
        v-if="store.loadingDbs"
        class="spinner"
      />
    </button>
    <button
      class="chip"
      :class="{ disabled: !store.currentServer, loading: store.loadingTables }"
      @click="emit('open-palette', 'pickDb')"
    >
      <span class="label">db</span>
      <span class="val">{{ store.currentDb || (store.loadingDbs ? 'connecting…' : 'pick db') }}</span>
      <span
        v-if="store.loadingTables"
        class="spinner"
      />
    </button>
    <button
      v-if="store.currentDb"
      class="chip schema-chip"
      :class="{ loading: store.loadingSchema, stale: store.schema?.cached }"
      :title="store.schema?.cached
        ? `Schema from cache · ${Object.keys(store.schema.tables || {}).length} tables · click to refresh`
        : `Schema fresh · ${Object.keys(store.schema?.tables || {}).length} tables · click to refresh`"
      @click="actions.refreshSchema"
    >
      <span class="label">schema</span>
      <span class="val">
        <span v-if="store.loadingSchema">…</span>
        <span v-else>{{ Object.keys(store.schema?.tables || {}).length }}t</span>
        <span
          v-if="store.schema?.cached && !store.loadingSchema"
          class="cache-dot"
          title="cached"
        />
      </span>
      <span
        v-if="store.loadingSchema"
        class="spinner"
      />
      <span
        v-else
        class="refresh-icon"
      >↻</span>
    </button>
    <button
      class="write-pill"
      :class="{ on: store.writable }"
      @click="toggleWritable"
    >
      <span class="dot" />
      <span v-if="store.writable">write unlocked</span>
      <span v-else>read-only</span>
    </button>
    <div class="spacer" />
    <button
      class="btn ghost"
      title="New saved query"
      @click="emit('new-snippet')"
    >
      ★ new
    </button>
    <button
      class="btn ghost"
      @click="emit('open-palette', 'global')"
    >
      <span>search</span>
      <span class="kbd">{{ kbdMeta }}K</span>
    </button>
    <button
      class="chip theme-toggle"
      :title="`Theme: ${store.themeMode} (click to toggle)`"
      @click="toggleTheme"
    >
      {{ store.themeMode === 'dark' ? '☾' : '☀' }}
    </button>
    <button
      class="btn ghost gear-btn"
      title="Settings"
      @click="emit('open-settings')"
    >
      ⚙
    </button>
  </div>
</template>
