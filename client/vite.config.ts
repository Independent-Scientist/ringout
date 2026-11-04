import { defineConfig } from 'vite';

export default defineConfig({
  // Relative base so the same build works on GitHub Pages and on localhost.
  base: './',
  resolve: {
    alias: {
      // The client imports the module's simulation directly: one integrator, two runners.
      '@sim': new URL('../module/src', import.meta.url).pathname,
    },
  },
  server: {
    port: 5173,
    strictPort: true,
  },
});
