import { defineConfig } from '@playwright/test';
import electronConfig from './playwright.chat-tabs.config';
import { getPlaywrightPort, getPlaywrightServerEnv } from './playwright.shared';

// Another machine's Sessions over a slow link (tests/remote-session-switch.spec.ts, T-116):
// two isolated Panes from `pnpm build:main`, linked through scripts/flapping-link-proxy.mjs
// with REMOTE_SWITCH_RTT_MS of latency (default 50), against the production renderer, so run
// `pnpm build:frontend` first. Timing is reported only. The spec refuses to start without
// frontend/dist; this file must still load without it, since scripts/ci-test-inventory.mjs
// lists its tests in a job that builds nothing.
process.env.PANE_REMOTE_SWITCH_BENCH = '1';
const port = getPlaywrightPort();

export default defineConfig({
  ...electronConfig,
  testMatch: ['remote-session-switch.spec.ts'],
  timeout: 20 * 60 * 1000,
  webServer: {
    command: `pnpm --filter frontend exec vite preview --port ${port} --strictPort`,
    port,
    reuseExistingServer: false,
    timeout: 45 * 1000,
    env: getPlaywrightServerEnv(port),
  },
});
