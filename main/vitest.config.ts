import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  plugins: [{
    name: 'terminal-panel-manager-test-dependency',
    enforce: 'pre',
    resolveId(source, importer) {
      if (source === './panelManager' && importer?.endsWith('/src/services/terminalPanelManager.ts')) {
        return path.resolve(__dirname, './src/test/setup.ts');
      }
      return null;
    },
  }],
  test: {
    globals: true,
    environment: 'node',
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      exclude: [
        'node_modules/',
        'dist/',
        '**/*.d.ts',
        '**/*.config.*',
        '**/test/**',
        'src/index.ts',
        'src/preload.ts',
      ]
    },
    include: ['src/**/*.{test,spec}.{js,mjs,cjs,ts,mts,cts,jsx,tsx}'],
    setupFiles: ['./src/test/setup.ts'],
    // One worker runs many files in turn; src/test/setup.ts resets modules and
    // fails any file that leaves process state behind. File order is shuffled
    // so a file that depends on another's leftovers fails too; the run prints
    // its seed.
    isolate: false,
    sequence: { shuffle: { files: true, tests: false } },
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
      electron: path.resolve(__dirname, './src/test/setup.ts'),
    },
  },
});
