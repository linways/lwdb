<script setup>
import { ref, computed, watch } from 'vue';
import { store, actions } from '../store.js';
import ConnectionsManager from './ConnectionsManager.vue';

const emit = defineEmits(['close']);

const sections = [
  { id: 'general', label: 'General' },
  { id: 'connections', label: 'Connections' },
  { id: 'editor',  label: 'Editor'  },
  { id: 'results', label: 'Results' },
  { id: 'agents',  label: 'AI Agents' },
  { id: 'data',    label: 'Data'    },
  { id: 'about',   label: 'About'   },
];
const active = ref('general');

const prefs = store.prefs;

// `agentWrites` is a SERVER-side preference (SQLite) — the CLI/agent process
// reads it, so it can't live in browser localStorage. Load + save via the API.
const agentWrites = ref(false);
fetch('/api/preferences').then((r) => r.json()).then((j) => {
  agentWrites.value = j.preferences?.agentWrites === true;
}).catch(() => {});

async function setAgentWrites(value) {
  // Flipping ON is a deliberate, slightly risky action — confirm it.
  if (value && !confirm(
    'Allow AI agents (the lwdb CLI) to run INSERT / UPDATE / DELETE / DDL?\n\n' +
    'Agents will still need an explicit --yes confirmation per write, which they '
    + 'should only add after you approve in chat. Turn this on?')) {
    agentWrites.value = false;
    return;
  }
  agentWrites.value = value;
  try {
    await fetch('/api/preferences/agentWrites', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ value }),
    });
    actions.toast(value ? 'Agent writes ENABLED' : 'Agent writes disabled', value ? 'warn' : 'good');
  } catch (e) {
    actions.toast(`Failed to save: ${e.message}`, 'error');
  }
}

const version = ref('—');
const poolCount = ref(0);
fetch('/api/health').then((r) => r.json()).then((j) => {
  version.value = j.version || '—';
  poolCount.value = j.pools?.activePools || 0;
});
fetch('/api/version').then((r) => r.json()).then((j) => { if (j.version) version.value = j.version; });

// --- update check (GitHub latest release) ---
const update = ref({ checking: false, checked: false, error: '', current: '', latest: '', hasUpdate: false, body: '', htmlUrl: '', name: '' });

async function checkUpdates(force = false) {
  update.value.checking = true;
  update.value.error = '';
  try {
    const r = await fetch(`/api/update-check${force ? '?force=1' : ''}`);
    const j = await r.json();
    update.value = { ...update.value, ...j, checking: false, checked: true };
  } catch (e) {
    update.value = { ...update.value, checking: false, checked: true, error: e.message };
  }
}

// Open the release page in the system browser (works inside the Tauri webview
// via the local server). Falls back to window.open for plain browser use.
async function openRelease() {
  const url = update.value.htmlUrl;
  if (!url) return;
  try {
    const r = await fetch('/api/open-external', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url }),
    });
    if (!(await r.json()).ok) throw new Error('server could not open');
  } catch (_) {
    window.open(url, '_blank', 'noopener');
  }
}

// Auto-check once when the About tab is first opened.
watch(active, (v) => { if (v === 'about' && !update.value.checked) checkUpdates(); });

const cachedSchemas = computed(() => {
  let count = 0;
  for (let i = 0; i < localStorage.length; i++) {
    if (localStorage.key(i)?.startsWith('lwdb:schema:')) count++;
  }
  return count;
});

