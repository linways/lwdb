<script setup>
import { reactive, computed, watch } from 'vue';
import { store } from '../store.js';

const props = defineProps({ snippet: { type: Object, required: true } });
const emit = defineEmits(['save', 'cancel', 'delete']);

const form = reactive({
  id: props.snippet.id || null,
  name: props.snippet.name || '',
  description: props.snippet.description || '',
  sql: props.snippet.sql || '',
  tags: (props.snippet.tags || []).join(', '),
  defaultServer: props.snippet.defaultServer || '',
  defaultDb: props.snippet.defaultDb || '',
});

const params = computed(() => {
  const out = [];
  const re = /:([a-zA-Z_][a-zA-Z0-9_]*)/g;
  let m;
  const seen = new Set();
  while ((m = re.exec(form.sql)) !== null) {
    if (!seen.has(m[1])) { seen.add(m[1]); out.push(m[1]); }
  }
  return out;
});

function save() {
  if (!form.name.trim() || !form.sql.trim()) return;
  emit('save', {
    id: form.id,
    name: form.name.trim(),
    description: form.description.trim(),
    sql: form.sql,
    tags: form.tags.split(',').map((t) => t.trim()).filter(Boolean),
    defaultServer: form.defaultServer || null,
    defaultDb: form.defaultDb || null,
  });
}

function del() {
  if (!form.id) return;
  emit('delete', form.id);
}

watch(() => form.defaultServer, () => { form.defaultDb = ''; });
</script>

<template>
  <div
    class="modal-overlay"
    @click.self="emit('cancel')"
  >
    <div class="modal">
      <h2>{{ form.id ? 'Edit saved query' : 'New saved query' }}</h2>
      <div class="row">
        <div>
          <label>Name</label>
          <input
            v-model="form.name"
            placeholder="student-by-id"
          >
        </div>
        <div>
          <label>Tags (comma-separated)</label>
          <input
            v-model="form.tags"
            placeholder="students, lookup"
          >
        </div>
      </div>
      <div class="row">
        <div>
          <label>Description</label>
          <input
            v-model="form.description"
            placeholder="What does this query do?"
          >
        </div>
      </div>
      <div class="row">
        <div>
          <label>SQL — use <code style="color:var(--accent)">:paramName</code> for params</label>
          <textarea
            v-model="form.sql"
            spellcheck="false"
          />
          <div
            v-if="params.length"
            style="font-size: 11px; color: var(--text-dim); font-family: var(--font-mono); margin-top: 4px;"
          >
            params: {{ params.map((p) => ':' + p).join(' ') }}
          </div>
        </div>
      </div>
      <div class="row">
        <div>
          <label>Default server (optional)</label>
          <select
            v-model="form.defaultServer"
            style="background: var(--bg-3); border: 1px solid var(--border); padding: 6px 10px; border-radius: 4px; font-family: var(--font-mono); font-size: 12px;"
          >
            <option value="">
              — none —
            </option>
            <option
              v-for="s in store.servers"
              :key="s.id"
              :value="s.id"
            >
              {{ s.label }}
            </option>
          </select>
        </div>
        <div>
          <label>Default db (optional)</label>
          <input
            v-model="form.defaultDb"
            placeholder="test_xxx_db"
          >
        </div>
      </div>
      <div class="footer">
        <button
          v-if="form.id"
          class="btn danger"
          @click="del"
        >
          Delete
        </button>
        <div
          class="spacer"
          style="flex:1"
        />
        <button
          class="btn ghost"
          @click="emit('cancel')"
        >
          Cancel
        </button>
        <button
          class="btn primary"
          :disabled="!form.name.trim() || !form.sql.trim()"
          @click="save"
        >
          Save
        </button>
      </div>
    </div>
  </div>
</template>
