import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// The browser Origin/Host are forwarded as-is (changeOrigin: false); the server allows
// http://127.0.0.1:4518 and Host 127.0.0.1:4518.
export default defineConfig({
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    port: 4518,
    strictPort: true,
    proxy: {
      '/api': { target: 'http://127.0.0.1:4517', changeOrigin: false },
      '/ws': { target: 'ws://127.0.0.1:4517', ws: true, changeOrigin: false },
    },
  },
});
