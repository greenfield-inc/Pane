import { expect, test, type Page } from '@playwright/test';
import { installElectronApiMock } from './electronApiMock';
import type { MachineCommand, MachineConnectionsEvent, MachineState } from '../shared/types/machineConnections';
import type { TailnetMachineList } from '../shared/types/workspaceAccess';
import type { JsonValue } from '../shared/validation/boundaryDecoder';

type MachinesMock = {
  getMachineRuns: () => Array<{ machineId: string; command: MachineCommand }>;
  getMachineReads: () => Array<{ machineId: string; channel: string }>;
  getPreferences: () => Record<string, string>;
  emitMachineEvent: (event: MachineConnectionsEvent, reads?: Record<string, Record<string, JsonValue>>) => void;
  getNavigationMemory: (hostId: string | null) => JsonValue;
  emitRemoteDaemonResyncRequested: (event: { hostChanged: boolean }) => void;
};

const mock = (page: Page) => page.evaluateHandle(() => {
  // SAFETY: installElectronApiMock defines this test-only object before the app loads.
  return (window as typeof window & { __paneTestElectronMock: MachinesMock }).__paneTestElectronMock;
});

// Each machine's rows are hours old, so a Pane that turns active is the newest by far.
const pane = (id: string, name: string, projectId: number, lastActivity: string) => ({
  id, name, projectId, worktreePath: `/code/${name}`, prompt: '', status: 'stopped', createdAt: '2026-10-30T08:00:00Z', lastActivity,
  output: [], jsonMessages: [], archived: false, isHidden: false, isFavorite: false,
});
const project = (id: number, name: string, panes: JsonValue[]) => ({
  id, name, path: `/code/${name}`, active: false, created_at: '2026-10-01T00:00:00Z', updated_at: '2026-10-01T00:00:00Z', sessions: panes,
});
const session = (id: string, name: string, paneIds: string[]) => ({
  id, name, agent: 'claude', internalSessionId: `${id}-internal`, panelIds: { claude: `${id}-c`, codex: `${id}-x`, cursor: `${id}-u` },
  goal: '', context: '', decisions: [], blockers: [], nextAction: '', evidence: [], outputs: [], activity: [], revision: 1,
  associations: paneIds.map(paneId => ({ paneId, panelIds: [], attachedAt: '2026-10-30T08:00:00Z' })),
  createdAt: '2026-10-30T08:00:00Z', updatedAt: '2026-10-30T09:00:00Z',
});
const lists = (projects: JsonValue[], sessions: JsonValue[] = [], statuses: JsonValue[] = []) => ({
  'sessions:get-all-with-projects': { success: true, data: projects },
  'orchestration-sessions:list': { success: true, data: { sessions } },
  'panels:agent-statuses': { success: true, data: statuses },
  'permission:getPending': { success: true, data: [] },
  'notify:remote-snapshot': null,
});

const machines: MachineState[] = [
  { id: 'local', label: 'This computer', kind: 'local', status: 'online', offlineSince: null },
  { id: 'build', label: 'build-box', kind: 'remote', status: 'online', offlineSince: null },
  { id: 'devbox', label: 'parsa-devbox', kind: 'remote', status: 'online', offlineSince: null },
  // No zone: local time, so it reads 9:14 wherever the test runs.
  { id: 'travel', label: 'travel-laptop', kind: 'remote', status: 'offline', offlineSince: '2026-10-30T09:14:00' },
];

const reads = {
  local: lists(
    [project(1, 'acme-web', [pane('a1', 'fix-checkout-race', 1, '2026-10-30T09:10:00Z'), pane('a2', 'add-dark-mode', 1, '2026-10-30T09:00:00Z')])],
    [session('s1', 'Spring sale launch', ['a1', 'a2'])],
  ),
  // Same project and Pane ids as this computer's, on another machine.
  build: lists(
    [
      project(1, 'acme-web', [pane('a1', 'load-test-checkout', 1, '2026-10-30T08:30:00Z')]),
      project(2, 'infra', [pane('b2', 'terraform-upgrade', 2, '2026-10-30T08:40:00Z')]),
    ],
    [session('s1', 'Backup rotation', ['b2'])],
  ),
  devbox: lists([project(1, 'pane', [pane('d1', 'windows-installer', 1, '2026-10-30T08:20:00Z')])]),
  travel: lists([project(4, 'blog', [pane('t1', 'trip-notes', 4, '2026-10-30T07:00:00Z')])]),
};

const tailnetMachines: TailnetMachineList = {
  ok: true,
  tailnet: 'demo.github',
  domain: 'tail1234.ts.net',
  machines: [
    { name: 'build-box', dnsName: 'build-box.tail1234.ts.net', url: 'https://build-box.tail1234.ts.net:8443', os: 'Linux', ownerLogin: 'demo@github', mine: true, state: 'available', profileId: 'build' },
    { name: 'parsa-devbox', dnsName: 'parsa-devbox.tail1234.ts.net', url: 'https://parsa-devbox.tail1234.ts.net:8443', os: 'Windows', ownerLogin: 'demo@github', mine: true, state: 'available', profileId: 'devbox' },
    { name: 'travel-laptop', dnsName: 'travel-laptop.tail1234.ts.net', url: 'https://travel-laptop.tail1234.ts.net:8443', os: 'macOS', ownerLogin: 'demo@github', mine: true, state: 'offline', profileId: 'travel' },
  ],
};

