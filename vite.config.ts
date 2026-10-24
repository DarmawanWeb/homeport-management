import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  root: 'web',
  plugins: [react()],
  build: { outDir: '../dist/web', emptyOutDir: true, chunkSizeWarningLimit: 800 },
  server: { port: 5173, proxy: { '/api': 'http://127.0.0.1:7070' } },
});
