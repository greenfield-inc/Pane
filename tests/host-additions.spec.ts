import { expect, test, type Page } from '@playwright/test';
import { installElectronApiMock } from './electronApiMock';
import type { RemoteDaemonClientRecord } from '../shared/types/remoteDaemon';
import type { RunpaneHostPushAllResult, RunpaneHostUnpushedResult } from '../shared/types/runpaneOrchestration';
import type { JsonObject, JsonValue } from '../shared/validation/boundaryDecoder';

const SHOTS = process.env.PANE_SCREENSHOT_DIR ?? 'test-results/host-additions';
const THEMES = {
  light: { theme: 'light-rounded', appearanceMode: 'fixed' },
  dark: { theme: 'dark' },
} satisfies Record<'light' | 'dark', JsonObject>;

/** The calls the mock recorded on one channel. */
function invokeCalls(page: Page, channel: string) {
  return page.evaluate((name) => {
    // SAFETY: installElectronApiMock defines this test hook on window before the page loads.
    const mock = (window as typeof window & { __paneTestElectronMock: { getInvokeCalls(channel: string): Array<{ channel: string; args: JsonValue[] }> } }).__paneTestElectronMock;
    return mock.getInvokeCalls(name);
  }, channel);
}
const theme = process.env.PANE_SCREENSHOT_THEME === 'dark' ? 'dark' : 'light';

const inFiveMinutes = () => new Date(Date.now() + 5 * 60_000).toISOString();
const hostClients = (): RemoteDaemonClientRecord[] => [
  { id: 'waiting', label: 'devbox Pane daemon', createdAt: '2026-11-05T10:00:00.000Z', tokenHash: 'a'.repeat(64), person: 'Ada', claimBy: inFiveMinutes() },
  { id: 'connected', label: 'devbox Pane daemon', createdAt: '2026-11-05T09:00:00.000Z', tokenHash: 'b'.repeat(64), person: 'Grace', claimedAt: '2026-11-05T09:01:00.000Z', claimedDevice: 'Grace iPhone' },
  { id: 'used', label: 'devbox Pane daemon', createdAt: '2026-11-04T09:00:00.000Z', tokenHash: 'c'.repeat(64), person: 'Linus', claimedAt: '2026-11-04T09:01:00.000Z', claimedDevice: 'linus-laptop' },
];

const unpushed: RunpaneHostUnpushedResult = {
  checkedPanes: 4,
  checkedAt: '2026-11-05T10:00:00.000Z',
  items: [
    { paneId: 'pane-a', paneName: 'fix-login', repoName: 'web', branch: 'fix-login', safetyCheck: { performed: true, unpushedCommits: 3, hasUncommittedChanges: true } },
    { paneId: 'pane-b', paneName: 'docs-refresh', repoName: 'web', branch: 'docs-refresh', safetyCheck: { performed: true, unpushedCommits: 0, hasUntrackedFiles: true } },
    { paneId: 'pane-d', paneName: 'Main', repoName: 'web', branch: 'main', safetyCheck: { performed: true, unpushedCommits: 1 } },
  ],
};
const pushed: RunpaneHostPushAllResult = {
  remaining: 1,
  results: [
    { paneId: 'pane-a', paneName: 'fix-login', outcome: 'pushed', committedWip: true, pushedTo: 'origin/fix-login' },
    { paneId: 'pane-b', paneName: 'docs-refresh', outcome: 'failed', committedWip: true, message: 'Pushing docs-refresh failed: rejected. Pull in docs-refresh and push again.' },
    { paneId: 'pane-d', paneName: 'Main', outcome: 'pushed', committedWip: false, pushedTo: 'origin/pane/saved/main' },
  ],
};

