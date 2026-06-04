<script setup>
defineProps({
  params: { type: Array, default: () => [] },
  values: { type: Object, default: () => ({}) },
  ops:    { type: Object, default: () => ({}) },
});
const emit = defineEmits(['run']);

// Operator toggle cycle. Most uses only need eq <-> like_contains, so we cycle
// through those two by default; right-click could expose more later.
const CYCLE = ['eq', 'like_contains'];
const SYMBOLS = {
  eq: '=', neq: '≠', like: '~', like_contains: '~', like_starts: 'x~', like_ends: '~x', not_like: '!~',
};
const TITLES = {
  eq: 'exact match  (=)',
  like_contains: 'contains  (LIKE %value%)',
  like_starts: 'starts with  (LIKE value%)',
  like_ends: 'ends with  (LIKE %value)',
  like: 'LIKE (your own wildcards)',
  neq: 'not equal  (<>)',
  not_like: "doesn't contain  (NOT LIKE %value%)",
};

function cycle(ops, p) {
  const current = ops[p] || 'eq';
  const idx = CYCLE.indexOf(current);
  const next = CYCLE[(idx + 1) % CYCLE.length];
  ops[p] = next;
}
</script>

<template>
  <div
    v-if="params.length"
    class="param-strip"
  >
    <span class="label">params</span>
    <template
      v-for="p in params"
      :key="p"
    >
      <div class="param-cell">
        <button
          class="op-toggle"
          :class="{ active: (ops[p] || 'eq') !== 'eq' }"
          :title="TITLES[ops[p] || 'eq']"
          @click="cycle(ops, p)"
        >
          {{ SYMBOLS[ops[p] || 'eq'] }}
        </button>
        <input
          :placeholder="`:${p}`"
          :value="values[p] ?? ''"
          @input="(e) => (values[p] = e.target.value)"
          @keydown.enter.prevent="emit('run')"
        >
      </div>
    </template>
  </div>
</template>

<style scoped>
.param-cell {
  display: inline-flex;
  align-items: stretch;
  gap: 0;
}
.op-toggle {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 24px;
  height: 26px;
  padding: 0 6px;
  background: var(--bg-2);
  border: 1px solid var(--border);
  border-right: none;
  border-radius: 4px 0 0 4px;
  color: var(--text-dim);
  font-family: var(--font-mono);
  font-size: 12px;
  cursor: pointer;
}
.op-toggle:hover { background: var(--bg-hover); color: var(--text); }
.op-toggle.active { color: var(--accent); border-color: var(--accent-dim); background: rgba(90, 209, 255, 0.08); }
.param-cell input {
  border-radius: 0 4px 4px 0 !important;
}
</style>
