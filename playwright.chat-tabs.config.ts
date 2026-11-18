import { defineConfig } from '@playwright/test';
import { getPlaywrightBaseURL, getPlaywrightPort, getPlaywrightServerEnv } from './playwright.shared';

// Chat tab journeys launch Electron from a full `pnpm build:main` against the
// scripted ACP agent. The renderer comes from a plain Vite server: `electron-dev`
// (the minimal suite's server) runs `tsc -w`, which overwrites the bundled preload.
const port = getPlaywrightPort();

// CI runs each shard as its own job, side by side, split by measured duration:
// the Session activity journeys hold a fixed timeline of about four minutes, and
// the rest take under a minute together. Every spec belongs to exactly one
// shard; PANE_ELECTRON_SHARD picks one, and leaving it unset runs them all.
const ELECTRON_SHARDS = {
  'session-activity': ['session-activity.spec.ts', 'session-activity-real.spec.ts'],
  autopilot: ['autopilot.spec.ts'],
  journeys: ['chat-tabs.spec.ts', 'loop-sessions.spec.ts'],
} satisfies Record<string, string[]>;

const shard = process.env.PANE_ELECTRON_SHARD;
const specs = shard ? Object.entries(ELECTRON_SHARDS).find(([name]) => name === shard)?.[1] : Object.values(ELECTRON_SHARDS).flat();
if (!specs) {
  throw new Error(`PANE_ELECTRON_SHARD=${shard} names no shard. Use one of: ${Object.keys(ELECTRON_SHARDS).join(', ')}.`);
}

export default defineConfig({
  testDir: './tests',
  testMatch: specs,
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
