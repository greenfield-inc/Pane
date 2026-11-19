import { defineConfig } from '@playwright/test';
import browserConfig from './playwright.ci.minimal.config';

// Reported only: Functional Smoke (stabilizing) runs these on every pull request and on
// main, but CI result does not wait for it. tab-popover.spec.ts:85 failed once in CI (run
// 44485044464) and passed 200 of 200 on parsa-devbox, cause not yet known; the file returns
// to the browser lane once it is found. Same server, browser and settings as the browser lane.
export default defineConfig({
  ...browserConfig,
  projects: [{ ...browserConfig.projects![0], testMatch: ['tab-popover.spec.ts'] }],
});
