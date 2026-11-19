import { defineConfig } from '@playwright/test';
import browserConfig from './playwright.ci.minimal.config';

// Stabilizing: wired in by #1554 on 2026-11-18, flaky under CI load; returns to the
// required lanes as each is proven stable. Functional Smoke (stabilizing) runs these
// on every pull request and on main and reports, but CI result does not wait for it.
// Same server, browser and settings as the browser lane.
const STABILIZING_SPECS = [
  'agent-usage.spec.ts',
  'all-machines.spec.ts',
  'appearance-bootstrap.spec.ts',
  'changes-list.spec.ts',
  'keyboard-navigation.spec.ts',
  'orchestration-sessions.spec.ts',
  'remote-host-switcher.spec.ts',
  'terminal-file-links.spec.ts',
  'usage-and-limits.spec.ts',
];

export default defineConfig({
  ...browserConfig,
  projects: [{ ...browserConfig.projects![0], testMatch: STABILIZING_SPECS }],
});
