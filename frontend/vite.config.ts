import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

export default defineConfig(({ command }) => ({
  plugins: [react()],
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
