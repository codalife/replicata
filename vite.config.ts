import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';

export default defineConfig({
  plugins: [svelte()],
  root: 'ui',
  base: '/ui/',
  build: {
    outDir: '../dist/ui',
    emptyOutDir: true,
  },
});
