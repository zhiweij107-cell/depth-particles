import { defineConfig } from 'vite'

export default defineConfig({
  // Relative paths so Electron / static hosts resolve assets correctly
  base: './',
  server: {
    host: true,
    port: 5173,
  },
  optimizeDeps: {
    exclude: ['@huggingface/transformers'],
  },
  worker: {
    format: 'es',
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'esnext',
  },
})
