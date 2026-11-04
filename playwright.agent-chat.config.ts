import { defineConfig } from '@playwright/test';

// Renderer-only host fixtures; no Electron process, native agent or real data.
const port = Number(process.env.PANE_CHAT_TEST_PORT ?? 54865);
export default defineConfig({
  testDir: './tests',
  testMatch: ['agent-chat-remote.spec.ts', 'agent-chat-lifecycle.spec.ts'],
  timeout: 45000,
  workers: 1,
  projects: [
    { name: 'desktop', use: { viewport: { width: 1400, height: 950 } } },
    { name: 'phone', use: { viewport: { width: 390, height: 844 }, hasTouch: true } },
  ],
  use: { baseURL: `http://127.0.0.1:${port}`, headless: true, screenshot: 'only-on-failure' },
  webServer: {
    command: `pnpm --filter frontend dev --host 127.0.0.1 --port ${port}`,
    url: `http://127.0.0.1:${port}`,
    reuseExistingServer: false,
  },
});
