import { defineConfig } from '@playwright/test';
import { getPlaywrightBaseURL, getPlaywrightPort, getPlaywrightServerEnv } from './playwright.shared';

// Chat tab journeys launch Electron from a full `pnpm build:main` against the
// scripted ACP agent. The renderer comes from a plain Vite server: `electron-dev`
// (the minimal suite's server) runs `tsc -w`, which overwrites the bundled preload.
const port = getPlaywrightPort();

// session-activity-real.spec.ts skips itself unless SESSION_ACTIVITY_REAL=1, which CI never sets.
// browser-auth-persistence and remote-browser-files run only with PANE_ELECTRON_E2E=1, which CI sets.
export default defineConfig({
  testDir: './tests',
  testMatch: ['chat-tabs.spec.ts', 'loop-sessions.spec.ts', 'session-activity-real.spec.ts', 'browser-auth-persistence.spec.ts', 'remote-browser-files.spec.ts', 'todos.spec.ts', 'todos-page.spec.ts', 'todos-real.spec.ts', 'todos-snooze.spec.ts', 'browser-agents.spec.ts'],
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
