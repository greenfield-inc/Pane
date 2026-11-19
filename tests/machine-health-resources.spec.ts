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

  test('mixed volumes keep a healthy primary badge and identify the temp warning', async ({ page }) => {
    await open(page, 'machine=devbox&mixed-volumes=1');
    const disk = page.getByRole('region', { name: 'Disk', exact: true });
    await expect(disk.getByText('· /srv/pane-data')).toBeVisible();
    await expect(disk.getByText('800 GB free', { exact: true })).toHaveClass(/bg-surface-secondary/);
    await expect(disk.getByText('/tmp (temp)')).toBeVisible();
    await expect(disk.getByText('12 GB free of 32 GB')).toHaveClass(/text-status-warning/);
    for (const theme of ['light', 'dark']) {
      await page.evaluate(theme => { document.documentElement.className = theme === 'dark' ? 'dark dusk dusk-oled' : 'light folio'; }, theme);
      for (const width of [1300, 420]) {
        await page.setViewportSize({ width, height: 1000 });
        await expect(disk.getByText('/tmp (temp)')).toBeVisible();
        if (shots) await disk.screenshot({ path: `${shots}/mixed-volumes-${theme}-${width}.png` });
      }
    }
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

  test('Other apps opens into each app; stop asks once by name and runs on that machine; protected apps say why', async ({ page }) => {
    await open(page, 'machine=local');
    const memory = page.getByRole('region', { name: 'Memory' });
    await memory.getByRole('button', { name: 'Other apps' }).click();
    const apps = memory.getByLabel('Other apps', { exact: true }).getByRole('listitem');
    await expect(apps.first()).toContainText('Google Chrome23 processes4.2 GB12%');
    await expect(apps).toHaveCount(12);
    await expect(memory.getByRole('img', { name: 'Finder cannot be stopped: Part of macOS. Pane never stops system processes.' })).toBeVisible();
    await expect(memory.getByRole('img', { name: /^Terminal cannot be stopped: Pane runs inside it/ })).toBeVisible();
    await expect(memory.getByRole('button', { name: 'Stop Finder' })).toHaveCount(0);
    await memory.getByRole('button', { name: 'Show all 14 apps' }).click();
    await expect(apps).toHaveCount(14);

    await memory.getByRole('button', { name: 'Stop Slack' }).click();
    const dialog = page.getByRole('dialog', { name: 'Stop Slack?' });
    await expect(dialog).toContainText('Pane ends Slack now (6 processes). Unsaved work in it may be lost.');
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await memory.getByRole('button', { name: 'Stop node' }).click();
    await expect(page.getByRole('dialog', { name: 'Stop node?' })).toContainText('Pane ends every node process outside this Pane now (2 processes), including ones started in other terminals.');
    await page.getByRole('dialog', { name: 'Stop node?' }).getByRole('button', { name: 'Cancel' }).click();
    expect(await page.evaluate(() => window.qaRuns)).toEqual([]);

    await memory.getByRole('button', { name: 'Stop Google Chrome' }).click();
    await page.getByRole('dialog', { name: 'Stop Google Chrome?' }).getByRole('button', { name: 'Stop Google Chrome' }).click();
    await expect(memory.getByText('Google Chrome')).toHaveCount(0);
    expect(await page.evaluate(() => window.qaRuns)).toEqual([
      { machineId: 'local', command: { type: 'machine-health', action: 'stop-app', request: { key: '/Applications/Google Chrome.app', source: 'ui' } } },
    ]);

    await memory.getByRole('button', { name: 'Other apps' }).click();
    await expect(memory.getByLabel('Other apps', { exact: true })).toHaveCount(0);
  });

  test('Other apps on a linked machine stops there; a Pane too old for the list says to update it', async ({ page }) => {
    await open(page, 'machine=devbox');
    const memory = page.getByRole('region', { name: 'Memory' });
    await memory.getByRole('button', { name: 'Other apps' }).click();
    await expect(memory.getByRole('img', { name: /^explorer cannot be stopped: Part of Windows/ })).toBeVisible();
    await memory.getByRole('button', { name: 'Stop chrome' }).click();
    await page.getByRole('dialog', { name: 'Stop chrome?' }).getByRole('button', { name: 'Stop chrome' }).click();
    await expect.poll(() => page.evaluate(() => window.qaRuns)).toEqual([
      { machineId: 'devbox', command: { type: 'machine-health', action: 'stop-app', request: { key: 'chrome', source: 'ui' } } },
    ]);

    await open(page, 'machine=local&apps=outdated');
    await page.getByRole('region', { name: 'Memory' }).getByRole('button', { name: 'Other apps' }).click();
    await expect(page.getByText('Update Pane on this machine to list its apps.')).toBeVisible();
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

  test('switching machine replaces every section with the new machine\'s', async ({ page }) => {
    await open(page, 'machine=devbox');
    await expect(page.getByText('Runs on devbox').first()).toBeVisible();
    await page.getByRole('button', { name: /devbox/ }).first().click();
    await page.getByRole('listbox', { name: 'Machine' }).getByText('Studio-Mac').click();
    await expect(page.getByText('Pressure high')).toBeVisible();
    await expect(page.getByRole('heading', { name: /^Recommendations/ })).toHaveCount(1);
    await expect(page.getByRole('region', { name: 'Per Pane' })).toHaveCount(1);
    await expect(page.getByText('Runs on devbox')).toHaveCount(0);
  });

  test('Ask an agent hands the request to a Clean up Session and shows it; a linked machine is reached by its saved id', async ({ page }) => {
    await open(page, 'machine=devbox');
    await page.getByRole('button', { name: 'Ask an agent to clean up' }).click();
    await expect.poll(() => page.evaluate(() => window.qaSelected)).toEqual(['qa-session']);
    const [ask] = await page.evaluate(() => window.qaInvokes.filter(call => call.channel === 'resource-monitor:machine-ask-agent'));
    expect(ask.args).toEqual([{ name: 'Clean up devbox', prompt: expect.stringMatching(/^This is about the linked machine devbox\. Run each runpane command there as `runpane workspace devbox <command>`\. Help me free disk and memory on devbox\./) }]);
    expect(await page.evaluate(() => window.qaSwitches)).toEqual([]);
  });

  test('with the window on the devbox, its own request runs there and a request about this computer switches back first', async ({ page }) => {
    await open(page, 'machine=devbox&window=devbox');
    await page.getByRole('button', { name: 'Ask an agent to clean up' }).click();
    await expect.poll(() => page.evaluate(() => window.qaSelected.length)).toBe(1);
    await page.getByRole('button', { name: /devbox/ }).first().click();
    await page.getByRole('listbox', { name: 'Machine' }).getByText('Studio-Mac').click();
    await expect(page.getByText('Pressure high')).toBeVisible();
    await page.getByRole('button', { name: 'Ask an agent to clean up' }).click();
    await expect.poll(() => page.evaluate(() => window.qaSelected.length)).toBe(2);
    const asks = await page.evaluate(() => window.qaInvokes.filter(call => call.channel === 'resource-monitor:machine-ask-agent').map(call => call.args[0]));
    expect(asks).toEqual([
      { name: 'Clean up devbox', prompt: expect.stringMatching(/^Help me free disk and memory on devbox\./) },
      { name: 'Clean up Studio-Mac', prompt: expect.stringMatching(/^Help me free disk and memory on Studio-Mac\./) },
    ]);
    expect(await page.evaluate(() => window.qaSwitches)).toEqual(['local']);
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
    await page.getByRole('region', { name: 'Memory' }).getByRole('button', { name: 'Other apps' }).click();
    await expect(page.getByRole('button', { name: 'Stop chrome' })).toBeDisabled();
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
      await open(page, `machine=local&theme=${theme}`);
      await page.getByRole('region', { name: 'Memory' }).getByRole('button', { name: 'Other apps' }).click();
      await page.getByRole('region', { name: 'Memory' }).screenshot({ path: `${shots}/resources-other-apps-${theme}.png` });
      await page.getByRole('button', { name: 'Stop Google Chrome' }).click();
      await page.screenshot({ path: `${shots}/resources-other-apps-confirm-${theme}.png` });
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
