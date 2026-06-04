<script setup>
import { onMounted, onBeforeUnmount, ref } from 'vue';

const props = defineProps({
  x: { type: Number, required: true },
  y: { type: Number, required: true },
  items: { type: Array, required: true }, // [{ label, hint?, run, danger?, separator? }]
});
const emit = defineEmits(['close']);

const root = ref(null);
const focusIdx = ref(0);
const visibleItems = () => props.items.filter((i) => !i.separator);

function onDocMouseDown(e) {
  if (root.value && !root.value.contains(e.target)) emit('close');
}
function onKey(e) {
  if (e.key === 'Escape') { emit('close'); return; }
  const items = visibleItems();
  if (e.key === 'ArrowDown') { focusIdx.value = (focusIdx.value + 1) % items.length; e.preventDefault(); }
  if (e.key === 'ArrowUp')   { focusIdx.value = (focusIdx.value - 1 + items.length) % items.length; e.preventDefault(); }
  if (e.key === 'Enter') { items[focusIdx.value]?.run?.(); emit('close'); e.preventDefault(); }
}

onMounted(() => {
  document.addEventListener('mousedown', onDocMouseDown, true);
  document.addEventListener('keydown', onKey, true);
});
onBeforeUnmount(() => {
  document.removeEventListener('mousedown', onDocMouseDown, true);
  document.removeEventListener('keydown', onKey, true);
});

function activate(item) {
  if (item.run) item.run();
  emit('close');
}
</script>

<template>
  <div
    ref="root"
    class="context-menu"
    :style="{ left: x + 'px', top: y + 'px' }"
  >
    <template
      v-for="(item, idx) in items"
      :key="idx"
    >
      <div
        v-if="item.separator"
        class="ctx-sep"
      />
      <button
        v-else
        class="ctx-item"
        :class="{ danger: item.danger, focused: visibleItems().indexOf(item) === focusIdx }"
        @mouseenter="focusIdx = visibleItems().indexOf(item)"
        @click="activate(item)"
      >
        <span class="ctx-label">{{ item.label }}</span>
        <span
          v-if="item.hint"
          class="ctx-hint"
        >{{ item.hint }}</span>
      </button>
    </template>
  </div>
</template>

<style scoped>
.context-menu {
  position: fixed;
  z-index: 250;
  min-width: 220px;
  background: var(--bg-2);
  border: 1px solid var(--border-strong);
  border-radius: 6px;
  padding: 4px;
  font-size: 12.5px;
  box-shadow: 0 8px 24px rgba(0,0,0,0.5);
}
.ctx-item {
  display: flex;
  align-items: center;
  width: 100%;
  padding: 6px 10px;
  border-radius: 4px;
  background: transparent;
  border: none;
  color: var(--text);
  text-align: left;
  cursor: pointer;
  gap: 12px;
}
.ctx-item.focused, .ctx-item:hover {
  background: var(--bg-hover);
}
.ctx-item.danger { color: var(--danger); }
.ctx-label { flex: 1; }
.ctx-hint {
  color: var(--text-faint);
  font-family: var(--font-mono);
  font-size: 10.5px;
}
.ctx-sep {
  height: 1px;
  background: var(--border);
  margin: 4px 2px;
}
</style>
