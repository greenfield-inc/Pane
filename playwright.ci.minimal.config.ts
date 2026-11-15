import { defineConfig, devices } from '@playwright/test';
import { getPlaywrightBaseURL, getPlaywrightPort, getPlaywrightServerEnv } from './playwright.shared';

const devServerPort = getPlaywrightPort();

export default defineConfig({
  testDir: './tests',
  // Keep the fast startup checks and the maintained accessibility journeys in CI.
  testMatch: ['smoke.spec.ts', 'health-check.spec.ts', 'accessibility.spec.ts', 'settings.spec.ts', 'remote-pwa-sidebar.spec.ts', 'remote-pwa-view-state.spec.ts', 'remote-agent-status.spec.ts', 'remote-pwa-explorer.spec.ts', 'file-editor-lifecycle.spec.ts', 'file-preview-lifecycle.spec.ts', 'find-in-tab.spec.ts', 'html-editable-source.spec.ts', 'html-explorer-open.spec.ts', 'file-tree-selection.spec.ts', 'browser-ports.spec.ts', 'analytics-consent.spec.ts', 'ssh-hosts.spec.ts', 'onboarding-open-project.spec.ts', 'onboarding-first-steps.spec.ts', 'terminal-selection-popover.spec.ts', 'home-usage-card.spec.ts'],
  // Allow enough time for cold CI startup while keeping failures bounded.
  timeout: 30 * 1000,
  expect: {
    // Reduce expect timeout for faster failures
    timeout: 5000
  },
  // Run tests in files in parallel
  fullyParallel: true,
  // Fail the build on CI if you accidentally left test.only in the source code
  forbidOnly: true,
  // No retries for minimal tests
  retries: 0,
  // Over 3 Code Quality dispatch runs each (Oct 31), this suite took 206-209 s
  // on 2 workers (runs 41161695357, 41162991850, 41164372909), 180-202 s on 3
  // (41161697239, 41162994039, 41164374400) and 195-199 s on 4 (41161699481,
  // 41162996098, 41164376197). 3 and 4 tie; 2 is slower.
  workers: 3,
  // Reporter optimized for CI
  reporter: [
    ['list'],
    ['github'],
  ],
  
  use: {
    // Base URL to use in actions like await page.goto('/')
    baseURL: getPlaywrightBaseURL(devServerPort),
    // Collect trace only on failure to save time
    trace: 'retain-on-failure',
    // Take screenshot on failure
    screenshot: 'only-on-failure',
    // Reduce viewport for faster rendering
    viewport: { width: 1280, height: 720 },
    // Disable animations for faster tests
    launchOptions: {
      args: ['--disable-gpu', '--disable-dev-shm-usage', '--disable-setuid-sandbox', '--no-sandbox'],
    },
  },

  // Configure projects for major browsers
  projects: [
    {
      name: 'chromium',
      use: { 
        ...devices['Desktop Chrome'],
        // Disable GPU for CI
        launchOptions: {
          args: ['--disable-gpu', '--disable-dev-shm-usage', '--disable-setuid-sandbox', '--no-sandbox'],
        },
      },
    },
  ],

  // The tests mock the Electron API (tests/electronApiMock.ts), so they need
  // only the renderer from Vite, not the Electron app.
  webServer: {
    command: 'pnpm --filter frontend exec vite',
    port: devServerPort,
    reuseExistingServer: false,
    timeout: 45 * 1000,
    env: getPlaywrightServerEnv(devServerPort),
  },
});