async function openRemoteAccess(page: Page, options: Parameters<typeof installElectronApiMock>[1] = {}) {
  await installElectronApiMock(page, { initialConfig: THEMES[theme], ...options });
  await page.goto('/', { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await expect(page.locator('[data-testid="sidebar"]').first()).toBeVisible({ timeout: 10_000 });
  await page.getByRole('button', { name: 'Settings' }).first().click();
  await page.getByRole('button', { name: 'Remote Access', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Remote Access', exact: true })).toBeVisible();
}

test.describe('Named connection codes', () => {
  test('Devices name each person and say whether their code is waiting, connected or used', async ({ page }) => {
    await openRemoteAccess(page, {
      hostClients: hostClients(),
      hostConnectedClients: [{ id: '1', clientId: 'connected', label: 'devbox Pane daemon', deviceLabel: 'Grace iPhone', remoteAddress: '100.64.0.9', connectedAt: '2026-11-05T10:00:00.000Z', lastSeenAt: '2026-11-05T10:00:05.000Z', person: 'Grace' }],
    });
    // The innermost section is the group itself; the page is a section too.
    const devices = page.locator('section', { has: page.getByRole('heading', { name: /^Devices/ }) }).last();
    await expect(devices).toContainText(/Waiting for Ada · expires \d{1,2}:\d{2}/);
    await expect(devices).toContainText('GraceConnected now · Grace iPhone');
    await expect(devices).toContainText('LinusUsed on linus-laptop, Nov 4');
    await devices.scrollIntoViewIfNeeded();
    await devices.screenshot({ path: `${SHOTS}/devices-${theme}.png` });
  });

  test('Set Up Host asks who a code is for, then says it works once', async ({ page }) => {
    await openRemoteAccess(page, { hostClients: hostClients() });
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
    await page.getByRole('button', { name: 'Set Up Host', exact: true }).click();
    await page.getByRole('button', { name: 'Create & Copy Code' }).click();
    const form = page.getByRole('form', { name: 'New connection code' });
    await expect(form.getByRole('button', { name: 'Create & Copy' })).toBeDisabled();
    await form.getByLabel('Who is it for?').fill('Margaret');
    await page.screenshot({ path: `${SHOTS}/code-dialog-${theme}.png`, fullPage: true });

    await form.getByRole('button', { name: 'Create & Copy' }).click();
    await expect(page.getByText(/^Copied a code for Margaret · works once · expires \d{1,2}:\d{2}/)).toBeVisible();
    await expect(form).toHaveCount(0);
    await expect(page.getByText(/Waiting for Margaret · expires/)).toBeVisible();
    expect(await invokeCalls(page, 'remote-daemon:create-host-connection-code')).toEqual([{ channel: 'remote-daemon:create-host-connection-code', args: [{ person: 'Margaret' }] }]);
    await page.screenshot({ path: `${SHOTS}/code-created-${theme}.png`, fullPage: true });
  });
});

test.describe('Work not on GitHub', () => {
  async function openThisMachine(page: Page, options: Parameters<typeof installElectronApiMock>[1]) {
    await openRemoteAccess(page, options);
    await page.getByRole('button', { name: /details$/ }).first().click();
    return page.locator('section', { has: page.getByRole('heading', { name: 'Work not on GitHub' }) }).last();
  }

  test('lists Panes with work only here and pushes them all once, after one confirm', async ({ page }) => {
    const group = await openThisMachine(page, { hostUnpushed: unpushed, hostPushAll: pushed });
    await expect(group).toContainText('fix-login · 3 commits · uncommitted files');
    await expect(group).toContainText('docs-refresh · uncommitted files');
    await expect(group).toContainText('main · 1 commit');
    await group.screenshot({ path: `${SHOTS}/unpushed-list-${theme}.png` });

    await group.getByRole('button', { name: 'Push all' }).click();
    const confirm = group.getByRole('alertdialog', { name: 'Push all' });
    await expect(confirm).toContainText('Push 3 Panes? Uncommitted files are committed first.');
    await group.screenshot({ path: `${SHOTS}/unpushed-confirm-${theme}.png` });
    await confirm.getByRole('button', { name: 'Push all' }).click();

    await expect(group).toContainText('Committed as WIP and pushed to origin/fix-login');
    await expect(group).toContainText('Failed: Pushing docs-refresh failed: rejected. Pull in docs-refresh and push again.');
    await expect(group).toContainText('Pushed to origin/pane/saved/main');
    await expect(group).not.toContainText('3 commits');
    await expect(page.getByText('1 Pane still has work only on this machine.')).toBeVisible();
    await expect(group.getByRole('button', { name: 'Push all' })).toHaveCount(0);
    expect(await invokeCalls(page, 'runpane:host:push-all')).toHaveLength(1);
    await group.screenshot({ path: `${SHOTS}/unpushed-results-${theme}.png` });
  });

  test('says so when everything is on GitHub', async ({ page }) => {
    const group = await openThisMachine(page, {});
    await expect(group).toContainText('Everything here is on GitHub.');
    await expect(group.getByRole('button', { name: 'Push all' })).toHaveCount(0);
    await group.screenshot({ path: `${SHOTS}/unpushed-empty-${theme}.png` });
  });
});
