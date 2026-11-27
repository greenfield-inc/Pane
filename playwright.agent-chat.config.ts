import { defineConfig, type Project } from '@playwright/test';

// The chat composer specs mount renderer-only host fixtures (chat-tab-composer.html);
// no Electron process, native agent or real data. Each runs at a desktop and a
// phone size. CI runs them in the browser smoke lane (playwright.ci.minimal.config.ts).
export const CHAT_SPECS = ['agent-chat-lifecycle.spec.ts', 'chat-composer-layout.spec.ts', 'chat-attachments.spec.ts', 'chat-copy.spec.ts', 'chat-queue.spec.ts', 'chat-questions.spec.ts', 'chat-status-bar.spec.ts', 'chat-agents-working.spec.ts', 'chat-bottom-spacing.spec.ts', 'chat-mentions.spec.ts'];

export const CHAT_PROJECTS: Project[] = [
  { name: 'desktop', testMatch: CHAT_SPECS, timeout: 45000, use: { viewport: { width: 1400, height: 950 } } },
  { name: 'phone', testMatch: CHAT_SPECS, timeout: 45000, use: { viewport: { width: 390, height: 844 }, hasTouch: true } },
];

const port = Number(process.env.PANE_CHAT_TEST_PORT ?? 54865);
export default defineConfig({
  testDir: './tests',
  testMatch: CHAT_SPECS,
  timeout: 45000,
  workers: 1,
  projects: CHAT_PROJECTS,
  use: { baseURL: `http://127.0.0.1:${port}`, headless: true, screenshot: 'only-on-failure' },
  webServer: {
    command: `pnpm --filter frontend dev --host 127.0.0.1 --port ${port}`,
    url: `http://127.0.0.1:${port}`,
    reuseExistingServer: false,
  },
});
