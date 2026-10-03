import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';
import { DEFAULT_APPEARANCE, THEME_CLASSES } from '../shared/types/appearance';

export default defineConfig(({ command }) => ({
  plugins: [
    react(),
    {
      name: 'pane-appearance-bootstrap',
      // Inline before the browser parses the head in both dev and packaged builds.
      // The preload snapshot stays authoritative; this only generates its theme map.
      transformIndexHtml: {
        order: 'pre',
        handler: (html) => html
          .replace('__PANE_THEME_CLASSES__', JSON.stringify(THEME_CLASSES))
          .replace('__PANE_DEFAULT_APPEARANCE__', JSON.stringify(DEFAULT_APPEARANCE)),
      },
    },
  ],
  define: {
    __PANE_REACT_SCAN_ENABLED__: JSON.stringify(
      command === 'serve' && process.env.PANE_REACT_SCAN === '1'
    )
  },
  server: {
    port: parseInt(process.env.VITE_PORT || process.env.PORT || '4521', 10),
    strictPort: true
  },
  base: './',
  build: {
    target: 'es2021',
    // Ensure assets are copied and paths are relative
    assetsDir: 'assets',
    // Copy public files to dist
    copyPublicDir: true,
    rolldownOptions: {
      input: {
        main: resolve(import.meta.dirname, 'index.html'),
        remote: resolve(import.meta.dirname, 'remote.html'),
      },
    },
  }
}));
