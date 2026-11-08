<script setup lang="ts">
withDefaults(defineProps<{ name: string; size?: number }>(), { size: 20 });
const paths: Record<string, string[]> = {
  arrow: ['M4 12h16', 'm14 6 6 6-6 6'],
  'chevron-down': ['m6 9 6 6 6-6'],
  external: ['M14 3h7v7', 'm10 14 11-11', 'M10 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-5'],
  telegram: ['m3 11 18-7-4 17-6-6-4 3v-6l10-6-10 8Z'],
  users: ['M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2', 'M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8Z', 'M22 21v-2a4 4 0 0 0-3-3.87', 'M16 3.13a4 4 0 0 1 0 7.75'],
  server: ['M3 3h18v7H3z', 'M3 14h18v7H3z', 'M7 6.5h.01', 'M7 17.5h.01', 'M12 6.5h5', 'M12 17.5h5'],
  cloud: ['M7 18a5 5 0 0 1-1-9.9 6 6 0 0 1 11.5-1.6A5.8 5.8 0 0 1 18 18H7Z'],
  'cloud-upload': ['M7 18a5 5 0 0 1-1-9.9 6 6 0 0 1 11.5-1.6A5.8 5.8 0 0 1 18 18', 'M12 21V11', 'm8 15 4-4 4 4'],
  disk: ['M4 3h16v18H4z', 'M4 15h16', 'M8 18h.01', 'M12 18h4'],
  folder: ['M3 6a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v10H3V6Z'],
  queue: ['M4 3h16v18H4z', 'M8 8h8', 'M8 12h8', 'M8 16h5'],
  sync: ['M20 7v5h-5', 'M4 17v-5h5', 'M6.1 6a8 8 0 0 1 12.5-.9L20 7', 'm4 17 1.4 1.9A8 8 0 0 0 17.9 18'],
  shield: ['m12 3 8 3v6c0 4-5 8-8 9-3-1-8-5-8-9V6l8-3Z', 'm8 12 3 3 5-6'],
  terminal: ['M2 3h20v14H2z', 'M8 21h8', 'M12 17v4', 'm7 8 3 3-3 3', 'M12 14h5'],
  book: ['M12 5v16', 'M12 5C9 2 4 3 2 4v15c3-1 7-1 10 2 3-3 7-3 10-2V4c-2-1-7-2-10 1Z'],
  file: ['M14 2H5v20h14V7l-5-5Z', 'M14 2v5h5', 'M8 12h8', 'M8 16h6'],
  code: ['m8 6-6 6 6 6', 'm16 6 6 6-6 6', 'm14 3-4 18'],
  bolt: ['m13 2-9 12h7l-1 8 10-12h-7l1-8Z'],
  check: ['m5 12 4 4L19 6'],
  info: ['M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Z', 'M12 11v6', 'M12 7h.01'],
  copy: ['M9 9h10v10H9z', 'M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1'],
  cpu: ['M7 7h10v10H7z', 'M9 3v4', 'M15 3v4', 'M9 17v4', 'M15 17v4', 'M3 9h4', 'M3 15h4', 'M17 9h4', 'M17 15h4'],
  magnet: ['M6 3v7a6 6 0 0 0 12 0V3', 'M4 3h4', 'M16 3h4', 'M6 7h2', 'M16 7h2'],
  layers: ['m12 3 9 4.5-9 4.5-9-4.5L12 3Z', 'm3 12 9 4.5 9-4.5', 'm3 16.5 9 4.5 9-4.5'],
};
</script>

<template>
  <svg class="doc-icon" :width="size" :height="size" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">
    <path v-for="(path, index) in paths[name] || paths.file" :key="index" :d="path" />
  </svg>
</template>
