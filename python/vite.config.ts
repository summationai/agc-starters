import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// The UI lives in web/ and builds to web/dist, which the API serves in production. In development (dev.sh), Vite
// serves the UI on $PORT and passes the API's paths through to uvicorn on $API_PORT.
const api = `http://127.0.0.1:${process.env.API_PORT ?? '8001'}`;

export default defineConfig({
  root: 'web',
  plugins: [react()],
  build: { outDir: 'dist', emptyOutDir: true },
  // Keep the browser's Host: the API compares it with Origin before accepting a write (SEC-6).
  server: { proxy: { '/api': { target: api, changeOrigin: false }, '/auth': { target: api, changeOrigin: false } } },
});
