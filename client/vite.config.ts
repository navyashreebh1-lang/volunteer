import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// The API is proxied so the browser sees one origin and the session cookie
// stays first-party. No secrets or service keys are ever bundled here.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: { '/api': { target: process.env.VITE_API_TARGET ?? 'http://localhost:4000', changeOrigin: false } },
  },
});
