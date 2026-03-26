/// <reference types="vitest" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const WEB_HOST = '0.0.0.0';
const WEB_PORT = 3500;
const API_PROXY_TARGET = 'http://localhost:3501';

export default defineConfig({
  plugins: [react()],
  build: {
    // Project detail pages lazy-load chunks that must stay parseable in older Safari/WebKit engines.
    target: 'es2019',
  },
  server: {
    host: WEB_HOST,
    port: WEB_PORT,
    // The dashboard is expected to be reachable by LAN/IP/hostname, not only localhost.
    allowedHosts: true,
    proxy: {
      '/api': {
        target: API_PROXY_TARGET,
        changeOrigin: true,
      },
    },
  },
  preview: {
    host: WEB_HOST,
    port: WEB_PORT,
    allowedHosts: true,
  },
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: './src/test/setup.ts',
  },
});
