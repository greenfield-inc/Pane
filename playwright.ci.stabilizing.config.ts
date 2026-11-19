import { defineConfig } from '@playwright/test';
import browserConfig from './playwright.ci.minimal.config';

// Reported only: Functional Smoke (stabilizing) runs these on every pull request and on
// main, but CI result does not wait for it. all-machines.spec.ts:489 failed 1 of 10 in CI
// (run 44473620612) and 1 of 160 on parsa-devbox, cause not yet known; the file returns to
// the browser lane once it is fixed. Same server, browser and settings as the browser lane.
export default defineConfig({
  ...browserConfig,
  projects: [{ ...browserConfig.projects![0], testMatch: ['all-machines.spec.ts'] }],
});
