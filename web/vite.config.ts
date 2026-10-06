import react from '@vitejs/plugin-react';
import type { Plugin, UserConfig } from 'vite';
import type { InlineConfig } from 'vitest/node';

/**
 * Preload the two Latin font files so text renders in its final face on first paint.
 * Other subsets stay lazy behind their unicode-range.
 */
function preloadLatinFonts(): Plugin {
  return {
    name: 'agentfund:preload-latin-fonts',
    apply: 'build',
    transformIndexHtml: {
      order: 'post',
      handler(_html, ctx) {
        const files = Object.keys(ctx.bundle ?? {}).filter((file) =>
          /(inter|jetbrains-mono)-latin-wght-normal-[\w-]+\.woff2$/.test(file),
        );
        return files.map((file) => ({
          tag: 'link',
          attrs: { rel: 'preload', as: 'font', type: 'font/woff2', href: `/${file}`, crossorigin: '' },
          injectTo: 'head' as const,
        }));
      },
    },
  };
}

// Typed explicitly rather than through defineConfig, so the `test` block type-checks no
// matter how the workspace hoists vite and vitest.
const config: UserConfig & { test: InlineConfig } = {
  plugins: [react(), preloadLatinFonts()],
  server: { port: 5173, strictPort: true },
  preview: { port: 4173, strictPort: true },
  build: { target: 'es2022', sourcemap: false, cssCodeSplit: false },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['src/test/setup.ts'],
    css: false,
    restoreMocks: true,
    unstubGlobals: true,
    env: { VITE_API_BASE_URL: 'http://api.test' },
  },
};

export default config;
