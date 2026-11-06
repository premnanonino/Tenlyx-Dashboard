import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:8787',
        // Keep the browser's Host header so the backend's same-origin
        // (CSRF) check sees localhost:5173 on both Host and Origin.
        changeOrigin: false,
        configure(proxy) {
          // Backend down or restarting: answer 502 JSON instead of a bare 500.
          proxy.on('error', (err, req, res) => {
            if (res.headersSent || typeof res.writeHead !== 'function') return;
            res.writeHead(502, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: 'backend_unavailable', detail: `API server on :8787 is not reachable (${err.code || err.message})` }));
          });
        },
      },
    },
  },
  build: {
    chunkSizeWarningLimit: 900,
  },
});
