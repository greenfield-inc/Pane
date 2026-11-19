import { defineConfig, devices } from '@playwright/test';
import { CHAT_PROJECTS } from './playwright.agent-chat.config';
import browserConfig from './playwright.ci.minimal.config';

// Stabilizing: wired in by #1554 on 2026-11-18, flaky under CI load; returns to the
// required lanes as each is proven stable. Functional Smoke (stabilizing) runs these
// on every pull request and on main and reports, but CI result does not wait for it.
// Same server, browser and settings as the browser lane; the chat composer specs run
// at the desktop and phone sizes playwright.agent-chat.config.ts gives them.
const STABILIZING_SPECS = [
  'adaptive-panel-layout.spec.ts',
  'agent-status.spec.ts',
  'agent-usage.spec.ts',
  'all-machines.spec.ts',
  'appearance-bootstrap.spec.ts',
  'archive-cleanup.spec.ts',
  'autopilot-settings.spec.ts',
  'changes-list-perf.spec.ts',
  'changes-list.spec.ts',
  'chat-enter-focus.spec.ts',
  'chrome-evidence.spec.ts',
  'codeless-remote.spec.ts',
  'command-palette.spec.ts',
  'commit-dialog.spec.ts',
  'desktop-notifications.spec.ts',
  'discord-presence.spec.ts',
  'dropdown-keyboard-nav.spec.ts',
  'feedback.spec.ts',
  'file-tree-shortcuts.spec.ts',
  'keyboard-navigation.spec.ts',
  'launch-shortcuts.spec.ts',
  'leaderboard.spec.ts',
  'main-repo-push.spec.ts',
  'mermaid-preview.spec.ts',
  'mission-control.spec.ts',
  'motion-remote.spec.ts',
  'motion.spec.ts',
  'native-mobile.spec.ts',
  'notify.spec.ts',
  'orchestration-sessions.spec.ts',
  'pair-phone.spec.ts',
  'pane-order.spec.ts',
  'pause.spec.ts',
  'project-dashboard-refresh.spec.ts',
  'remote-host-switcher.spec.ts',
  'remote-network-rejection.spec.ts',
  'remote-pwa-browser.spec.ts',
  'remote-runtime-state.spec.ts',
  'resume-selection.spec.ts',
  'review-availability.spec.ts',
  'session-logs.spec.ts',
  'shortcuts-settings.spec.ts',
  'sidebar-compact.spec.ts',
  'sidebar-session-status.spec.ts',
  'split-groups.spec.ts',
  'startup-notice.spec.ts',
  'tab-popover.spec.ts',
  'tailnet-https-banner.spec.ts',
  'terminal-dock.spec.ts',
  'terminal-file-links.spec.ts',
  'terminal-keyboard-input.spec.ts',
  'terminal-upload-button.spec.ts',
  'theme-screenshots.spec.ts',
  'usage-and-limits.spec.ts',
];

const launchOptions = { args: ['--disable-gpu', '--disable-dev-shm-usage', '--disable-setuid-sandbox', '--no-sandbox'] };

export default defineConfig({
  ...browserConfig,
  projects: [
    { ...browserConfig.projects![0], testMatch: STABILIZING_SPECS },
    ...CHAT_PROJECTS.map((project) => ({ ...project, use: { ...devices['Desktop Chrome'], ...project.use, launchOptions } })),
  ],
});
