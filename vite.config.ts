import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { cloudflare } from '@cloudflare/vite-plugin';

export default defineConfig(({ mode }) => ({
  plugins: [
    react(),
    tailwindcss(),
    cloudflare({ remoteBindings: mode !== 'offline', config: mode === 'offline' ? (config) => { config.hyperdrive = []; } : undefined }),
  ],
  build: {
    outDir: 'dist',
    chunkSizeWarningLimit: 600,
    rollupOptions: {
      output: {
        manualChunks: (id) => {
          // Vendor chunks - separate heavy libs
          if (id.includes('node_modules')) {
            if (id.includes('hls.js')) {
              return 'vendor-hls';
            }
            if (id.includes('lucide-react')) {
              return 'vendor-lucide';
            }
            if (id.includes('mediabunny') || id.includes('@mediabunny')) {
              return 'feature-player-services'; // Bundle with player services to avoid circular
            }
            if (id.includes('react') || id.includes('scheduler') || id.includes('use-sync-external-store')) {
              return 'vendor-react';
            }
            return 'vendor';
          }
          // Feature chunks - player services (includes mediabunny)
          if (id.includes('/services/mkvAudioController') || id.includes('/services/fullscreen')) {
            return 'feature-player-services';
          }
          if (id.includes('/components/NetflixPlayer')) {
            return 'feature-player';
          }
          if (id.includes('/components/')) {
            return 'feature-ui';
          }
          if (id.includes('/hooks/')) {
            return 'feature-hooks';
          }
          if (id.includes('/services/')) {
            return 'feature-services';
          }
        },
      },
    },
  },
}));