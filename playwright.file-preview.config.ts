import { defineConfig } from '@playwright/test';

// Mount real preview/editor components with controlled IPC and a small Monaco UI
// adapter. No dev app, daemon, profile, or network dependency is needed.
export default defineConfig({
  testDir: './tests',
  testMatch: ['file-editor-lifecycle.spec.ts', 'file-preview-lifecycle.spec.ts', 'html-preview-source.spec.ts'],
  timeout: 30000,
  expect: { timeout: 5000 },
  workers: 1,
  use: { browserName: 'chromium', headless: true, trace: 'retain-on-failure' },
});