async function downloadBackup() {
  try {
    const res = await fetch('/api/backup/download');
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `lwdb-backup-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
    actions.toast('Backup downloaded', 'good');
  } catch (e) { actions.toast(e.message, 'error'); }
}

async function restoreBackup() {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'application/json';
  input.onchange = async () => {
    const file = input.files?.[0]; if (!file) return;
    try {
      const backup = JSON.parse(await file.text());
      const res = await fetch('/api/restore', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ backup, merge: true }),
      });
      if (!res.ok) throw new Error((await res.json()).error?.message || res.statusText);
      await actions.refreshSnippets();
      actions.toast('Restore complete', 'good');
    } catch (e) { actions.toast(`Restore failed: ${e.message}`, 'error'); }
  };
  input.click();
}

async function clearHistory() {
  if (prefs.confirmDestructive && !confirm('Wipe all query history?')) return;
  await fetch('/api/history', { method: 'DELETE' });
  actions.toast('History cleared', 'good');
}

function resetAll() {
  if (!confirm('Reset all settings to defaults?')) return;
  actions.resetPrefs();
}
</script>

<template>
  <div
    class="modal-overlay"
    @click.self="emit('close')"
  >
    <div class="modal settings-modal">
      <h2>Settings</h2>
      <div class="settings-body">
        <nav class="settings-nav">
          <button
            v-for="s in sections"
            :key="s.id"
            class="settings-tab"
            :class="{ active: active === s.id }"
            @click="active = s.id"
          >
            {{ s.label }}
          </button>
        </nav>

        <div class="settings-pane">
          <!-- GENERAL -->
          <section v-if="active === 'general'">
            <div class="row">
              <label>Theme</label>
              <select
                :value="store.prefs.theme"
                @change="actions.setTheme($event.target.value)"
              >
                <option value="auto">
                  Auto (follow OS)
                </option>
                <option value="dark">
                  Dark
                </option>
                <option value="light">
                  Light
                </option>
              </select>
              <p class="hint">
                Auto follows your operating system's light/dark setting.
              </p>
            </div>
            <div class="row">
              <label>Interface size</label>
              <select
                :value="store.prefs.uiDensity"
                @change="actions.setDensity($event.target.value)"
              >
                <option value="compact">
                  Compact (default)
                </option>
                <option value="comfortable">
                  Comfortable — larger
                </option>
                <option value="large">
                  Large — largest
                </option>
              </select>
              <p class="hint">
                Scales the whole interface up for easier reading and clicking. Applies immediately.
              </p>
            </div>
            <div class="row">
              <label>Default SELECT LIMIT</label>
              <input
                v-model.number="prefs.defaultLimit"
                type="number"
                min="1"
                max="5000"
              >
              <p class="hint">
                Applied automatically to SELECT/WITH that don't include their own LIMIT.
              </p>
            </div>
            <div class="row">
              <label>Remember last closed tabs</label>
              <input
                v-model.number="prefs.keepClosedTabs"
                type="number"
                min="0"
                max="100"
              >
              <p class="hint">
                Closed tabs (with content) are kept for reopening from the tab search (⌕). 0 disables.
              </p>
            </div>
            <div class="row">
              <label class="check">
                <input
                  v-model="prefs.confirmDestructive"
                  type="checkbox"
                >
                Confirm before destructive actions
              </label>
              <p class="hint">
                Snippet delete, history clear, settings reset.
              </p>
            </div>
            <div class="row">
              <label class="check">
                <input
                  v-model="prefs.writeUnlockedByDefault"
                  type="checkbox"
                >
                Start sessions with writes <strong>unlocked</strong>
              </label>
              <p class="hint">
                Takes effect next reload. Otherwise lwdb is read-only at startup.
              </p>
            </div>
          </section>

          <!-- CONNECTIONS -->
          <section v-if="active === 'connections'">
            <ConnectionsManager />
          </section>

          <!-- EDITOR -->
          <section v-if="active === 'editor'">
            <div class="row">
              <label>Font size (px)</label>
              <input
                v-model.number="prefs.editorFontSize"
                type="number"
                min="10"
                max="22"
              >
            </div>
            <div class="row">
              <label class="check">
                <input
                  v-model="prefs.uppercaseKeywords"
                  type="checkbox"
                >
                Uppercase SQL keywords in completions
              </label>
            </div>
            <div class="row">
              <label class="check">
                <input
                  v-model="prefs.tableAliases"
                  type="checkbox"
                >
                Auto-insert table alias on FROM/JOIN completion
              </label>
              <p class="hint">
                DBeaver-style — completing a table inserts a short alias (e.g. <code>settings s</code>).
              </p>
            </div>
            <div class="row">
              <label class="check">
                <input
                  v-model="prefs.showLineNumbers"
                  type="checkbox"
                >
                Show line numbers
              </label>
              <p class="hint">
                Applies immediately to the open editor.
              </p>
            </div>
            <div class="row">
              <label class="check">
                <input
                  v-model="prefs.wordWrap"
                  type="checkbox"
                >
                Word wrap long lines
              </label>
              <p class="hint">
                Applies immediately to the open editor.
              </p>
            </div>
          </section>

          <!-- RESULTS -->
          <section v-if="active === 'results'">
            <div class="row">
              <label>Max cell width (px)</label>
              <input
                v-model.number="prefs.maxCellWidth"
                type="number"
                min="80"
                max="2000"
              >
              <p class="hint">
                Long values are truncated with ellipsis. Hover to see the full value.
              </p>
            </div>
            <div class="row">
              <label>NULL displayed as</label>
              <select v-model="prefs.nullDisplay">
                <option value="NULL">
                  NULL
                </option>
                <option value="empty">
                  (empty)
                </option>
                <option value="dash">
                  —
                </option>
              </select>
            </div>
            <div class="row">
              <label class="check">
                <input
                  v-model="prefs.zebraStripes"
                  type="checkbox"
                >
                Zebra-striped rows
              </label>
            </div>
          </section>

          <!-- AI AGENTS -->
          <section v-if="active === 'agents'">
            <div class="row">
              <label class="check">
                <input
                  type="checkbox"
                  :checked="agentWrites"
                  @change="setAgentWrites($event.target.checked)"
                >
                Allow AI agents to run writes (INSERT / UPDATE / DELETE / DDL)
              </label>
              <p class="hint">
                Off by default — the <code>lwdb</code> CLI is read-only. When on, an agent
                can run writes <strong>only</strong> with an explicit <code>--yes</code> per
                command, which it should add only after you confirm in chat.
              </p>
              <p
                class="hint"
                :style="{ color: agentWrites ? 'var(--danger)' : 'var(--text-faint)' }"
              >
                Current: <strong>{{ agentWrites ? 'WRITES ALLOWED (with --yes)' : 'read-only' }}</strong>
              </p>
            </div>
            <div class="row">
              <label>How agents use it</label>
              <p class="hint">
                This is a server-side setting (stored in SQLite), so the CLI and the web UI
                agree. Agents can also read/flip it with
                <code>lwdb agent-writes</code> / <code>lwdb agent-writes on|off</code>.
              </p>
            </div>
          </section>

          <!-- DATA -->
          <section v-if="active === 'data'">
            <div class="row">
              <label>Saved queries &amp; preferences</label>
              <div class="btn-row">
                <button
                  class="btn"
                  @click="downloadBackup"
                >
                  Download backup
                </button>
                <button
                  class="btn"
                  @click="restoreBackup"
                >
                  Restore from file…
                </button>
              </div>
              <p class="hint">
                JSON snapshot of snippets, preferences, and recent history.
              </p>
            </div>
            <div class="row">
              <label>Schema cache</label>
              <div class="btn-row">
                <button
                  class="btn"
                  @click="actions.refreshSchema"
                >
                  Refresh current db
                </button>
                <button
                  class="btn"
                  @click="actions.clearSchemaCache"
                >
                  Clear all cached ({{ cachedSchemas }})
                </button>
              </div>
              <p class="hint">
                Drops localStorage caches; next db pick will refetch from the server.
              </p>
            </div>
            <div class="row">
              <label>Query history</label>
              <div class="btn-row">
                <button
                  class="btn danger"
                  @click="clearHistory"
                >
                  Clear history
                </button>
              </div>
            </div>
            <div class="row">
              <label>Reset</label>
              <div class="btn-row">
                <button
                  class="btn danger"
                  @click="resetAll"
                >
                  Reset settings to defaults
                </button>
              </div>
            </div>
          </section>

          <!-- ABOUT -->
          <section v-if="active === 'about'">
            <div class="row">
              <label>lwdb</label>
              <p class="kv">
                <span>version</span><code>{{ version }}</code>
              </p>
              <p class="kv">
                <span>active pools</span><code>{{ poolCount }}</code>
              </p>
              <p class="kv">
                <span>servers loaded</span><code>{{ store.servers.length }}</code>
              </p>
              <p class="kv">
                <span>saved queries</span><code>{{ store.snippets.length }}</code>
              </p>
            </div>

            <div class="row">
              <label>Updates</label>
              <div class="update-box">
                <div class="update-head">
                  <span
                    v-if="update.checking"
                    class="upd-status"
                  >Checking…</span>
                  <span
                    v-else-if="update.error"
                    class="upd-status err"
                  >Check failed: {{ update.error }}</span>
                  <span
                    v-else-if="update.hasUpdate"
                    class="upd-status new"
                  >Update available — v{{ update.latest }} (you have v{{ update.current }})</span>
                  <span
                    v-else-if="update.noReleases"
                    class="upd-status"
                  >No releases published yet (v{{ update.current }} installed)</span>
                  <span
                    v-else-if="update.checked"
                    class="upd-status ok"
                  >You're on the latest version (v{{ update.current }})</span>
                  <span
                    v-else
                    class="upd-status"
                  >Check GitHub for a newer release.</span>
                  <div
                    class="spacer"
                    style="flex:1"
                  />
                  <button
                    class="btn ghost"
                    :disabled="update.checking"
                    @click="checkUpdates(true)"
                  >
                    {{ update.checking ? '…' : 'Check now' }}
                  </button>
                  <button
                    v-if="update.hasUpdate"
                    class="btn primary"
                    @click="openRelease"
                  >
                    Download v{{ update.latest }}
                  </button>
                </div>
                <div
                  v-if="update.hasUpdate && update.body"
                  class="changelog"
                >
                  <div class="changelog-title">
                    What's new
                  </div>
                  <pre>{{ update.body }}</pre>
                </div>
              </div>
            </div>

            <div class="row">
              <p class="hint">
                Configuration is via the <code>LW_DB_*</code> env vars and <code>package.json#lwDb</code>. See <code>.env.example</code>.
              </p>
            </div>
          </section>
        </div>
      </div>

      <div class="footer">
        <div
          class="spacer"
          style="flex:1"
        />
        <button
          class="btn primary"
          @click="emit('close')"
        >
          Done
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.settings-modal { width: min(820px, 100%); max-height: 80vh; }
.update-box { width: 100%; }
.update-head { display: flex; align-items: center; gap: 10px; }
.upd-status { font-size: 12px; color: var(--text-dim); }
.upd-status.new { color: var(--accent); font-weight: 600; }
.upd-status.ok { color: var(--good); }
.upd-status.err { color: var(--danger); }
.changelog {
  margin-top: 10px; border: 1px solid var(--border); border-radius: var(--r);
  background: var(--bg); overflow: hidden;
}
.changelog-title {
  font-size: 10px; text-transform: uppercase; letter-spacing: 0.5px;
  color: var(--text-faint); padding: 6px 10px; background: var(--bg-3);
  border-bottom: 1px solid var(--border);
}
.changelog pre {
  margin: 0; padding: 10px; max-height: 240px; overflow: auto;
  font-family: var(--font-mono); font-size: 12px; line-height: 1.5;
  color: var(--text); white-space: pre-wrap; word-break: break-word;
}
.settings-body {
  display: grid;
  grid-template-columns: 160px 1fr;
  gap: 0;
  flex: 1;
  overflow: hidden;
}
.settings-nav {
  display: flex; flex-direction: column;
  padding: 8px 6px;
  background: var(--bg-3);
  border-right: 1px solid var(--border);
}
.settings-tab {
  text-align: left;
  padding: 6px 10px;
  border-radius: 4px;
  background: transparent;
  border: none;
  color: var(--text-dim);
  cursor: pointer;
  font-size: 13px;
}
.settings-tab:hover { color: var(--text); background: var(--bg-hover); }
.settings-tab.active { color: var(--accent); background: var(--bg-hover); }

.settings-pane {
  padding: 14px 20px;
  overflow-y: auto;
}
.settings-pane .row {
  margin-bottom: 16px;
  display: flex; flex-direction: column; gap: 4px;
}
.settings-pane .row label {
  font-size: 12px; color: var(--text);
}
.settings-pane .row label.check {
  display: flex; align-items: center; gap: 8px;
  cursor: pointer;
}
.settings-pane input[type="number"],
.settings-pane select,
.settings-pane input[type="text"] {
  background: var(--bg-3);
  border: 1px solid var(--border);
  border-radius: 4px;
  padding: 6px 10px;
  font-family: var(--font-mono);
  font-size: 12px;
  width: 180px;
}
.settings-pane select { width: 220px; }
.settings-pane .hint {
  margin: 0;
  font-size: 11px;
  color: var(--text-faint);
}
.settings-pane .btn-row { display: flex; gap: 8px; }
.settings-pane .btn.danger { color: var(--danger); }
.settings-pane .kv {
  display: flex; justify-content: space-between;
  margin: 0 0 4px 0; font-size: 12px;
  border-bottom: 1px dashed var(--border);
  padding-bottom: 4px;
}
.settings-pane .kv code {
  font-family: var(--font-mono); color: var(--accent);
  background: var(--bg-3); padding: 1px 6px; border-radius: 3px;
}
</style>
