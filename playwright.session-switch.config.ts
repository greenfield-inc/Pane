import { defineConfig } from '@playwright/test';
import electronConfig from './playwright.chat-tabs.config';
import { getPlaywrightPort, getPlaywrightServerEnv } from './playwright.shared';

// Session switch latency (tests/session-switch-latency.spec.ts): real Electron from
// `pnpm build:main` against the production renderer, so run `pnpm build:frontend` first.
// The dev server's StrictMode mounts every chat twice and its unminified React is 2-5x
// slower, so its numbers say nothing about the app people use. Timing is reported only;
// the spec's hard checks (retained DOM, one chat mount, Enter focus) fail the run. The spec
// refuses to start without frontend/dist; this file must still load without it, since
// scripts/ci-test-inventory.mjs lists its tests in a job that builds nothing.
process.env.PANE_SWITCH_BENCH = '1';
const port = getPlaywrightPort();

export default defineConfig({
  ...electronConfig,
  testMatch: ['session-switch-latency.spec.ts'],
  timeout: 15 * 60 * 1000,
  webServer: {
    command: `pnpm --filter frontend exec vite preview --port ${port} --strictPort`,
    port,
    reuseExistingServer: false,
    timeout: 45 * 1000,
    env: getPlaywrightServerEnv(port),
  },
});
