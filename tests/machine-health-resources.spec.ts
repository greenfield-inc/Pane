import { expect, test, type Page } from '@playwright/test';
import path from 'node:path';

// The Resources page on canned machine health data (tests/fixtures/resources-view.tsx).
const fixture = path.resolve('tests/fixtures/resources-view.tsx');
const shots = process.env.MACHINE_HEALTH_SHOTS;

async function open(page: Page, query: string, heading = 'Resources') {
  await page.route('**/resources-view.html*', route => route.fulfill({ contentType: 'text/html', body: `<html><head><meta charset="UTF-8"></head><body><div id="root"></div><script type="module">import RefreshRuntime from "/@react-refresh"; RefreshRuntime.injectIntoGlobalHook(window); window.$RefreshReg$ = () => {}; window.$RefreshSig$ = () => type => type; window.__vite_plugin_react_preamble_installed__ = true;</script><script type="module" src="/@vite/client"></script><script type="module" src="/@fs/${fixture}"></script></body></html>` }));
  await page.setViewportSize({ width: 1300, height: 1500 });
  await page.goto(`/resources-view.html?${query}`);
  await expect(page.getByRole('heading', { name: heading })).toBeVisible();
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

  test('Per Pane shows CPU, and a Pane opens into its processes grouped by tab', async ({ page }) => {
    await open(page, 'machine=local');
    const table = page.getByRole('region', { name: 'Per Pane' });
    await expect(table.getByRole('columnheader', { name: 'CPU' })).toBeVisible();
    await table.getByRole('button', { name: 'glassly-port' }).click();
    await expect(table.getByText('Claude', { exact: true })).toBeVisible();
    await expect(table.getByText('Terminal 1', { exact: true })).toBeVisible();
    await expect(table.getByRole('row', { name: /pid 13 120 MB 0%/ })).toBeVisible();
    await expect(table.getByText('Worktree 410 MB, Dependencies 2.4 GB, Build outputs 205 MB, Scratch 102 MB, Agent temp 1.1 GB')).toBeAttached();
  });

  test('Clear and Stop run on the selected machine; Review lists finished Panes with skipped ones unchecked', async ({ page }) => {
    await open(page, 'machine=devbox');
    await expect(page.getByText('Pressure normal')).toBeVisible();
    await expect(page.getByText('Runs on devbox').first()).toBeVisible();
    await expect(page.getByRole('button', { name: 'Pause Panes idle 6+ hours' })).toBeVisible();
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

  test('a machine that goes offline keeps its last reading, greyed, with every action off', async ({ page }) => {
    await open(page, 'machine=devbox');
    await expect(page.getByText('Pressure normal')).toBeVisible();
    await page.evaluate(() => window.qaSetStatus('devbox', 'offline'));
    await expect(page.getByRole('status')).toHaveText('Offline. Showing what it reported just now.');
    await expect(page.getByRole('button', { name: 'Clear' }).first()).toBeDisabled();
    await expect(page.getByRole('button', { name: /Pause Panes idle/ })).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Ask an agent to clean up' })).toBeDisabled();
    await expect(page.getByRole('button', { name: /Review/ })).toBeDisabled();
  });

  test('a Pane that does not run housekeeping says so and turns its actions off', async ({ page }) => {
    await open(page, 'machine=devbox&housekeeping=off');
    await expect(page.getByText('Pane on devbox does not clean up: another Pane there owns its data folder. Act from that Pane.')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Stop', exact: true })).toBeDisabled();
  });

  test('a leaking run-script process offers Restart, Stop and Ignore', async ({ page }) => {
    await open(page, 'machine=local&leak=1');
    await expect(page.getByText('vite in homepage-alpine keeps using more memory')).toBeVisible();
    await page.getByRole('button', { name: 'Restart it' }).click();
    await expect.poll(() => page.evaluate(() => window.qaRuns)).toEqual([
      { machineId: 'local', command: { type: 'machine-health', action: 'restart-process', request: { pid: 21, started: 'Sun Nov 15 12:00:00 2026' } } },
    ]);
  });

  test('Settings saves only the changed key; Idle days refuses 0; Run now scans first', async ({ page }) => {
    await open(page, 'view=settings', 'Machine health');
    await expect(page.getByText('Stop leftover processes automatically')).toHaveCount(0);
    await page.getByRole('switch', { name: 'Archive finished Panes automatically' }).click();
    const idleDays = page.getByLabel('Idle days');
    await idleDays.fill('0');
    await idleDays.press('Enter');
    await expect(idleDays).toHaveAttribute('aria-invalid', 'true');
    await page.getByRole('button', { name: 'Run now' }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Scanning. Pane removes its leftovers when the scan ends' })).toBeVisible();
    expect(await page.evaluate(() => window.qaInvokes)).toEqual([{ channel: 'resource-monitor:machine-inventory', args: [{ refresh: true }] }]);
    expect(await page.evaluate(() => window.qaConfigUpdates)).toEqual([{ machineHealth: { autoArchiveFinished: true } }]);
  });

  test('screenshots, light and dark', async ({ page }) => {
    test.skip(!shots, 'Set MACHINE_HEALTH_SHOTS to a folder to capture screenshots.');
    for (const theme of ['light', 'dark']) {
      await open(page, `machine=local&leak=1&theme=${theme}`);
      await page.screenshot({ path: `${shots}/resources-local-${theme}.png`, fullPage: true });
      await page.getByRole('button', { name: /Studio-Mac/ }).click();
      await expect(page.getByText('212 GB free · pressure normal')).toBeVisible();
      await page.screenshot({ path: `${shots}/resources-switcher-open-${theme}.png` });
      await open(page, `machine=local&theme=${theme}`);
      await page.getByRole('region', { name: 'Per Pane' }).getByRole('button', { name: 'glassly-port' }).click();
      await page.getByRole('region', { name: 'Per Pane' }).scrollIntoViewIfNeeded();
      await page.getByRole('region', { name: 'Per Pane' }).screenshot({ path: `${shots}/resources-per-pane-processes-${theme}.png` });
      await open(page, `machine=devbox&theme=${theme}`);
      await page.getByRole('button', { name: /Review/ }).click();
      await page.screenshot({ path: `${shots}/resources-devbox-review-${theme}.png`, fullPage: true });
      await page.evaluate(() => window.qaSetStatus('devbox', 'offline'));
      await expect(page.getByRole('status')).toContainText('Offline');
      await page.screenshot({ path: `${shots}/resources-devbox-offline-${theme}.png`, fullPage: true });
      await open(page, `machine=devbox&housekeeping=off&theme=${theme}`);
      await page.screenshot({ path: `${shots}/resources-devbox-housekeeping-off-${theme}.png`, fullPage: true });
      await open(page, `view=settings&theme=${theme}`, 'Machine health');
      await page.getByRole('button', { name: 'Run now' }).click();
      await expect(page.getByText(/^Scanning\. Pane removes its leftovers/)).toBeVisible();
      await page.screenshot({ path: `${shots}/settings-machine-health-${theme}.png`, fullPage: true });
    }
  });
});
