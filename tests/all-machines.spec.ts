import { expect, test, type Page } from '@playwright/test';
import { installElectronApiMock } from './electronApiMock';
import type { MachineCommand, MachineConnectionsEvent, MachineState } from '../shared/types/machineConnections';
import type { TailnetMachineList } from '../shared/types/workspaceAccess';
import type { JsonObject, JsonValue } from '../shared/validation/boundaryDecoder';
import { notifyFixture } from './fixtures/notifySnapshot';

type MachinesMock = {
  getMachineRuns: () => Array<{ machineId: string; command: MachineCommand }>;
  getMachineReads: () => Array<{ machineId: string; channel: string }>;
  getPreferences: () => Record<string, string>;
  emitMachineEvent: (event: MachineConnectionsEvent, reads?: Record<string, Record<string, JsonValue>>) => void;
  getNavigationMemory: (hostId: string | null) => JsonValue;
  emitRemoteDaemonResyncRequested: (event: { hostChanged: boolean }) => void;
  getConfig: () => { machineMarks?: JsonObject };
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
const project = (id: number, name: string, panes: JsonValue[], repository?: string) => {
  const row = { id, name, path: `/code/${name}`, active: false, created_at: '2026-10-01T00:00:00Z', updated_at: '2026-10-01T00:00:00Z', sessions: panes };
  return repository ? { ...row, repository } : row;
};
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

const PROJECTS = ['acme-web', 'infra', 'pane', 'blog'];

/**
 * Turns All machines on. Projects start closed; `open` opens them all, as most tests need their
 * Pane rows. `preferences` are this computer's saved ones, to stand in for a relaunch.
 */
async function openAllMachines(page: Page, colorScheme: 'light' | 'dark' = 'light', { open = true, preferences = {}, extra = {} }: { open?: boolean; preferences?: Record<string, string>; extra?: Partial<Parameters<typeof installElectronApiMock>[1]> } = {}) {
  await page.emulateMedia({ colorScheme });
  await installElectronApiMock(page, {
    initialPreferences: preferences,
    // The mock serves one set of Panes whichever machine the app is on: build-box's, once it switches there.
    initialProjects: [{ id: 1, name: 'acme-web', path: '/code/acme-web', active: true, created_at: '2026-10-01T00:00:00Z', updated_at: '2026-10-01T00:00:00Z' }],
    initialSessions: [pane('a1', 'load-test-checkout', 1, '2026-10-30T08:30:00Z')],
    platform: 'darwin',
    workspaceAccess: { machineName: 'studio-mac' },
    tailnetMachines,
    machineConnections: { machines, reads },
    initialConfig: { appearanceMode: 'system' },
    ...extra,
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
  // A relaunch comes back in All machines.
  if (preferences.sidebar_all_machines !== 'true') {
    await page.getByRole('button', { name: 'Agents run on studio-mac. Switch machine' }).click();
    await page.getByRole('menuitemradio', { name: /All machines/ }).click();
  }
  await expect(page.getByTestId('all-machines-sidebar')).toBeVisible();
  await expect(page.getByTestId('all-machines-project')).toHaveCount(4);
  // A relaunch keeps the projects it had open.
  if (open) {
    for (const name of PROJECTS) {
      const expand = page.getByRole('button', { name: `Expand project ${name}` });
      if (await expand.count()) await expand.click();
    }
  }
}

const sessionRows = (page: Page) => page.getByTestId('all-machines-session-row');
const savedLayout = async (page: Page) => (await mock(page)).evaluate(api => api.getPreferences().sidebar_all_machines_layout ?? null);

const projectRows = (page: Page, name: string) => page.getByTestId('all-machines-project')
  .filter({ has: page.getByRole('button', { name: `Collapse project ${name}` }) })
  .getByTestId('all-machines-pane-row');

test('All machines lists every machine\'s rows, one project per repository, and keeps an offline machine\'s rows', async ({ page }) => {
  await openAllMachines(page);

  await expect(page.getByTestId('all-machines-project')).toHaveCount(4);
  // acme-web is open on studio-mac and build-box: one project, each Pane with its machine.
  await expect(projectRows(page, 'acme-web')).toHaveText([/fix-checkout-race.*S$/, /add-dark-mode.*S$/, /load-test-checkout.*B$/]);
  await expect(page.getByRole('button', { name: 'fix-checkout-race on studio-mac' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'load-test-checkout on build-box' })).toBeVisible();
  await expect(page.getByTestId('all-machines-session-row')).toHaveText([/Spring sale launch.*2.*S$/, /Backup rotation.*1.*B$/]);
  await expect(page.getByRole('status').filter({ hasText: 'travel-laptop went offline at 9:14' })).toContainText('Its rows are from then.');
  await expect(page.getByRole('button', { name: 'trip-notes on travel-laptop' })).toBeVisible();
  expect(await (await mock(page)).evaluate(api => api.getPreferences().sidebar_all_machines)).toBe('true');
});

test('agent events move no Session or Pane row', async ({ page }) => {
  await openAllMachines(page);
  const before = await projectRows(page, 'acme-web').allTextContents();
  await expect(sessionRows(page)).toHaveText([/Spring sale launch/, /Backup rotation/]);

  // build-box's Pane starts working, then asks you something; its Session turns blocked and updates.
  for (const state of ['working', 'blocked'] as const) {
    await (await mock(page)).evaluate((api, build) => api.emitMachineEvent(
      { type: 'event', machineId: 'build', channel: 'panel:agentStatus', args: [] },
      { build },
    ), { 'panels:agent-statuses': { success: true, data: [
      { panelId: 'p', sessionId: 'a1', state, reason: null },
      { panelId: 'q', sessionId: 's1-internal', state, reason: null },
    ] } });
    // The event landed: build-box's statuses were read again and its Session shows the state.
    await expect(page.getByTestId('all-machines-session-row').filter({ hasText: 'Backup rotation' }).getByLabel(state === 'working' ? /working/i : /blocked|needs/i).first()).toBeVisible();
    await expect(projectRows(page, 'acme-web')).toHaveText(before);
    await expect(sessionRows(page)).toHaveText([/Spring sale launch/, /Backup rotation/]);
  }
});

test('switching to All machines opens no project, and what you open is remembered across a relaunch', async ({ page, browser }) => {
  await openAllMachines(page, 'light', { open: false });
  for (const name of PROJECTS) await expect(page.getByRole('button', { name: `Expand project ${name}` })).toHaveAttribute('aria-expanded', 'false');
  await expect(page.getByTestId('all-machines-pane-row')).toHaveCount(0);
  // No Pane opened by itself.
  await expect(page.getByTestId('window-title-bar-label').filter({ hasText: /fix-checkout-race|load-test-checkout|add-dark-mode/ })).toHaveCount(0);

  await page.getByRole('button', { name: 'Expand project infra' }).click();
  await page.getByRole('button', { name: 'Expand Backup rotation' }).click();
  // Leave All machines for one machine, then come back.
  await page.getByRole('button', { name: 'Showing all machines. Switch machine' }).click();
  await page.getByRole('menuitemradio', { name: /studio-mac/ }).click();
  await page.getByRole('button', { name: /Switch machine/ }).click();
  await page.getByRole('menuitemradio', { name: /All machines/ }).click();
  await expect(page.getByRole('button', { name: 'Collapse project infra' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Collapse Backup rotation' })).toBeVisible();

  const relaunched = await browser.newPage();
  await openAllMachines(relaunched, 'light', { open: false, preferences: await (await mock(page)).evaluate(api => api.getPreferences()) });
  await expect(relaunched.getByRole('button', { name: 'Collapse project infra' })).toBeVisible();
  await expect(relaunched.getByRole('button', { name: 'Collapse Backup rotation' })).toBeVisible();
  for (const name of ['acme-web', 'pane', 'blog']) await expect(relaunched.getByRole('button', { name: `Expand project ${name}` })).toBeVisible();
  await relaunched.close();
});

test('two computers keep their own arrangement: a drag saves on this computer only and survives a relaunch', async ({ page, browser }) => {
  await openAllMachines(page);
  // Drag build-box's Session above this computer's; move a Pane down with Alt+Down.
  await sessionRows(page).filter({ hasText: 'Backup rotation' }).dragTo(sessionRows(page).filter({ hasText: 'Spring sale launch' }), { targetPosition: { x: 20, y: 2 } });
  await expect(sessionRows(page)).toHaveText([/Backup rotation/, /Spring sale launch/]);
  await page.getByRole('button', { name: 'fix-checkout-race on studio-mac' }).focus();
  await page.keyboard.press('Alt+ArrowDown');
  await expect(projectRows(page, 'acme-web')).toHaveText([/add-dark-mode/, /fix-checkout-race/, /load-test-checkout/]);
  await expect(page.getByRole('button', { name: 'fix-checkout-race on studio-mac' })).toBeFocused();

  expect(JSON.parse(await savedLayout(page) ?? '{}')).toMatchObject({
    sessions: ['build:s1', 'local:s1'],
    panes: { 'name:acme-web': ['local:a2', 'local:a1', 'build:a1'] },
  });
  // Nothing was sent to any machine: their own orders are unchanged.
  expect(await (await mock(page)).evaluate(api => api.getMachineRuns())).toEqual([]);

  // Another computer with no arrangement of its own starts from each machine's order.
  const other = await browser.newPage();
  await openAllMachines(other);
  await expect(sessionRows(other)).toHaveText([/Spring sale launch/, /Backup rotation/]);
  await expect(projectRows(other, 'acme-web')).toHaveText([/fix-checkout-race/, /add-dark-mode/, /load-test-checkout/]);
  await other.close();

  const relaunched = await browser.newPage();
  await openAllMachines(relaunched, 'light', { preferences: await (await mock(page)).evaluate(api => api.getPreferences()) });
  await expect(sessionRows(relaunched)).toHaveText([/Backup rotation/, /Spring sale launch/]);
  await expect(projectRows(relaunched, 'acme-web')).toHaveText([/add-dark-mode/, /fix-checkout-race/, /load-test-checkout/]);
  await relaunched.close();
});

test('before anything is dragged, a new Session or Pane on another machine still lands first', async ({ page }) => {
  await openAllMachines(page);
  await expect(sessionRows(page)).toHaveText([/Spring sale launch/, /Backup rotation/]);
  await expect(projectRows(page, 'acme-web')).toHaveText([/fix-checkout-race/, /add-dark-mode/, /load-test-checkout/]);

  const fresh = { ...pane('a9', 'new-pane-on-build', 1, '2026-10-30T10:00:00Z'), createdAt: '2026-10-30T10:00:00Z' };
  const nightly = { ...session('s2', 'Nightly rebuild', []), createdAt: '2026-10-30T10:00:00Z' };
  await (await mock(page)).evaluate((api, build) => {
    api.emitMachineEvent({ type: 'event', machineId: 'build', channel: 'session:created', args: [] }, { build });
    api.emitMachineEvent({ type: 'event', machineId: 'build', channel: 'orchestration-sessions:changed', args: [] }, { build });
  }, {
    'sessions:get-all-with-projects': { success: true, data: [
      project(1, 'acme-web', [fresh, pane('a1', 'load-test-checkout', 1, '2026-10-30T08:30:00Z')]),
      project(2, 'infra', [pane('b2', 'terraform-upgrade', 2, '2026-10-30T08:40:00Z')]),
    ] },
    'orchestration-sessions:list': { success: true, data: { sessions: [nightly, session('s1', 'Backup rotation', ['b2'])] } },
  });

  await expect(sessionRows(page)).toHaveText([/Nightly rebuild/, /Spring sale launch/, /Backup rotation/]);
  await expect(projectRows(page, 'acme-web')).toHaveText([/new-pane-on-build/, /fix-checkout-race/, /add-dark-mode/, /load-test-checkout/]);
});

test('a new Session or Pane lands first in its list and every other row keeps its place', async ({ page }) => {
  await openAllMachines(page);
  await page.getByRole('button', { name: 'Session Backup rotation on build-box' }).focus();
  await page.keyboard.press('Alt+ArrowUp');
  await page.getByRole('button', { name: 'load-test-checkout on build-box' }).focus();
  await page.keyboard.press('Alt+ArrowUp');
  await expect(sessionRows(page)).toHaveText([/Backup rotation/, /Spring sale launch/]);
  await expect(projectRows(page, 'acme-web')).toHaveText([/fix-checkout-race/, /load-test-checkout/, /add-dark-mode/]);

  const fresh = { ...pane('a9', 'new-pane-on-build', 1, '2026-10-30T10:00:00Z'), createdAt: '2026-10-30T10:00:00Z' };
  const nightly = { ...session('s2', 'Nightly rebuild', []), createdAt: '2026-10-30T10:00:00Z' };
  await (await mock(page)).evaluate((api, build) => {
    api.emitMachineEvent({ type: 'event', machineId: 'build', channel: 'session:created', args: [] }, { build });
    api.emitMachineEvent({ type: 'event', machineId: 'build', channel: 'orchestration-sessions:changed', args: [] }, { build });
  }, {
    'sessions:get-all-with-projects': { success: true, data: [
      project(1, 'acme-web', [fresh, pane('a1', 'load-test-checkout', 1, '2026-10-30T08:30:00Z')]),
      project(2, 'infra', [pane('b2', 'terraform-upgrade', 2, '2026-10-30T08:40:00Z')]),
    ] },
    'orchestration-sessions:list': { success: true, data: { sessions: [nightly, session('s1', 'Backup rotation', ['b2'])] } },
  });

  await expect(sessionRows(page)).toHaveText([/Nightly rebuild/, /Backup rotation/, /Spring sale launch/]);
  await expect(projectRows(page, 'acme-web')).toHaveText([/new-pane-on-build/, /fix-checkout-race/, /load-test-checkout/, /add-dark-mode/]);
});

for (const scheme of ['light', 'dark'] as const) test(`one project row per repository, with a mark for each machine it is on (${scheme})`, async ({ page }, testInfo) => {
  await openAllMachines(page, scheme, { open: false });
  // build-box cloned acme-web under another folder name; parsa-devbox has a different repository
  // with the same folder name; travel-laptop runs an older Pane, so its projects carry no identity.
  await (await mock(page)).evaluate((api, reads) => {
    for (const [machineId, answers] of Object.entries(reads)) {
      api.emitMachineEvent({ type: 'event', machineId, channel: 'project:list-changed', args: [] }, { [machineId]: answers });
    }
  }, {
    local: { 'sessions:get-all-with-projects': { success: true, data: [project(1, 'acme-web', [pane('a1', 'fix-checkout-race', 1, '2026-10-30T09:10:00Z')], 'github.com/acme/web')] } },
    build: { 'sessions:get-all-with-projects': { success: true, data: [
      project(1, 'web-checkout', [pane('a1', 'load-test-checkout', 1, '2026-10-30T08:30:00Z')], 'github.com/acme/web'),
      project(2, 'infra', [pane('b2', 'terraform-upgrade', 2, '2026-10-30T08:40:00Z')], 'github.com/acme/infra'),
    ] } },
    devbox: { 'sessions:get-all-with-projects': { success: true, data: [project(1, 'acme-web', [pane('d1', 'fork-sync', 1, '2026-10-30T08:20:00Z')], 'github.com/someone/acme-web')] } },
    travel: { 'sessions:get-all-with-projects': { success: true, data: [project(4, 'infra', [pane('t1', 'trip-notes', 4, '2026-10-30T07:00:00Z')])] } },
  });

  const projects = page.getByTestId('all-machines-project');
  await expect(projects.getByTestId('all-machines-project-machines')).toHaveCount(3);
  await expect(projects.getByTestId('all-machines-project-machines').nth(0)).toHaveAccessibleName('On studio-mac, build-box');
  await expect(projects.getByTestId('all-machines-project-machines').nth(1)).toHaveAccessibleName('On build-box, travel-laptop');
  await expect(projects.getByTestId('all-machines-project-machines').nth(2)).toHaveAccessibleName('On parsa-devbox');

  await projects.nth(0).getByRole('button', { name: 'Expand project acme-web' }).click();
  await expect(projects.nth(0).getByTestId('all-machines-pane-row')).toHaveText([/fix-checkout-race.*S$/, /load-test-checkout.*B$/]);
  await page.screenshot({ path: testInfo.outputPath(`all-machines-repositories-${scheme}.png`) });
});

test('row actions run on the row\'s own machine without switching', async ({ page }) => {
  await openAllMachines(page);
  await page.getByRole('button', { name: 'load-test-checkout on build-box' }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Pin' }).click();

  await expect.poll(async () => (await mock(page)).evaluate(api => api.getMachineRuns()))
    .toEqual([{ machineId: 'build', command: { type: 'pin', target: { kind: 'pane', id: 'a1' }, pinned: true } }]);
  await expect(page.getByRole('button', { name: 'Showing all machines. Switch machine' })).toBeVisible();
});

for (const scheme of ['light', 'dark'] as const) {
  test(`Switch to chat on a Session runs on its own machine, after showing what it will skip (${scheme})`, async ({ page }, testInfo) => {
    const tab = (panelId: string, paneName: string, title: string) => ({ panelId, paneName, title });
    const busy = { kind: 'busy', reason: 'Claude is in the middle of a turn. Nothing was switched.' };
    const plain = { kind: 'plain-codex', reason: 'Pane could not tell which conversation this terminal is running: Codex reports its conversation ID only when it exits. Nothing was switched.' };
    const shell = { kind: 'not-agent', reason: 'Only a terminal tab running Claude or Codex can switch to chat. Nothing was switched.' };
    const items = [
      tab('s1-c', 'Session', 'Claude'), tab('p-1', 'terraform-upgrade', 'Claude'), tab('p-2', 'terraform-upgrade', 'Review'),
      tab('p-3', 'terraform-upgrade', 'Codex'), { ...tab('p-4', 'terraform-upgrade', 'QA'), skip: busy },
      { ...tab('p-5', 'terraform-upgrade', 'Codex 2'), skip: plain }, { ...tab('p-6', 'terraform-upgrade', 'Terminal'), skip: shell },
    ];
    await openAllMachines(page, scheme, { extra: { machineRunAnswers: { build: {
      'preview-switch-to-chat': { sessionId: 's1', items },
      'switch-to-chat': { sessionId: 's1', items: items.map(item => ({ ...item, result: item.skip ? 'skipped' : 'switched' })) },
    } } } });

    await sessionRows(page).filter({ hasText: 'Backup rotation' }).click({ button: 'right' });
    await expect(page.getByRole('menuitem', { name: 'Switch to chat…' })).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath(`all-machines-session-menu-${scheme}.png`) });
    await page.getByRole('menuitem', { name: 'Switch to chat…' }).click();
    const dialog = page.getByRole('dialog', { name: 'Switch Session to chat' });
    await expect(dialog).toContainText('Will switch (4)');
    await expect(dialog).toContainText('Will skip (3)');
    await expect(dialog).toContainText('plain Codex: ');
    await page.screenshot({ path: testInfo.outputPath(`all-machines-session-switch-confirm-${scheme}.png`) });
    await dialog.getByRole('button', { name: 'Switch 4 tabs' }).click();

    await expect(dialog.getByTestId('session-switch-summary')).toHaveText('4 switched, 3 skipped: busy, plain Codex, not an agent');
    await page.screenshot({ path: testInfo.outputPath(`all-machines-session-switch-summary-${scheme}.png`) });
    expect(await (await mock(page)).evaluate(api => api.getMachineRuns())).toEqual([
      { machineId: 'build', command: { type: 'preview-switch-to-chat', sessionId: 's1' } },
      { machineId: 'build', command: { type: 'switch-to-chat', sessionId: 's1', panelIds: ['s1-c', 'p-1', 'p-2', 'p-3'] } },
    ]);
  });
}

test('a Session with nothing that can switch has no Switch to chat in its menu', async ({ page }) => {
  await openAllMachines(page, 'light', { extra: { machineRunAnswers: { build: {
    'preview-switch-to-chat': { sessionId: 's1', items: [{ panelId: 'p-6', paneName: 'terraform-upgrade', title: 'Terminal', skip: { kind: 'not-agent', reason: 'Not an agent.' } }] },
  } } } });
  await sessionRows(page).filter({ hasText: 'Backup rotation' }).click({ button: 'right' });
  await expect.poll(async () => (await mock(page)).evaluate(api => api.getMachineRuns().length)).toBe(1);
  await expect(page.getByRole('menuitem', { name: 'Rename Session…' })).toBeVisible();
  await expect(page.getByRole('menuitem', { name: 'Switch to chat…' })).toHaveCount(0);
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

  await expect(projectRows(page, 'acme-web').first()).toHaveText(/load-test-checkout.*B$/);
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

// D-198: All machines has the same top list as one machine: Loops, Autopilot, then Approvals (D-117).
const autopilotSnapshot: JsonObject = {
  enabled: true, chatTabsEnabled: true, entitlement: { entitled: true }, run: null, panelId: null, ownerPaneId: null,
  state: 'stopped', sentinel: false, stack: { entries: [], shownId: null }, walk: { sessions: [] },
};
for (const scheme of ['light', 'dark'] as const) test(`All machines shows the Autopilot row between Loops and Approvals, and it opens Autopilot (${scheme})`, async ({ page }, testInfo) => {
  await openAllMachines(page, scheme, { extra: { autopilotSnapshot, notifySnapshot: notifyFixture() } });
  const sidebar = page.getByTestId('all-machines-sidebar');
  await expect(sidebar.locator('[data-testid="loops-nav"] + [data-testid="autopilot-nav"] + [data-testid="approvals-nav"]')).toHaveCount(1);
  await expect(sidebar.getByTestId('autopilot-nav-state')).toHaveText('Start');
  await page.screenshot({ path: testInfo.outputPath(`all-machines-autopilot-row-${scheme}.png`) });
  await sidebar.getByTestId('autopilot-nav').click();
  await expect(sidebar.getByTestId('autopilot-nav')).toHaveAttribute('aria-current', 'page');
  await expect(page.getByTestId('all-machines-sidebar')).toBeVisible();
});

// P6, journey 10: every row ends with an 18px letter mark on the machine's colour.
for (const scheme of ['light', 'dark'] as const) test(`each row ends with an 18px letter mark that names its machine and OS (${scheme})`, async ({ page }, testInfo) => {
  await openAllMachines(page, scheme);
  const tripNotes = page.getByTestId('all-machines-pane-row').filter({ hasText: 'trip-notes' });
  await expect(tripNotes.getByRole('img', { name: 'on travel-laptop', exact: true })).toHaveText('T');
  await expect(page.getByTestId('all-machines-session-row').getByTestId('machine-row-mark')).toHaveText(['S', 'B']);
  // The mark and the actions button share one 18px box.
  for (const box of [await tripNotes.getByTestId('all-machines-mark-slot').boundingBox(), await tripNotes.getByRole('button', { name: 'Actions for trip-notes' }).boundingBox()]) {
    expect(box).toMatchObject({ width: 18, height: 18 });
  }
  // Project rows show one bare letter per machine.
  await expect(page.getByTestId('all-machines-project-machines').first()).toHaveText('SB');
  await page.screenshot({ path: testInfo.outputPath(`p6-all-machines-${scheme}.png`), clip: { x: 0, y: 0, width: 720, height: 700 } });

  // Focusing the box (Tab from the row reaches its actions button) names the machine and its OS.
  await page.getByRole('button', { name: 'trip-notes on travel-laptop' }).focus();
  await page.keyboard.press('Tab');
  await expect(tripNotes.getByRole('button', { name: 'Actions for trip-notes' })).toBeFocused();
  await expect(page.getByRole('tooltip')).toHaveText('travel-laptop · macOS');
  await page.screenshot({ path: testInfo.outputPath(`p6-all-machines-tooltip-${scheme}.png`), clip: { x: 0, y: 0, width: 720, height: 700 } });
});

test('the switcher\'s pencil changes a machine\'s letter and colour on this computer, kept across a relaunch until reset', async ({ page, browser }, testInfo) => {
  await openAllMachines(page);
  await page.getByRole('button', { name: 'Showing all machines. Switch machine' }).click();
  await expect(page.getByRole('menuitemradio', { name: /travel-laptop/ }).getByTestId('machine-mark')).toHaveText('T');
  await page.getByRole('menuitemradio', { name: /travel-laptop/ }).hover();
  await page.getByRole('button', { name: 'Change the mark for travel-laptop' }).click();
  const popover = page.getByRole('dialog', { name: 'Mark for travel-laptop' });
  await expect(popover.getByLabel('Letter for travel-laptop')).toBeFocused();
  await popover.getByLabel('Letter for travel-laptop').fill('tl');
  await popover.getByRole('radio', { name: 'Lime' }).click();
  await expect(popover.getByRole('radio', { name: 'Lime' })).toHaveAttribute('aria-checked', 'true');
  await expect(page.getByRole('menuitemradio', { name: /travel-laptop/ }).getByTestId('machine-mark')).toHaveText('TL');
  await page.screenshot({ path: testInfo.outputPath('p6-switcher-popover-light.png'), clip: { x: 0, y: 0, width: 720, height: 700 } });
  const saved = await (await mock(page)).evaluate(api => api.getConfig().machineMarks ?? null);
  expect(saved).toEqual({ 'travel-laptop': { letters: 'TL', color: 'Lime' } });

  // Escape closes the popover first, then the menu.
  await page.keyboard.press('Escape');
  await expect(popover).toHaveCount(0);
  await expect(page.getByRole('menu', { name: 'Agents run on' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('img', { name: 'on travel-laptop', exact: true })).toHaveText('TL');

  // A relaunch on this computer keeps it; Reset to automatic brings back T.
  const relaunched = await browser.newPage();
  await openAllMachines(relaunched, 'light', { extra: { initialConfig: { appearanceMode: 'system', machineMarks: saved } } });
  await expect(relaunched.getByRole('img', { name: 'on travel-laptop', exact: true })).toHaveText('TL');
  await relaunched.getByRole('button', { name: 'Showing all machines. Switch machine' }).click();
  await relaunched.getByRole('menuitemradio', { name: /travel-laptop/ }).hover();
  await relaunched.getByRole('button', { name: 'Change the mark for travel-laptop' }).click();
  await relaunched.getByRole('button', { name: 'Reset to automatic' }).click();
  await expect(relaunched.getByRole('menuitemradio', { name: /travel-laptop/ }).getByTestId('machine-mark')).toHaveText('T');
  expect(await (await mock(relaunched)).evaluate(api => api.getConfig().machineMarks ?? null)).toEqual({});
  await relaunched.close();
});

test('typing a digit in the mark editor\'s letter field sets the mark instead of picking a machine', async ({ page }) => {
  await openAllMachines(page);
  await page.getByRole('button', { name: 'Showing all machines. Switch machine' }).click();
  await page.getByRole('menuitemradio', { name: /travel-laptop/ }).hover();
  await page.getByRole('button', { name: 'Change the mark for travel-laptop' }).click();
  const popover = page.getByRole('dialog', { name: 'Mark for travel-laptop' });
  const field = popover.getByLabel('Letter for travel-laptop');
  await expect(field).toBeFocused();
  // 1 would pick this computer and 2 build-box while the switcher is open.
  await page.keyboard.type('A1');
  await expect(field).toHaveValue('A1');
  await expect(popover).toBeVisible();
  await expect(page.getByRole('menu', { name: 'Agents run on' })).toBeVisible();
  await expect(page.getByRole('menuitemradio', { name: /travel-laptop/ }).getByTestId('machine-mark')).toHaveText('A1');
  expect(await (await mock(page)).evaluate(api => api.getConfig().machineMarks ?? null)).toEqual({ 'travel-laptop': { letters: 'A1' } });
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: 'Showing all machines. Switch machine' })).toBeVisible();
  await expect(page.getByTestId('all-machines-sidebar')).toBeVisible();
});

// P6, journey 9: machines by key.
test('⌘⌥O opens the switcher, 0 picks All machines and a digit picks that machine; ⌃⌘0 goes back and forth', async ({ page }) => {
  await openAllMachines(page);
  await page.keyboard.press('ControlOrMeta+Alt+o');
  await expect(page.getByRole('menu', { name: 'Agents run on' })).toBeVisible();
  // The switcher lists All machines, then this computer (1), build-box (2), …
  await page.keyboard.press('2');
  await expect(page.getByRole('menu', { name: 'Agents run on' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Agents run on build-box. Switch machine' })).toBeVisible();

  await page.keyboard.press('ControlOrMeta+Alt+o');
  await page.keyboard.press('0');
  await expect(page.getByTestId('all-machines-sidebar')).toBeVisible();

  // All machines ⇄ the machine it was showing.
  const toggleAll = process.platform === 'darwin' ? 'Meta+Control+0' : 'Control+Alt+Shift+0';
  await page.keyboard.press(toggleAll);
  await expect(page.getByTestId('all-machines-sidebar')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Agents run on build-box. Switch machine' })).toBeVisible();
  await page.keyboard.press(toggleAll);
  await expect(page.getByTestId('all-machines-sidebar')).toBeVisible();
});

test('next and previous machine step through the switcher order and skip an offline machine', async ({ page }) => {
  await openAllMachines(page);
  const next = process.platform === 'darwin' ? 'Meta+Control+BracketRight' : 'Control+Alt+Shift+BracketRight';
  const previous = process.platform === 'darwin' ? 'Meta+Control+BracketLeft' : 'Control+Alt+Shift+BracketLeft';
  const label = (name: string) => page.getByRole('button', { name: `Agents run on ${name}. Switch machine` });
  await page.keyboard.press(next);
  await expect(label('studio-mac')).toBeVisible();
  await page.keyboard.press(next);
  await expect(label('build-box')).toBeVisible();
  await page.keyboard.press(next);
  await expect(label('parsa-devbox')).toBeVisible();
  // travel-laptop is offline, so next wraps to this computer.
  await page.keyboard.press(next);
  await expect(label('studio-mac')).toBeVisible();
  await page.keyboard.press(previous);
  await expect(label('parsa-devbox')).toBeVisible();
});
