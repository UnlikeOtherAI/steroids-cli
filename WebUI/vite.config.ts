/// <reference types="vitest" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  build: {
    // Project detail pages lazy-load chunks that must stay parseable in older Safari/WebKit engines.
    target: 'es2019',
  },
  server: {
    host: '0.0.0.0', // Listen on all interfaces (localhost + IP)
    port: 3500,
    proxy: {
      '/api': {
        target: 'http://localhost:3501',
        changeOrigin: true,
      },
    },
  },
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: './src/test/setup.ts',
  },
});
