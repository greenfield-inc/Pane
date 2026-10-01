import { defineConfig, devices } from '@playwright/test';

// Session ports chip row (desktop renderer with the electronAPI mock, and the
// Remote PWA with a mocked host). Needs only the Vite frontend, not Electron;
// screenshots land in test-results/session-ports for review.
const PORT = Number.parseInt(process.env.PANE_PORTS_PORT ?? '4533', 10);

export default defineConfig({
  testDir: './tests',
  testMatch: ['**/session-ports.spec.ts'],
  timeout: 60 * 1000,
  expect: { timeout: 10000 },
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: 'list',
  outputDir: 'test-results/session-ports',
  use: {
    ...devices['Desktop Chrome'],
    baseURL: `http://localhost:${PORT}`,
    viewport: { width: 1280, height: 800 },
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium' }],
  webServer: {
    command: 'pnpm run --filter frontend dev',
    port: PORT,
    reuseExistingServer: !process.env.CI,
    timeout: 120 * 1000,
    env: { PORT: String(PORT), VITE_PORT: String(PORT) },
  },
});
