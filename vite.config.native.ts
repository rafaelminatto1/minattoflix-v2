import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

const apiOrigin = process.env.NATIVE_API_ORIGIN || 'https://minattoflix-v2.rafalegollas.workers.dev';
const parsedOrigin = new URL(apiOrigin);
if (parsedOrigin.protocol !== 'https:' || parsedOrigin.pathname !== '/' || parsedOrigin.search || parsedOrigin.hash || parsedOrigin.username || parsedOrigin.password) {
  throw new Error('NATIVE_API_ORIGIN must be an HTTPS origin without paths or credentials.');
}

export default defineConfig({
  plugins: [react(), tailwindcss()],
  define: { __API_ORIGIN__: JSON.stringify(parsedOrigin.origin) },
  build: {
    outDir: 'dist/native',
    chunkSizeWarningLimit: 800,
    rollupOptions: {
      output: {
        manualChunks: (id) => {
          // Vendor chunks
          if (id.includes('node_modules')) {
            if (id.includes('hls.js')) {
              return 'vendor-hls';
            }
            if (id.includes('lucide-react')) {
              return 'vendor-lucide';
            }
            if (id.includes('react') || id.includes('scheduler') || id.includes('use-sync-external-store')) {
              return 'vendor-react';
            }
            // mediabunny is only used by player, keep it together
            if (id.includes('mediabunny') || id.includes('@mediabunny')) {
              return 'player';
            }
            return 'vendor';
          }
          // Feature chunks
          if (id.includes('/components/NetflixPlayer') || id.includes('/services/mkvAudioController') || id.includes('/services/fullscreen')) {
            return 'player';
          }
          if (id.includes('/components/') || id.includes('/hooks/')) {
            return 'ui';
          }
          if (id.includes('/services/')) {
            return 'services';
          }
        },
      },
    },
  },
});