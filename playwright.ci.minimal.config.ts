import { defineConfig, devices } from '@playwright/test';
import { CHAT_PROJECTS } from './playwright.agent-chat.config';
import { getPlaywrightBaseURL, getPlaywrightPort, getPlaywrightServerEnv } from './playwright.shared';

const devServerPort = getPlaywrightPort();

// Every spec that runs against the renderer from Vite with a mocked Electron API.
// scripts/ci-test-inventory.mjs fails CI when a spec in tests/ runs in no lane, so a
// new spec must be added here, to another CI config, or to its NOT_IN_CI list.
// terminal-blur-recovery.spec.ts runs in its own lane (playwright.ci.webgl.config.ts).
const BROWSER_SPECS = [
  'accessibility.spec.ts',
  'adaptive-panel-layout.spec.ts',
  'agent-status.spec.ts',
  'agent-usage.spec.ts',
  'all-machines.spec.ts',
  'analytics-consent.spec.ts',
  'appearance-bootstrap.spec.ts',
  'approvals-system.spec.ts',
  'archive-cleanup.spec.ts',
  'autopilot-settings.spec.ts',
  'browser-ports.spec.ts',
  'changes-list-perf.spec.ts',
  'changes-list.spec.ts',
  'chat-enter-focus.spec.ts',
  'chrome-evidence.spec.ts',
  'codeless-remote.spec.ts',
  'commit-dialog.spec.ts',
  'desktop-notifications.spec.ts',
  'device-tab.spec.ts',
  'discord-presence.spec.ts',
  'dropdown-keyboard-nav.spec.ts',
  'feedback.spec.ts',
  'file-editor-lifecycle.spec.ts',
  'file-preview-lifecycle.spec.ts',
  'file-tree-selection.spec.ts',
  'file-tree-shortcuts.spec.ts',
  'find-in-tab.spec.ts',
  'home-usage-card.spec.ts',
  'html-editable-source.spec.ts',
  'html-explorer-open.spec.ts',
  'keyboard-navigation.spec.ts',
  'launch-outline.spec.ts',
  'launch-shortcuts.spec.ts',
  'leaderboard.spec.ts',
  'loops.spec.ts',
  'machine-health-cards.spec.ts',
  'machine-health-resources.spec.ts',
  'main-repo-push.spec.ts',
  'mission-control.spec.ts',
  'motion-remote.spec.ts',
  'motion.spec.ts',
  'native-mobile.spec.ts',
  'notify-cards.spec.ts',
  'notify.spec.ts',
  'onboarding-open-project.spec.ts',
  'pair-phone.spec.ts',
  'pane-order.spec.ts',
  'pause.spec.ts',
  'project-dashboard-refresh.spec.ts',
  'remote-host-switcher.spec.ts',
  'remote-network-rejection.spec.ts',
  'remote-pwa-explorer.spec.ts',
  'remote-pwa-sidebar.spec.ts',
  'remote-pwa-view-state.spec.ts',
  'remote-runtime-state.spec.ts',
  'resume-selection.spec.ts',
  'session-logs.spec.ts',
  'session-move-dialog.spec.ts',
  'settings.spec.ts',
  'shortcut-sheet.spec.ts',
  'shortcuts-settings.spec.ts',
  'sidebar-session-status.spec.ts',
  'smoke.spec.ts',
  'ssh-hosts.spec.ts',
  'startup-notice.spec.ts',
  'summary-policy.spec.ts',
  'tab-popover.spec.ts',
  'tailnet-https-banner.spec.ts',
  'terminal-dock.spec.ts',
  'terminal-file-links.spec.ts',
  'terminal-keyboard-input.spec.ts',
  'terminal-selection-popover.spec.ts',
  'terminal-upload-button.spec.ts',
  'theme-screenshots.spec.ts',
  'usage-and-limits.spec.ts',
  'window-title-bar.spec.ts',
];

export default defineConfig({
  testDir: './tests',
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

  // Configure projects for major browsers. The chat composer specs run at the
  // desktop and phone sizes playwright.agent-chat.config.ts gives them.
  projects: [
    {
      name: 'chromium',
      testMatch: BROWSER_SPECS,
      use: { 
        ...devices['Desktop Chrome'],
        // Disable GPU for CI
        launchOptions: {
          args: ['--disable-gpu', '--disable-dev-shm-usage', '--disable-setuid-sandbox', '--no-sandbox'],
        },
      },
    },
    ...CHAT_PROJECTS.map((project) => ({
      ...project,
      use: { ...devices['Desktop Chrome'], ...project.use, launchOptions: { args: ['--disable-gpu', '--disable-dev-shm-usage', '--disable-setuid-sandbox', '--no-sandbox'] } },
    })),
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