async function openAllMachines(page: Page, colorScheme: 'light' | 'dark' = 'light') {
  await page.emulateMedia({ colorScheme });
  await installElectronApiMock(page, {
    // The mock serves one set of Panes whichever machine the app is on: build-box's, once it switches there.
    initialProjects: [{ id: 1, name: 'acme-web', path: '/code/acme-web', active: true, created_at: '2026-10-01T00:00:00Z', updated_at: '2026-10-01T00:00:00Z' }],
    initialSessions: [pane('a1', 'load-test-checkout', 1, '2026-10-30T08:30:00Z')],
    platform: 'darwin',
    workspaceAccess: { machineName: 'studio-mac' },
    tailnetMachines,
    machineConnections: { machines, reads },
    initialConfig: { appearanceMode: 'system' },
  });
  await page.goto('/');
  await page.evaluate(async (saved) => {
    for (const machine of saved) {
      await window.electronAPI.remoteDaemon.upsertConnectionProfile({
        id: machine.id, label: machine.name, baseUrl: `https://${machine.name}.tail1234.ts.net:8443`, token: '', transport: 'http+sse',
        tailnetMachine: machine.name, tailnetDomain: 'tail1234.ts.net',
      });
    }
  }, [{ id: 'build', name: 'build-box' }, { id: 'devbox', name: 'parsa-devbox' }, { id: 'travel', name: 'travel-laptop' }]);
  await page.getByRole('button', { name: 'Agents run on studio-mac. Switch machine' }).click();
  await page.getByRole('menuitemradio', { name: /All machines/ }).click();
  await expect(page.getByTestId('all-machines-sidebar')).toBeVisible();
}

const projectRows = (page: Page, name: string) => page.getByTestId('all-machines-project')
  .filter({ has: page.getByRole('button', { name: `Collapse project ${name}` }) })
  .getByTestId('all-machines-pane-row');

test('All machines lists every machine\'s rows, one project per repository, and keeps an offline machine\'s rows', async ({ page }) => {
  await openAllMachines(page);

  await expect(page.getByTestId('all-machines-project')).toHaveCount(4);
  // acme-web is open on studio-mac and build-box: one project, each Pane with its machine.
  await expect(projectRows(page, 'acme-web')).toHaveText([/fix-checkout-race.*studi/, /add-dark-mode.*studi/, /load-test-checkout.*build/]);
  await expect(page.getByRole('button', { name: 'fix-checkout-race on studio-mac' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'load-test-checkout on build-box' })).toBeVisible();
  await expect(page.getByTestId('all-machines-session-row')).toHaveText([/Spring sale launch.*2.*studi/, /Backup rotation.*1.*build/]);
  await expect(page.getByRole('status').filter({ hasText: 'travel-laptop went offline at 9:14' })).toContainText('Its rows are from then.');
  await expect(page.getByRole('button', { name: 'trip-notes on travel-laptop' })).toBeVisible();
  expect(await (await mock(page)).evaluate(api => api.getPreferences().sidebar_all_machines)).toBe('true');
});

test('a Pane that turns active on another machine moves to the top of its project', async ({ page }) => {
  await openAllMachines(page);
  await (await mock(page)).evaluate((api, build) => api.emitMachineEvent(
    { type: 'event', machineId: 'build', channel: 'panel:agentStatus', args: [] },
    { build },
  ), { 'panels:agent-statuses': { success: true, data: [{ panelId: 'p', sessionId: 'a1', state: 'working', reason: null }] } });

  await expect(projectRows(page, 'acme-web').first()).toHaveText(/load-test-checkout.*build/, { timeout: 2_000 });
});

