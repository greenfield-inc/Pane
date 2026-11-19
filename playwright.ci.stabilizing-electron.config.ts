import { defineConfig } from '@playwright/test';
import electronConfig from './playwright.chat-tabs.config';

// Stabilizing: wired in by #1554 on 2026-11-18, flaky under CI load; returns to the
// required lanes as each is proven stable. Functional Smoke (Electron) runs these in a
// step that reports without failing the job. They run only with PANE_ELECTRON_E2E=1,
// which that step sets.
export default defineConfig({
  ...electronConfig,
  testMatch: ['browser-auth-persistence.spec.ts', 'remote-browser-files.spec.ts', 'browser-agents.spec.ts'],
});
