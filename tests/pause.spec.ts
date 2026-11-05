import { expect, test, type Page } from '@playwright/test';
import { installElectronApiMock } from './electronApiMock';
import type { JsonObject, JsonValue } from '../shared/validation/boundaryDecoder';

const iso = new Date(0).toISOString();
const twoDaysAgo = new Date(Date.now() - 49 * 3600_000).toISOString();
const project = { id: 1, name: 'pane', path: '/tmp/pane', active: true, created_at: iso, updated_at: iso };
const pane = (id: string, name: string, extra: JsonObject = {}): JsonObject => ({
  id, name, worktreePath: `/tmp/pane/${name}`, prompt: '', status: 'stopped', createdAt: iso, lastActivity: iso,
  output: [], jsonMessages: [], isRunning: false, permissionMode: 'ignore', projectId: 1, displayOrder: 0,
  isFavorite: false, toolType: 'none', archived: false, isHidden: false, ...extra,
});
const tab = (id: string, title: string, position: number, customState: JsonObject): JsonObject => ({
  id, sessionId: 'p-run', type: 'terminal', title,
  state: { isActive: position === 0, hasBeenViewed: true, customState: { isInitialized: false, ...customState } },
  metadata: { createdAt: iso, lastActiveAt: iso, position },
});

type InvokeCalls = { getInvokeCalls: (channel: string) => Array<{ args: JsonValue[] }> };

async function open(page: Page) {
  await installElectronApiMock(page, {
    platform: 'darwin',
    initialProjects: [project],
    initialSessions: [pane('p-run', 'pause-sessions'), pane('p-paused', 'fix-tailnet-banner', { paused: { at: twoDaysAgo, by: 'auto', idleHours: 48 } })],
    initialPanels: [
      tab('t-dev', 'pnpm dev', 0, { initialCommand: 'pnpm dev', paused: { at: twoDaysAgo, by: 'manual' } }),
      tab('t-checks', 'gh pr checks', 1, { initialCommand: 'gh pr checks --watch' }),
    ],
    activeProjectId: 1,
    initialUiState: { expandedProjects: [1] },
  });
  // The host's pause and resume commands, recorded instead of run.
  await page.addInitScript(() => {
    const invoke = window.electronAPI.invoke;
    const calls: JsonValue[] = [];
    Object.assign(window.electronAPI, {
      invoke: (channel: string, ...args: JsonValue[]) => {
        if (!/^runpane:(panels|panes|sessions):(pause|resume)$/.test(channel)) return invoke(channel, ...args);
        calls.push([channel, ...args]);
        window.localStorage.setItem('pause-calls', JSON.stringify(calls));
        return Promise.resolve({ ok: true, message: 'done' });
      },
    });
  });
  await page.goto('/', { waitUntil: 'domcontentloaded' });
}

const pauseCalls = async (page: Page): Promise<string> => (await page.evaluate(() => window.localStorage.getItem('pause-calls'))) ?? '[]';
const initializeCalls = (page: Page) => page.evaluate(() => {
  // SAFETY: installElectronApiMock defines this test-only object before the app loads.
  const mock = (window as typeof window & { __paneTestElectronMock: InvokeCalls }).__paneTestElectronMock;
  return mock.getInvokeCalls('panels:initialize').map(call => String(call.args[0]));
});

test('a Pane row offers Pause under Pin, and Resume once it is paused', async ({ page }) => {
  await open(page);
  await page.getByRole('button', { name: 'pause-sessions', exact: true }).click({ button: 'right' });
  const running = page.getByRole('menu', { name: 'Pane actions for pause-sessions' }).getByRole('menuitem');
  await expect(running.nth(0)).toHaveText('Pin');
  await expect(running.nth(1)).toHaveText('Pause');
  await expect(running.last()).toHaveText('Archive');
  await running.nth(1).click();
  await expect.poll(() => pauseCalls(page)).toBe(JSON.stringify([['runpane:panes:pause', { paneId: 'p-run' }]]));

  await page.getByRole('button', { name: 'fix-tailnet-banner', exact: true }).click({ button: 'right' });
  const paused = page.getByRole('menu', { name: 'Pane actions for fix-tailnet-banner' }).getByRole('menuitem');
  await expect(paused.nth(1)).toHaveText('Resume');
});

test('a paused tab shows its last screen without starting, and Resume starts it through the host', async ({ page }) => {
  await open(page);
  await page.getByRole('button', { name: 'pause-sessions', exact: true }).click();
  await expect(page.getByTestId('paused-terminal-view')).toContainText('Paused 2 days ago');
  // The running tab beside it starts as usual; the paused one never asks to.
  await page.getByRole('tab', { name: 'gh pr checks', exact: true }).click();
  await expect.poll(() => initializeCalls(page)).toContain('t-checks');
  expect(await initializeCalls(page)).not.toContain('t-dev');

  await page.getByRole('tab', { name: 'gh pr checks', exact: true }).click({ button: 'right' });
  await expect(page.getByRole('menuitem', { name: 'Pause tab' })).toBeVisible();
  await page.keyboard.press('Escape');

  await page.getByRole('tab', { name: 'pnpm dev', exact: true }).click({ button: 'right' });
  const items = page.getByRole('menu', { name: 'pnpm dev actions' }).getByRole('menuitem');
  await expect(items).toHaveText(['Rename tab…', 'Resume tab', 'Close tab']);
  await page.getByRole('menuitem', { name: 'Resume tab' }).click();
  await expect.poll(() => pauseCalls(page)).toBe(JSON.stringify([['runpane:panels:resume', { panelId: 't-dev' }]]));
});
