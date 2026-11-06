import { defineConfig } from '@playwright/test';
import { getPlaywrightBaseURL, getPlaywrightPort, getPlaywrightServerEnv } from './playwright.shared';

// Chat tab journeys launch Electron from a full `pnpm build:main` against the
// scripted ACP agent. The renderer comes from a plain Vite server: `electron-dev`
// (the minimal suite's server) runs `tsc -w`, which overwrites the bundled preload.
const port = getPlaywrightPort();

export default defineConfig({
  testDir: './tests',
  testMatch: ['chat-tabs.spec.ts', 'autopilot.spec.ts'],
  timeout: 120 * 1000,
  forbidOnly: true,
  retries: 0,
  workers: 1,
  reporter: [['list'], ['github']],
  use: { baseURL: getPlaywrightBaseURL(port), trace: 'retain-on-failure', screenshot: 'only-on-failure' },
  webServer: {
    command: `pnpm --filter frontend exec vite --port ${port} --strictPort`,
    port,
    reuseExistingServer: false,
    timeout: 45 * 1000,
    env: getPlaywrightServerEnv(port),
  },
});