test('row actions run on the row\'s own machine without switching', async ({ page }) => {
  await openAllMachines(page);
  await page.getByRole('button', { name: 'load-test-checkout on build-box' }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Pin' }).click();

  await expect.poll(async () => (await mock(page)).evaluate(api => api.getMachineRuns()))
    .toEqual([{ machineId: 'build', command: { type: 'pin', target: { kind: 'pane', id: 'a1' }, pinned: true } }]);
  await expect(page.getByRole('button', { name: 'Showing all machines. Switch machine' })).toBeVisible();
});

test('allowing a permission from the row menu shows what the agent will run on that machine first', async ({ page }, testInfo) => {
  await openAllMachines(page);
  const request = { id: 'req-1', sessionId: 'a1', toolName: 'Bash', input: { command: 'rm -rf /srv/releases' }, timestamp: 1 };
  await (await mock(page)).evaluate((api, build) => api.emitMachineEvent(
    { type: 'event', machineId: 'build', channel: 'permission:request', args: [] },
    { build },
  ), { 'permission:getPending': { success: true, data: [request] } });
  // The first read of build-box's pending requests, then the one this event asks for.
  await expect.poll(async () => (await mock(page)).evaluate(api => api.getMachineReads()
    .filter(read => read.machineId === 'build' && read.channel === 'permission:getPending').length)).toBe(2);

  await page.getByRole('button', { name: 'load-test-checkout on build-box' }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Allow Bash…' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toContainText('rm -rf /srv/releases');
  await expect(dialog).toContainText('load-test-checkout on build-box');
  expect(await (await mock(page)).evaluate(api => api.getMachineRuns())).toEqual([]);
  await page.screenshot({ path: testInfo.outputPath('all-machines-permission-light.png') });
  await dialog.getByRole('button', { name: 'Allow' }).click();

  await expect.poll(async () => (await mock(page)).evaluate(api => api.getMachineRuns())).toEqual([{
    machineId: 'build',
    command: { type: 'answer-permission', requestId: 'req-1', response: { behavior: 'allow', updatedInput: { command: 'rm -rf /srv/releases' } } },
  }]);
});

test('a pinned Pane shows its pin at rest and sorts first in its project', async ({ page }, testInfo) => {
  await openAllMachines(page);
  const pinned = { ...pane('a1', 'load-test-checkout', 1, '2026-10-30T08:30:00Z'), isFavorite: true };
  await (await mock(page)).evaluate((api, build) => api.emitMachineEvent(
    { type: 'event', machineId: 'build', channel: 'session:updated', args: [] },
    { build },
  ), { 'sessions:get-all-with-projects': { success: true, data: [project(1, 'acme-web', [pinned])] } });

  await expect(projectRows(page, 'acme-web').first()).toHaveText(/load-test-checkout.*build/);
  await expect(projectRows(page, 'acme-web').first().getByRole('img', { name: 'Pinned' })).toBeVisible();
  await expect(projectRows(page, 'acme-web').getByRole('img', { name: 'Pinned' })).toHaveCount(1);
  await page.screenshot({ path: testInfo.outputPath('all-machines-pinned-light.png') });
});

test('opening a Pane on another machine switches to it, opens the Pane and keeps the sidebar in All machines', async ({ page }, testInfo) => {
  await openAllMachines(page);
  await page.getByRole('button', { name: 'load-test-checkout on build-box' }).click();
  // The switch leaves the Pane in build-box's navigation memory; main's host-change resync restores it.
  await expect.poll(async () => (await mock(page)).evaluate(api => api.getNavigationMemory('build')))
    .toEqual({ view: 'sessions', projectId: null, paneId: 'a1' });
  await (await mock(page)).evaluate(api => api.emitRemoteDaemonResyncRequested({ hostChanged: true }));

  await expect(page.getByTestId('window-title-bar-machine')).toHaveText('on build-box');
  await expect(page.getByTestId('window-title-bar-label')).toContainText('load-test-checkout');
  await expect(page.getByTestId('all-machines-sidebar')).toBeVisible();
  await expect(page.getByRole('button', { name: 'load-test-checkout on build-box' })).toHaveAttribute('aria-current', 'page');
  await page.screenshot({ path: testInfo.outputPath('all-machines-opened-light.png') });
});

for (const scheme of ['light', 'dark'] as const) test(`opening a Pane on an offline machine says it is offline (${scheme})`, async ({ page }, testInfo) => {
  await openAllMachines(page, scheme);
  await page.getByRole('button', { name: 'trip-notes on travel-laptop' }).click();

  await expect(page.getByTestId('machine-offline-view')).toContainText('travel-laptop is offline');
  await expect(page.getByTestId('machine-offline-view')).toContainText('It stopped answering at 9:14');
  await expect(page.getByTestId('window-title-bar-label')).toHaveText(/trip-notes\s*on travel-laptop/);
  await page.screenshot({ path: testInfo.outputPath(`all-machines-offline-${scheme}.png`) });
});

for (const scheme of ['light', 'dark'] as const) test(`search in All machines finds a Pane on another machine, labelled with it (${scheme})`, async ({ page }, testInfo) => {
  await openAllMachines(page, scheme);
  await page.getByRole('button', { name: 'Search all machines' }).click();
  await page.getByRole('combobox', { name: 'Search' }).fill('windows-inst');

  await expect(page.getByRole('option', { name: /windows-installer.*on parsa-devbox/ })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath(`all-machines-search-${scheme}.png`) });
});

for (const scheme of ['light', 'dark'] as const) test(`the machine menu marks All machines as chosen (${scheme})`, async ({ page }, testInfo) => {
  await openAllMachines(page, scheme);
  await expect(projectRows(page, 'acme-web')).toHaveCount(3);
  await page.screenshot({ path: testInfo.outputPath(`all-machines-sidebar-${scheme}.png`) });
  await page.getByRole('button', { name: 'Showing all machines. Switch machine' }).click();
  await expect(page.getByRole('menuitemradio', { name: /All machines/ })).toHaveAttribute('aria-checked', 'true');
  await page.screenshot({ path: testInfo.outputPath(`all-machines-menu-${scheme}.png`) });
});
