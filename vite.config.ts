import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

/** `@/foo` → `<root>/src/foo`. Kept in sync with tsconfig `paths`. */
const alias = { '@': fileURLToPath(new URL('./src', import.meta.url)) };

export default defineConfig({
  resolve: { alias },
  build: {
    rollupOptions: {
      output: {
        /**
         * Stable name for the lazily-imported Supabase chunk, so the service
         * worker can exclude it from the precache by pattern.
         */
        manualChunks: (id) =>
          id.includes('@supabase/supabase-js') ? 'supabase' : undefined,
      },
    },
  },
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      strategies: 'injectManifest',
      srcDir: 'src',
      filename: 'sw.ts',
      includeAssets: ['icons/icon.svg', 'icons/apple-touch-icon.png'],
      manifest: {
        name: 'مهامي — مهام الطلاب',
        short_name: 'مهامي',
        description: 'تطبيق مهام للطلاب: offline-first، عربي RTL، بلا حساب ولا سيرفر.',
        lang: 'ar',
        dir: 'rtl',
        start_url: '/',
        scope: '/',
        display: 'standalone',
        orientation: 'portrait',
        background_color: '#0C0315',
        theme_color: '#0C0315',
        categories: ['productivity', 'education'],
        icons: [
          { src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
          { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
          { src: 'icons/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      injectManifest: {
        globPatterns: ['**/*.{js,css,html,svg,png,woff2}'],
        /**
         * The Supabase chunk is ~230 kB of auth client. It is only ever
         * `await import()`ed when a signed-in user syncs — which requires
         * network anyway — so precaching it would make every visitor, including
         * the ones who never sign in, download it at install time. Excluded on
         * purpose; the dynamic import fetches it on demand.
         */
        globIgnores: ['**/supabase-*.js'],
      },
      devOptions: { enabled: false },
    }),
  ],
  test: {
    environment: 'node',
    setupFiles: ['tests/setup.ts'],
    include: ['tests/**/*.test.ts'],
  },
});
