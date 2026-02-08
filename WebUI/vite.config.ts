import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 3500,
    proxy: {
      '/api': {
        target: 'http://localhost:3501',
        changeOrigin: true,
      },
    },
  },
});
