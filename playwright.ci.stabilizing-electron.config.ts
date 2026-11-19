import { defineConfig } from '@playwright/test';
import electronConfig from './playwright.chat-tabs.config';

// Reported only: Functional Smoke (Electron) runs these in a step that reports without
// failing the job. browser-agents.spec.ts:104 (added by #1550) failed once in CI (run
// 44487357192) after passing 10 of 10 in probe #1588, cause not yet known; it returns to
// playwright.chat-tabs.config.ts once it is found. The step sets PANE_ELECTRON_E2E=1.
export default defineConfig({
  ...electronConfig,
  testMatch: ['browser-agents-probe-old.spec.ts', 'browser-agents-probe-new.spec.ts', 'browser-agents.spec.ts'],
  repeatEach: 3,
});
