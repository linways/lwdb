<script setup>
// Interactive write approvals. An agent (CLI/MCP) can request approval for one
// specific write; this panel polls the server for pending requests and lets the
// human approve or deny THAT exact statement. The write executes server-side
// only on approval — nothing here runs SQL directly.
import { ref, onMounted, onBeforeUnmount } from 'vue';
import { api } from '../api.js';

const pending = ref([]);
const busy = ref(null);     // id currently being resolved
const errored = ref(null);  // { id, message }
let timer = null;

async function poll() {
  try {
    pending.value = (await api.approvals()).approvals || [];
  } catch {
    // server unreachable (e.g. shutting down) — keep the last view, try again next tick
  }
}

async function resolve(id, decision) {
  busy.value = id;
  errored.value = null;
  try {
    await api.resolveApproval(id, decision);
    await poll();
  } catch (e) {
    errored.value = { id, message: e.message || 'failed' };
  } finally {
    busy.value = null;
  }
}

onMounted(() => {
  poll();
  timer = setInterval(poll, 2000);
});
onBeforeUnmount(() => clearInterval(timer));
</script>

<template>
  <div
    v-if="pending.length"
    class="approvals-overlay"
  >
    <div class="approvals-modal">
      <header>
        <span class="badge">⚠ write approval</span>
        <h2>{{ pending.length }} write{{ pending.length === 1 ? '' : 's' }} awaiting your approval</h2>
        <p class="sub">
          An agent is requesting permission to run {{ pending.length === 1 ? 'this statement' : 'these statements' }}. Review the SQL, then approve or deny.
        </p>
      </header>

      <ul class="list">
        <li
          v-for="a in pending"
          :key="a.id"
          class="item"
        >
          <div class="target">
            <span class="server">{{ a.server }}</span><span
              v-if="a.db"
              class="db"
            >.{{ a.db }}</span>
          </div>
          <pre class="sql">{{ a.sql }}</pre>
          <p
            v-if="errored && errored.id === a.id"
            class="err"
          >
            {{ errored.message }}
          </p>
          <div class="actions">
            <button
              class="btn deny"
              :disabled="busy === a.id"
              @click="resolve(a.id, 'deny')"
            >
              Deny
            </button>
            <button
              class="btn approve"
              :disabled="busy === a.id"
              @click="resolve(a.id, 'approve')"
            >
              {{ busy === a.id ? 'Running…' : 'Approve & run' }}
            </button>
          </div>
        </li>
      </ul>
    </div>
  </div>
</template>

<style scoped>
.approvals-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.55);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
}
.approvals-modal {
  width: min(640px, 92vw);
  max-height: 82vh;
  overflow-y: auto;
  background: var(--bg-2, #1b1b1b);
  border: 1px solid var(--warn, #d9a441);
  border-radius: 10px;
  box-shadow: 0 18px 50px rgba(0, 0, 0, 0.5);
}
header {
  padding: 16px 20px 8px;
  border-bottom: 1px solid var(--border, #333);
}
.badge {
  display: inline-block;
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: var(--warn, #d9a441);
}
header h2 { margin: 6px 0 4px; font-size: 16px; }
.sub { margin: 0; font-size: 12.5px; color: var(--muted, #999); }
.list { list-style: none; margin: 0; padding: 8px 12px 14px; }
.item {
  padding: 12px;
  border: 1px solid var(--border, #333);
  border-radius: 8px;
  margin-top: 10px;
  background: var(--bg, #151515);
}
.target { font-size: 12px; margin-bottom: 6px; }
.target .server { font-weight: 600; }
.target .db { color: var(--muted, #999); }
.sql {
  margin: 0 0 10px;
  padding: 10px 12px;
  background: var(--bg-2, #1b1b1b);
  border: 1px solid var(--border, #333);
  border-radius: 6px;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 12.5px;
  white-space: pre-wrap;
  word-break: break-word;
  max-height: 30vh;
  overflow-y: auto;
}
.err { margin: 0 0 8px; color: var(--danger, #e06c75); font-size: 12px; }
.actions { display: flex; justify-content: flex-end; gap: 8px; }
.btn {
  padding: 7px 14px;
  border-radius: 6px;
  border: 1px solid var(--border, #333);
  cursor: pointer;
  font-size: 13px;
  background: var(--bg-2, #222);
  color: inherit;
}
.btn:disabled { opacity: 0.6; cursor: default; }
.btn.deny:hover:not(:disabled) { border-color: var(--danger, #e06c75); color: var(--danger, #e06c75); }
.btn.approve {
  background: var(--accent, #4a8cff);
  border-color: var(--accent, #4a8cff);
  color: #fff;
  font-weight: 600;
}
.btn.approve:hover:not(:disabled) { filter: brightness(1.08); }
</style>
