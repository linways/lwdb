<script setup>
defineProps({ toast: { type: Object, required: true } });
</script>

<template>
  <div
    class="toast"
    :class="toast.kind"
  >
    {{ toast.msg }}
  </div>
</template>
