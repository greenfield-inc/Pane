import { defineConfig } from '@playwright/test';
import electronConfig from './playwright.chat-tabs.config';

// Reported only: Functional Smoke (Electron) runs these in a step that reports without
// failing the job. todos-upgrade.spec.ts (R21, added by #1481) hung past its 180 s timeout
// once on main (run 44596759187) after passing 10 of 10 in probe #1610, cause not yet
// known; it returns to playwright.chat-tabs.config.ts once it is found. The step sets
// PANE_ELECTRON_E2E=1.
export default defineConfig({
  ...electronConfig,
  testMatch: ['todos-upgrade.spec.ts'],
});
