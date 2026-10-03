import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  testMatch: ['monaco-packaged.spec.ts'],
  timeout: 90000,
  expect: { timeout: 30000 },
  workers: 1,
  forbidOnly: !!process.env.CI,
  reporter: 'list',
});
