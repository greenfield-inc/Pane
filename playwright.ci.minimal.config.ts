import { defineConfig, devices } from '@playwright/test';
import { getPlaywrightBaseURL, getPlaywrightPort, getPlaywrightServerEnv } from './playwright.shared';

const devServerPort = getPlaywrightPort();

export default defineConfig({
  testDir: './tests',
  // Keep the fast startup checks and the maintained accessibility journeys in CI.
  testMatch: ['smoke.spec.ts', 'health-check.spec.ts', 'accessibility.spec.ts', 'appearance-bootstrap.spec.ts'],
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
  // Use more workers for parallel execution
  workers: 2,
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

  // Run your local dev server before starting the tests
  webServer: {
    command: 'pnpm electron-dev',
    port: devServerPort,
    reuseExistingServer: false,
    timeout: 45 * 1000,
    env: getPlaywrightServerEnv(devServerPort, {
      DISPLAY: ':99',
      ELECTRON_DISABLE_SANDBOX: '1',
    }),
  },
});
