import { defineConfig } from '@playwright/test';
import { existsSync } from 'node:fs';
import path from 'node:path';
import electronConfig from './playwright.chat-tabs.config';
import { getPlaywrightPort, getPlaywrightServerEnv } from './playwright.shared';

// Session switch latency (tests/session-switch-latency.spec.ts): real Electron from
// `pnpm build:main` against the production renderer, so run `pnpm build:frontend` first.
// The dev server's StrictMode mounts every chat twice and its unminified React is 2-5x
// slower, so its numbers say nothing about the app people use. Timing is reported only;
// the spec's hard checks (retained DOM, one chat mount, Enter focus) fail the run.
if (!existsSync(path.join(__dirname, 'frontend', 'dist', 'index.html'))) {
  throw new Error('playwright.session-switch.config.ts serves the production renderer, and frontend/dist has none. Run `pnpm build:frontend` first, then run this config again.');
}
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
