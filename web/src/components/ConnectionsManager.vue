<script setup>
import { ref, reactive, onMounted } from 'vue';
import { store, actions } from '../store.js';

const editing = ref(null);          // connection id being edited, or 'new', or null
const testState = reactive({ status: 'idle', msg: '' }); // idle|testing|ok|err
const form = reactive({
  id: null, label: '', host: 'localhost', port: 3306, user: 'root',
  password: '', color: '', group: '', notes: '', kind: 'local',
});

function startAdd() {
  Object.assign(form, { id: null, label: '', host: 'localhost', port: 3306, user: 'root', password: '', color: '', group: '', notes: '', kind: 'local' });
  testState.status = 'idle'; testState.msg = '';
  editing.value = 'new';
}
function startEdit(s) {
  Object.assign(form, {
    id: s.id, label: s.label, host: s.host, port: s.port, user: s.user,
    password: '', color: s.color || '', group: s.group || '', notes: s.notes || '', kind: s.kind,
  });
  testState.status = 'idle'; testState.msg = '';
  editing.value = s.id;
}
function cancel() { editing.value = null; }

// Auto-track kind from host unless the user pins it.
const kindPinned = ref(false);
function onHostInput() { if (!kindPinned.value) form.kind = form.host === 'localhost' ? 'local' : 'remote'; }
function toggleKind() { kindPinned.value = true; form.kind = form.kind === 'local' ? 'remote' : 'local'; }

async function test() {
  testState.status = 'testing'; testState.msg = '';
  try {
    const r = await actions.testConnection({ host: form.host, port: form.port, user: form.user, password: form.password });
    testState.status = 'ok'; testState.msg = `Connected in ${r.ms} ms`;
  } catch (err) { testState.status = 'err'; testState.msg = err.message; }
}

async function save() {
  const payload = { ...form, _editing: editing.value !== 'new' };
  // On edit, don't overwrite the stored password with an empty field.
  if (payload._editing && !form.password) delete payload.password;
  try { await actions.saveConnection(payload); editing.value = null; }
  catch (_) { /* toast already shown */ }
}

onMounted(() => { if (!store.servers.length) startAdd(); });
</script>

<template>
  <div class="conn-mgr">
    <div
      v-if="editing === null"
      class="conn-list"
    >
      <div class="conn-head">
        <h3>Connections</h3>
        <button
          class="btn primary"
          @click="startAdd"
        >
          + Add connection
        </button>
      </div>
      <p
        v-if="!store.servers.length"
        class="empty"
      >
        No connections yet. Add your first connection to get started.
      </p>
      <ul v-else>
        <li
          v-for="s in store.servers"
          :key="s.id"
          class="conn-row"
        >
          <span
            class="dot"
            :style="{ background: s.color || '#94a3b8' }"
          />
          <span class="label">{{ s.label || s.id }}</span>
          <span class="meta">{{ s.user }}@{{ s.host }}:{{ s.port }}</span>
          <span
            v-if="s.group"
            class="chip"
          >{{ s.group }}</span>
          <span class="kind">{{ s.kind }}</span>
          <span class="actions">
            <button
              class="btn"
              @click="startEdit(s)"
            >Edit</button>
            <button
              class="btn danger"
              @click="actions.deleteConnection(s.id)"
            >Delete</button>
          </span>
        </li>
      </ul>
    </div>

    <form
      v-else
      class="conn-form"
      @submit.prevent="save"
    >
      <h3>{{ editing === 'new' ? 'Add connection' : 'Edit connection' }}</h3>
      <label>Label<input
        v-model="form.label"
        required
        placeholder="V4 · Server 84"
      ></label>
      <div class="row">
        <label class="grow">Host<input
          v-model="form.host"
          required
          placeholder="localhost or 127.0.0.1"
          @input="onHostInput"
        ></label>
        <label class="port">Port<input
          v-model.number="form.port"
          type="number"
          min="1"
          max="65535"
        ></label>
      </div>
      <div class="row">
        <label class="grow">User<input
          v-model="form.user"
          required
        ></label>
        <label class="grow">Password<input
          v-model="form.password"
          type="password"
          :placeholder="editing !== 'new' ? '(unchanged)' : ''"
        ></label>
      </div>
      <div class="row">
        <label class="color">Color<input
          v-model="form.color"
          type="text"
          placeholder="#dc2626"
        ></label>
        <label class="grow">Group<input
          v-model="form.group"
          placeholder="production"
        ></label>
        <label class="kind-toggle">
          <input
            type="checkbox"
            :checked="form.kind === 'local'"
            @change="toggleKind"
          > Treat as local
        </label>
      </div>
      <label>Notes<textarea
        v-model="form.notes"
        rows="2"
      /></label>

      <div class="test-row">
        <button
          type="button"
          class="btn"
          :disabled="testState.status === 'testing'"
          @click="test"
        >
          {{ testState.status === 'testing' ? 'Testing…' : 'Test connection' }}
        </button>
        <span :class="['test-msg', testState.status]">{{ testState.msg }}</span>
      </div>

      <div class="form-actions">
        <button
          type="button"
          class="btn"
          @click="cancel"
        >
          Cancel
        </button>
        <button
          type="submit"
          class="btn primary"
        >
          {{ editing === 'new' ? 'Add' : 'Save' }}
        </button>
      </div>
    </form>
  </div>
</template>

<style scoped>
.conn-mgr { display: flex; flex-direction: column; gap: 12px; }
.conn-head { display: flex; justify-content: space-between; align-items: center; }
.empty { color: var(--muted, #94a3b8); padding: 16px 0; }
.conn-row { display: flex; align-items: center; gap: 10px; padding: 8px 0; border-bottom: 1px solid var(--border, #1f2937); }
.conn-row .dot { width: 10px; height: 10px; border-radius: 50%; flex: none; }
.conn-row .label { font-weight: 600; }
.conn-row .meta { color: var(--muted, #94a3b8); font-size: 12px; }
.conn-row .chip { font-size: 11px; padding: 1px 6px; border-radius: 8px; background: var(--border, #1f2937); }
.conn-row .kind { font-size: 11px; color: var(--muted, #94a3b8); }
.conn-row .actions { margin-left: auto; display: flex; gap: 6px; }
.conn-form { display: flex; flex-direction: column; gap: 10px; max-width: 560px; }
.conn-form label { display: flex; flex-direction: column; gap: 4px; font-size: 12px; }
.conn-form input, .conn-form textarea { padding: 6px 8px; border-radius: 6px; border: 1px solid var(--border, #1f2937); background: var(--bg, #0b1220); color: inherit; }
.row { display: flex; gap: 10px; }
.row .grow { flex: 1; }
.row .port input { width: 90px; }
.kind-toggle { flex-direction: row; align-items: center; gap: 6px; align-self: end; }
.test-row { display: flex; align-items: center; gap: 10px; }
.test-msg.ok { color: #16a34a; }
.test-msg.err { color: #dc2626; }
.form-actions { display: flex; justify-content: flex-end; gap: 8px; }
.btn.primary { background: var(--accent, #2563eb); color: #fff; }
.btn.danger { color: #dc2626; }
</style>
