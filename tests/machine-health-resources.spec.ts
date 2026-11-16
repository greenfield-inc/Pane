import { expect, test, type Page } from '@playwright/test';
import path from 'node:path';

// The Resources page on canned machine health data (tests/fixtures/resources-view.tsx).
const fixture = path.resolve('tests/fixtures/resources-view.tsx');
const shots = process.env.MACHINE_HEALTH_SHOTS;

async function open(page: Page, query: string) {
  await page.route('**/resources-view.html*', route => route.fulfill({ contentType: 'text/html', body: `<html><head><meta charset="UTF-8"></head><body><div id="root"></div><script type="module">import RefreshRuntime from "/@react-refresh"; RefreshRuntime.injectIntoGlobalHook(window); window.$RefreshReg$ = () => {}; window.$RefreshSig$ = () => type => type; window.__vite_plugin_react_preamble_installed__ = true;</script><script type="module" src="/@vite/client"></script><script type="module" src="/@fs/${fixture}"></script></body></html>` }));
  await page.setViewportSize({ width: 1300, height: 1500 });
  await page.goto(`/resources-view.html?${query}`);
  await expect(page.getByRole('heading', { name: 'Resources' })).toBeVisible();
}

test.describe('Resources page', () => {
  test('shows disk, memory, recommendations, Panes and what Pane does not manage', async ({ page }) => {
    await open(page, 'machine=local');
    await expect(page.getByText('913 GB of 926 GB used')).toBeVisible();
    await expect(page.getByText('13 GB free')).toBeVisible();
    await expect(page.getByText('Pressure high')).toBeVisible();
    await expect(page.getByText('Clear old agent temp files')).toBeVisible();
    await expect(page.getByText('Automatic', { exact: true })).toBeVisible();
    await expect(page.getByText('Not managed by Pane')).toBeVisible();
    await expect(page.getByText('git worktree remove "/Users/me/bloom-mono/worktrees/agent-made"')).toBeVisible();
  });

  test('Clear and Stop run on the selected machine; Review lists finished Panes with skipped ones unchecked', async ({ page }) => {
    await open(page, 'machine=devbox');
    await expect(page.getByText('Pressure normal')).toBeVisible();
    await page.getByRole('button', { name: 'Clear' }).first().click();
    await page.getByRole('button', { name: 'Stop', exact: true }).click();
    await page.getByRole('button', { name: /Review/ }).click();
    await expect(page.getByRole('checkbox', { name: 'Archive release-2.4.223' })).toBeDisabled();
    await page.getByRole('button', { name: 'Archive 2 Panes · 7.3 GB' }).click();
    await expect.poll(() => page.evaluate(() => window.qaRuns)).toEqual([
      { machineId: 'devbox', command: { type: 'machine-health', action: 'cleanup', request: { kinds: ['agent-temp'], source: 'ui' } } },
      { machineId: 'devbox', command: { type: 'machine-health', action: 'stop-processes', request: { source: 'ui', processes: [{ pid: 77, started: 's' }] } } },
      { machineId: 'devbox', command: { type: 'machine-health', action: 'archive-finished', request: { ids: ['f1', 'f3'], source: 'ui' } } },
    ]);
  });

  test('the switcher lists every machine: an older Pane asks for an update, an offline one says so', async ({ page }) => {
    await open(page, 'machine=local');
    await page.getByRole('button', { name: /Studio-Mac/ }).click();
    const list = page.getByRole('listbox', { name: 'Machine' });
    await expect(list.getByText('212 GB free · pressure normal')).toBeVisible();
    await expect(list.getByText('Windows')).toBeVisible();
    await expect(list.getByText('Update Pane on this machine to see its health')).toBeVisible();
    await expect(list.getByText('Offline')).toBeVisible();
    await list.getByText('build-box').click();
    await expect(page.getByRole('status')).toHaveText('Update Pane on this machine to see its health.');
  });

  test('a leaking run-script process offers Restart, Stop and Ignore', async ({ page }) => {
    await open(page, 'machine=local&leak=1');
    await expect(page.getByText('vite in homepage-alpine keeps using more memory')).toBeVisible();
    await page.getByRole('button', { name: 'Restart it' }).click();
    await expect.poll(() => page.evaluate(() => window.qaRuns)).toEqual([
      { machineId: 'local', command: { type: 'machine-health', action: 'restart-process', request: { pid: 21, started: 'Sun Nov 15 12:00:00 2026' } } },
    ]);
  });

  test('screenshots, light and dark', async ({ page }) => {
    test.skip(!shots, 'Set MACHINE_HEALTH_SHOTS to a folder to capture screenshots.');
    for (const theme of ['light', 'dark']) {
      await open(page, `machine=local&leak=1&theme=${theme}`);
      await page.screenshot({ path: `${shots}/resources-local-${theme}.png`, fullPage: true });
      await page.getByRole('button', { name: /Studio-Mac/ }).click();
      await expect(page.getByText('212 GB free · pressure normal')).toBeVisible();
      await page.screenshot({ path: `${shots}/resources-switcher-open-${theme}.png` });
      await open(page, `machine=devbox&theme=${theme}`);
      await page.getByRole('button', { name: /Review/ }).click();
      await page.screenshot({ path: `${shots}/resources-devbox-review-${theme}.png`, fullPage: true });
    }
  });
});
