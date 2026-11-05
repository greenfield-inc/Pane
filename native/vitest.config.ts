import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

// Unit tests run in Node: a test that reaches React Native or Expo mocks those modules.
export default defineConfig({
  resolve: {
    alias: {
      '@shared': fileURLToPath(new URL('../shared', import.meta.url)),
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  test: {
    include: ['src/**/*.test.ts', 'scripts/**/*.test.ts'],
  },
});
