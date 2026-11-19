import { defineConfig } from '@playwright/test';
import browserConfig from './playwright.ci.minimal.config';

// The WebGL renderer recovery spec, in its own CI lane. Its 25 tests take about
// 16 s each, and Playwright shards by test count in file order, so in the browser
// lane they all landed in one shard and set the run's time. Here they get their
// own shards. Same server, browser and settings as the browser lane.
export default defineConfig({
  ...browserConfig,
  projects: [{ ...browserConfig.projects![0], name: 'webgl', testMatch: ['terminal-blur-recovery.spec.ts'] }],
});
