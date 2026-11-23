import { expect, test, type Page } from '@playwright/test';
import { gotoApp, installElectronApiMock } from './electronApiMock';
import { dismissStartupDialogs, installSessionsFixture, sessionFixture } from './orchestrationSessionsFixture';
import type { MachineConnectionsEvent } from '../shared/types/machineConnections';
import type { OrchestrationSessionCreateInput } from '../shared/types/orchestrationSession';
import type { PaneCloudAction, PaneCloudClone, PaneCloudSnapshot } from '../shared/types/paneCloud';
import type { RemoteComputer } from '../shared/types/remoteComputers';
import { notifyFixture } from './fixtures/notifySnapshot';

type MockWindow = typeof window & {
  __paneTestElectronMock: {
    setPaneCloud(parts: Partial<PaneCloudSnapshot>): void;
    getPaneCloudCreates(): OrchestrationSessionCreateInput[];
    getPaneCloudCalls(): Array<{ action: string; vmId: string }>;
    setPaneCloudActions(vmId: string, actions: PaneCloudAction[]): void;
    getMachineRuns(): Array<{ machineId: string; command: { type: string } }>;
    getOpenedExternalUrls(): string[];
    emitMachineEvent(event: MachineConnectionsEvent): void;
  };
};

// L1's machine-inspection disclosure, which replaces the frame's shorter sentence.
const INSPECTION = "During the beta, your cloud Sessions are not private from Greenfield. Automated checks look at the programs running, the files on disk and where network traffic goes, to stop abuse such as crypto mining. A Greenfield staff member opens a Session's files only when its account has been flagged or the law requires it, through a read-only view, and each look is logged on your usage page unless the law forbids telling you. Do not put health records or anything else you cannot share on these terms into a cloud Session.";
const SECRETS = /Your secrets come along/;
/** Design screenshots are written only when asked for, so a test run leaves nothing behind. */
const screenshotPath = (name: string) => (process.env.PANE_CLOUD_SCREENSHOTS ? `${process.env.PANE_CLOUD_SCREENSHOTS}/${name}` : undefined);

async function openCreateSession(page: Page, cloud: Partial<PaneCloudSnapshot> = {}) {
  await installSessionsFixture(page, [], [], { initialConfig: { appearanceMode: 'fixed', theme: 'dark' } });
  await page.addInitScript((parts) => {
    // SAFETY: installElectronApiMock's init script, registered first, defines this test-only API.
    const mock = (window as MockWindow).__paneTestElectronMock;
    mock.setPaneCloud(parts);
    mock.emitMachineEvent({ type: 'machines', machines: [
      { id: 'local', label: 'This computer', kind: 'local', status: 'online', offlineSince: null },
      { id: 'studio', label: 'mac-studio', kind: 'remote', status: 'online', offlineSince: null },
      { id: 'laptop', label: 'old-laptop', kind: 'remote', status: 'offline', offlineSince: '2026-11-20T00:00:00.000Z' },
    ] });
  }, cloud);
  await gotoApp(page);
  await dismissStartupDialogs(page);
  await page.getByTestId('new-orchestration-session').click();
  const dialog = page.getByRole('dialog', { name: 'Create Session', exact: true });
  await expect(dialog).toBeVisible();
  return dialog;
}

test('creates a Session on Pane Cloud from Where it runs', async ({ page }) => {
  await page.setViewportSize({ width: 1200, height: 1100 });
  const dialog = await openCreateSession(page);
  await expect(dialog.getByRole('radio', { name: 'mac-studio', exact: true })).toBeAttached();
  await expect(dialog.getByRole('radio', { name: 'old-laptop', exact: true })).toHaveCount(0);
  await expect(dialog.getByRole('button', { name: 'Create Session', exact: true })).toBeVisible();

  await dialog.getByLabel('Session name (optional)', { exact: true }).fill('Docs site migration');
  await dialog.getByTestId('where-it-runs-cloud').click();
  await expect(dialog.getByRole('radio', { name: 'Pane Cloud', exact: true })).toBeChecked();
  await expect(dialog.getByText(INSPECTION, { exact: true })).toBeVisible();
  // Phone access is off in this mock: creating turns it on in place, and the card says so first (D-88).
  await expect(dialog.getByTestId('where-it-runs-phone-access')).toBeVisible();
  // Secrets sync (K1) isn't here yet, so the card makes no claim about secrets.
  await expect(dialog.getByText(SECRETS)).toHaveCount(0);
  const submit = dialog.getByRole('button', { name: 'Create Session on Pane Cloud', exact: true });
  await expect(submit).toBeEnabled();
  await dialog.screenshot({ path: screenshotPath('frame-B-built.png') });

  await submit.click();
  await expect.poll(() => page.evaluate(() => (
    // SAFETY: installElectronApiMock defines this test-only API before navigation.
    window as MockWindow
  ).__paneTestElectronMock.getPaneCloudCreates())).toEqual([
    expect.objectContaining({ name: 'Docs site migration', nameFromFirstMessage: false, agent: 'claude' }),
  ]);
  await expect(dialog).toBeHidden();
});

const cloning = (clone: Partial<PaneCloudClone>): Partial<PaneCloudSnapshot> => ({
  sessions: [{
    vmId: 'vm-new', name: 'Docs site migration', awake: true, underReview: false, machineId: 'cloud-1', paneVersion: '2.4.249', createdAt: '2026-11-22T10:00:00.000Z',
    clone: { repo: 'greenfield-inc/docs-site', state: 'cloning', phase: 'receiving', percent: 45, line: 'Receiving objects:  45% (540/1200), 2.10 MiB | 9.80 MiB/s', startedAt: '2026-11-22T10:00:01.000Z', error: null, paneId: null, ...clone },
  }],
});

async function setCloud(page: Page, parts: Partial<PaneCloudSnapshot>) {
  await page.evaluate((next) => {
    // SAFETY: installElectronApiMock defines this test-only API before navigation.
    (window as MockWindow).__paneTestElectronMock.setPaneCloud(next);
  }, parts);
}

test('D-107: Create shows the waking view at once, with the clone\'s progress, then opens the repo\'s Pane', async ({ page }) => {
  await page.setViewportSize({ width: 1200, height: 800 });
  const dialog = await openCreateSession(page);
  await dialog.getByLabel('Session name (optional)', { exact: true }).fill('Docs site migration');
  await dialog.getByTestId('where-it-runs-cloud').click();
  await dialog.getByRole('button', { name: 'Create Session on Pane Cloud', exact: true }).click();

  const waking = page.getByTestId('cloud-waking-view');
  await expect(waking).toBeVisible();
  await expect(dialog).toBeHidden();
  await expect(waking.getByTestId('cloud-waking-status')).toHaveText('Starting the machine');

  await setCloud(page, cloning({}));
  await expect(waking.getByTestId('cloud-waking-status')).toHaveText('Cloning greenfield-inc/docs-site');
  await expect(waking.getByTestId('cloud-waking-progress')).toHaveText('Receiving objects:  45% (540/1200), 2.10 MiB | 9.80 MiB/s');
  await page.screenshot({ path: screenshotPath('d107-waking-cloning.png') });
  await setCloud(page, cloning({ phase: 'checking_out', percent: 100, line: 'Updating files: 100% (214/214), done.' }));
  await expect(waking.getByTestId('cloud-waking-progress')).toHaveText('Updating files: 100% (214/214), done.');

  await setCloud(page, cloning({ state: 'ready', phase: null, line: null, paneId: 'pane-9' }));
  await expect(waking).toBeHidden();
});

test('D-107: a failed clone shows git\'s error with Retry, which runs the clone again', async ({ page }) => {
  await page.setViewportSize({ width: 1200, height: 800 });
  const dialog = await openCreateSession(page);
  await dialog.getByTestId('where-it-runs-cloud').click();
  await dialog.getByRole('button', { name: 'Create Session on Pane Cloud', exact: true }).click();
  const waking = page.getByTestId('cloud-waking-view');
  const gitError = "Cloning into 'docs-site'...\nremote: Invalid username or token. Password authentication is not supported for Git operations.\nfatal: Authentication failed for 'https://github.com/greenfield-inc/docs-site/'";
  await setCloud(page, cloning({ state: 'failed', phase: null, line: null, error: gitError }));

  await expect(waking.getByTestId('cloud-waking-error')).toHaveText(gitError);
  await page.screenshot({ path: screenshotPath('d107-waking-failed.png') });
  await waking.getByRole('button', { name: 'Retry', exact: true }).click();
  await expect.poll(() => page.evaluate(() => (
    // SAFETY: installElectronApiMock defines this test-only API before navigation.
    window as MockWindow
  ).__paneTestElectronMock.getPaneCloudCalls())).toContainEqual({ action: 'retryClone', vmId: 'vm-new' });
});

test('Pane Cloud at the awake limit says so and cannot create', async ({ page }) => {
  const dialog = await openCreateSession(page, {
    usage: { plan: 'free', planAgentHours: 300, planAwakeLimit: 5, resetsAt: '2026-12-01T00:00:00.000Z', agentHoursUsed: 12, agentHoursLimit: 300, awakeNow: 5, awakeLimit: 5, members: [] },
  });
  await dialog.getByTestId('where-it-runs-cloud').click();
  await expect(dialog.getByText('You have 5 of 5 Sessions awake. Stop one to create another.', { exact: true })).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Create Session on Pane Cloud', exact: true })).toBeDisabled();
});

const CLOUD_SESSIONS: Partial<PaneCloudSnapshot> = {
  sessions: [
    { vmId: 'vm-1', name: 'Docs site migration', awake: true, underReview: false, machineId: 'cloud-1', paneVersion: '2.4.249', createdAt: '2026-11-20T10:00:00.000Z', clone: null },
    { vmId: 'vm-2', name: 'Pricing page copy', awake: false, underReview: false, machineId: 'cloud-2', paneVersion: '2.4.249', createdAt: '2026-11-19T10:00:00.000Z', clone: null },
  ],
  usage: {
    plan: 'free', planAgentHours: 300, planAwakeLimit: 5, resetsAt: '2026-12-01T00:00:00.000Z', agentHoursUsed: 131.6, agentHoursLimit: 300, awakeNow: 1, awakeLimit: 5,
    members: [{ accountId: 'acct-1', name: 'Maya', you: true, agentHours: 131.6, awakeNow: 1, awakeLimit: 5 }],
  },
};

test('cloud Sessions sit in the Sessions list like any other, with Stop and Start', async ({ page }) => {
  await installSessionsFixture(page, [sessionFixture('local-1', 'Checkout redesign', 'Redesign the checkout', '', '2026-11-20T09:00:00.000Z')], [], {
    initialConfig: { appearanceMode: 'fixed', theme: 'dark' },
    machineConnections: {
      machines: [
        { id: 'local', label: 'This computer', kind: 'local', status: 'online', offlineSince: null },
        { id: 'cloud-1', label: 'Docs site migration', kind: 'remote', status: 'online', offlineSince: null },
      ],
      reads: {
        'cloud-1': {
          'orchestration-sessions:list': { success: true, data: { sessions: [{ id: 'legacy-pane-chat', name: 'Onboarding', archived: false }, { id: 'c-1', name: 'Docs site migration', archived: false }] } },
          'orchestration-sessions:activity-list': { success: true, data: [{ sessionId: 'c-1', state: 'working', workingPanes: 2 }] },
        },
      },
    },
  });
  await page.addInitScript((parts) => {
    // SAFETY: installElectronApiMock's init script, registered first, defines this test-only API.
    (window as MockWindow).__paneTestElectronMock.setPaneCloud(parts);
  }, CLOUD_SESSIONS);
  await gotoApp(page);
  await dismissStartupDialogs(page);

  const list = page.locator('#orchestration-sessions-list');
  const working = list.getByRole('button', { name: 'Open Session Docs site migration', exact: true });
  await expect(working).toBeVisible();
  await expect(working.getByTestId('session-activity-icon')).toHaveAttribute('data-state', 'working');
  await expect(working).toContainText('2 working');
  const stopped = list.getByRole('button', { name: 'Open Session Pricing page copy', exact: true });
  await expect(stopped).toBeVisible();
  await page.getByTestId('sidebar').first().screenshot({ path: screenshotPath('frame-C-built.png') });

  // The VM's own Onboarding Session is not one the person made, so it gets no row.
  await expect(list.getByRole('button', { name: 'Open Session Onboarding', exact: true })).toHaveCount(0);
  await working.click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Delete…', exact: true }).click();
  const confirm = page.getByRole('dialog', { name: 'Delete Docs site migration?' });
  await expect(confirm).toContainText('every Session on it');
  await confirm.getByRole('button', { name: 'Cancel', exact: true }).click();

  await working.click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Stop', exact: true }).click();
  await stopped.click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Start', exact: true }).click();
  await expect.poll(() => page.evaluate(() => (
    // SAFETY: installElectronApiMock defines this test-only API before navigation.
    window as MockWindow
  ).__paneTestElectronMock.getPaneCloudCalls())).toEqual([{ action: 'stop', vmId: 'vm-1' }, { action: 'start', vmId: 'vm-2' }]);
});

test('Usage & Limits shows Pane Cloud hours as a plain number of the plan, with no Upgrade', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await installSessionsFixture(page, [], [], { initialConfig: { appearanceMode: 'fixed', theme: 'dark' } });
  await page.addInitScript((parts) => {
    // SAFETY: installElectronApiMock's init script, registered first, defines this test-only API.
    (window as MockWindow).__paneTestElectronMock.setPaneCloud(parts);
  }, CLOUD_SESSIONS);
  await gotoApp(page);
  await dismissStartupDialogs(page);
  await page.getByRole('button', { name: 'Settings' }).first().click();
  await page.getByRole('navigation', { name: 'Settings categories' }).getByRole('button', { name: 'Usage & Limits', exact: true }).click();

  const cloud = page.getByTestId('pane-cloud-usage');
  await expect(cloud.getByText('Free · 300 agent-hours a month, 5 Sessions awake at once.', { exact: true })).toBeVisible();
  await expect(cloud.getByText('131 of 300', { exact: true })).toBeVisible();
  await expect(cloud.getByText('The month starts again on December 1.', { exact: true })).toBeVisible();
  await expect(cloud.getByText('1 of 5', { exact: true })).toBeVisible();
  await expect(cloud.getByText('An hour in a Session running at 16 GB counts as 2 hours.', { exact: true })).toBeVisible();
  await expect(cloud.getByRole('button', { name: /upgrade/i })).toHaveCount(0);
  await cloud.screenshot({ path: screenshotPath('frame-P-built.png') });
});

test('the Pane Cloud card says secrets come along once secrets sync is there', async ({ page }) => {
  const dialog = await openCreateSession(page, { sendsSecrets: true });
  await dialog.getByTestId('where-it-runs-cloud').click();
  await expect(dialog.getByText(SECRETS)).toBeVisible();
});

test('a cloud row shows its approvals count, as any Session row does', async ({ page }) => {
  const now = Date.now();
  await installSessionsFixture(page, [], [], {
    initialConfig: { appearanceMode: 'fixed', theme: 'dark' },
    notifySnapshot: {
      ...notifyFixture(now),
      items: [{ id: 'q-1', ui: 'approve', title: 'Push the docs branch?', machineId: 'cloud-1', source: { name: 'docs', agent: 'Claude', session: { id: 'c-1', name: 'Docs site migration' } }, state: 'waiting', createdAt: now - 60_000 }],
      queue: ['q-1'],
      strip: null,
    },
    machineConnections: {
      machines: [
        { id: 'local', label: 'This computer', kind: 'local', status: 'online', offlineSince: null },
        { id: 'cloud-1', label: 'Docs site migration', kind: 'remote', status: 'online', offlineSince: null },
      ],
      reads: { 'cloud-1': { 'orchestration-sessions:list': { success: true, data: { sessions: [{ id: 'c-1', name: 'Docs site migration', archived: false }] } } } },
    },
  });
  await page.addInitScript((parts) => {
    // SAFETY: installElectronApiMock's init script, registered first, defines this test-only API.
    (window as MockWindow).__paneTestElectronMock.setPaneCloud(parts);
  }, CLOUD_SESSIONS);
  await gotoApp(page);
  await dismissStartupDialogs(page);

  const row = page.locator('#orchestration-sessions-list').getByRole('button', { name: 'Open Session Docs site migration', exact: true });
  await expect(row.getByTestId('session-approvals-count')).toHaveText('1');
});

test('on a cloud Session, this computer\'s Sessions keep their menu, and the list shows that machine\'s Pane Chat as any machine\'s would', async ({ page }) => {
  const remoteDaemon = {
    host: { config: { enabled: false, listenHost: '127.0.0.1', listenPort: 42137, pairingRequired: true, allowInsecureHttpOnLoopback: true }, clients: [] },
    client: {
      mode: 'remote', activeProfileId: 'cloud-1',
      profiles: [{ id: 'cloud-1', label: 'Docs site migration', baseUrl: 'https://cloud-1.example:8443', token: 'paired', transport: 'http+sse' }],
      computers: [{ id: 'cloud-1', label: 'Docs site migration', routes: [{ id: 'public:https://cloud-1.example:8443', kind: 'public', source: 'manual', baseUrl: 'https://cloud-1.example:8443', token: 'paired' }] }],
    },
  };
  await installSessionsFixture(page, [sessionFixture('legacy-pane-chat', 'Onboarding', 'The cloud machine\'s own Pane Chat', '', '2026-11-20T09:00:00.000Z'), sessionFixture('c-1', 'Docs site migration', 'Move the docs', '', '2026-11-20T10:00:00.000Z')], [], {
    initialConfig: { appearanceMode: 'fixed', theme: 'dark', remoteDaemon },
    remoteConnection: { mode: 'remote', status: 'connected', activeProfileId: 'cloud-1', activeProfileLabel: 'Docs site migration', activeBaseUrl: 'https://cloud-1.example:8443' },
    machineConnections: {
      machines: [
        { id: 'local', label: 'This computer', kind: 'local', status: 'online', offlineSince: null },
        { id: 'cloud-1', label: 'Docs site migration', kind: 'remote', status: 'online', offlineSince: null },
      ],
      reads: {
        local: {
          'orchestration-sessions:list': { success: true, data: { sessions: [
            { id: 'legacy-pane-chat', name: 'Pane Chat', archived: false },
            { id: 'checkout', name: 'Checkout redesign', archived: false },
            { id: 'todo-7', name: 'T-7 Fix the footer', archived: false, todoNumber: 7 },
          ] } },
        },
      },
    },
  });
  await page.addInitScript((parts) => {
    // SAFETY: installElectronApiMock's init script, registered first, defines this test-only API.
    (window as MockWindow).__paneTestElectronMock.setPaneCloud(parts);
  }, CLOUD_SESSIONS);
  await gotoApp(page);
  await dismissStartupDialogs(page);

  // The machine pill names the cloud machine by its Session, not its computer name (D-90).
  await expect(page.locator('[data-sidebar-key="machine-switcher"]')).toContainText('Docs site migration');
  const list = page.locator('#orchestration-sessions-list');
  const local = list.getByRole('button', { name: 'Open Session Checkout redesign', exact: true });
  await expect(local).toBeVisible();
  await expect(list.getByRole('button', { name: 'Open Session T-7 Fix the footer', exact: true })).toHaveCount(0);
  // The window's machine shows its own Pane Chat, as a paired machine's window does (D-88); this computer's stays in its own window.
  await expect(list.getByText('Onboarding', { exact: true })).toBeVisible();
  await expect(list.getByRole('button', { name: 'Open Session Pane Chat', exact: true })).toHaveCount(0);

  await local.click({ button: 'right' });
  await expect(page.getByRole('menuitem', { name: 'Rename…', exact: true })).toBeVisible();
  await page.getByRole('menuitem', { name: 'Archive Session', exact: true }).click();
  await expect.poll(() => page.evaluate(() => (
    // SAFETY: installElectronApiMock defines this test-only API before navigation.
    window as MockWindow
  ).__paneTestElectronMock.getMachineRuns())).toContainEqual({ machineId: 'local', command: { type: 'archive', target: { kind: 'session', id: 'checkout' } } });
});

/** Opens Create Session from a project's page, on a Windows PC with one Mac online. */
async function openCreateSessionForRepo(page: Page, projectFiles: string[], machines: Array<{ id: string; label: string; os?: string }>) {
  await installSessionsFixture(page, [], [], { initialConfig: { appearanceMode: 'fixed', theme: 'dark' }, projectFiles });
  await page.addInitScript((list) => {
    // SAFETY: installElectronApiMock's init script, registered first, defines this test-only API.
    const mock = (window as MockWindow).__paneTestElectronMock;
    mock.setPaneCloud({});
    mock.emitMachineEvent({ type: 'machines', machines: [
      { id: 'local', label: 'This computer', kind: 'local', status: 'online', offlineSince: null },
      ...list.map((machine) => ({ id: machine.id, label: machine.label, kind: 'remote' as const, status: 'online' as const, offlineSince: null })),
    ] });
  }, machines);
  await gotoApp(page);
  await dismissStartupDialogs(page);
  // Open the project's page, so the dialog reads that repo.
  await page.getByRole('button', { name: 'Project actions for Pane fixtures', exact: true }).click();
  await page.getByText('Open session on main', { exact: true }).click();
  await page.getByTestId('new-orchestration-session').click();
  const dialog = page.getByRole('dialog', { name: 'Create Session', exact: true });
  await expect(dialog).toBeVisible();
  return dialog;
}

test('the Pane Cloud card always says iOS Simulator work needs a Mac', async ({ page }) => {
  await page.setViewportSize({ width: 1200, height: 1100 });
  const dialog = await openCreateSession(page);
  await expect(dialog.getByTestId('where-it-runs-mac-work')).toHaveText('iOS Simulator work needs a Mac.');
  await dialog.screenshot({ path: screenshotPath('frame-B-mac-line.png') });
});

test('journey 25: for a repo with an Xcode project with no Mac online, the Mac line links to the docs before anything is created', async ({ page }) => {
  const dialog = await openCreateSessionForRepo(page, ['ios/App.xcodeproj'], []);
  const placesList = dialog.getByTestId('where-it-runs-cloud');
  await expect(placesList.getByRole('button', { name: 'Run it on a Mac', exact: true })).toBeVisible();
  await expect(placesList).toContainText('This repo has an Xcode project, and none of your Macs is online.');
  await placesList.screenshot({ path: screenshotPath('frame-B-xcode-no-mac.png') });
});

/** A saved computer that is a cloud Session's VM, under the label its pairing gave it. */
const cloudComputer = (id: string): RemoteComputer => ({
  id, label: id, os: 'Linux',
  routes: [{ id: `relay:https://${id}.runpane.net`, kind: 'relay', source: 'link', baseUrl: `https://${id}.runpane.net`, token: 'synthetic', relay: { computerId: `relay-${id}`, fingerprint: 'f' } }],
});

/** Two paired cloud Sessions (CLOUD_SESSIONS) whose VMs are the saved computers cloud-1 and cloud-2. */
async function openWithCloudMachines(page: Page) {
  await installElectronApiMock(page, {
    initialConfig: { appearanceMode: 'fixed', theme: 'dark' },
    computers: [cloudComputer('cloud-1'), cloudComputer('cloud-2')],
    tailnetMachines: { ok: false, reason: 'Tailscale is signed out', fix: 'Sign in to Tailscale.' },
    machineConnections: {
      machines: [
        { id: 'local', label: 'This computer', kind: 'local', status: 'online', offlineSince: null },
        { id: 'cloud-1', label: 'cloud-1', kind: 'remote', status: 'online', offlineSince: null, routeId: 'relay:https://cloud-1.runpane.net' },
        { id: 'cloud-2', label: 'cloud-2', kind: 'remote', status: 'offline', offlineSince: '2026-11-21T09:00:00.000Z' },
      ],
      reads: {},
    },
  });
  await page.addInitScript((parts) => {
    // SAFETY: installElectronApiMock's init script, registered first, defines this test-only API.
    const mock = (window as MockWindow).__paneTestElectronMock;
    mock.setPaneCloud(parts);
    mock.setPaneCloudActions('vm-1', [{ id: 'a-1', operation: 'update_pane', actor: 'you', reason: 'Update Pane from the machine page', failed: false, error: null, requestedAt: '2026-11-21T12:00:00.000Z' }]);
    mock.setPaneCloudActions('vm-2', [{ id: 'a-1', operation: 'stop', actor: 'Pane Cloud', reason: 'Idle for 30 minutes', failed: false, error: null, requestedAt: '2026-11-21T08:00:00.000Z' }]);
  }, CLOUD_SESSIONS);
  await gotoApp(page);
}

test('D-90: the machine switcher shows cloud Sessions as one Pane Cloud machine with its Sessions under it', async ({ page }) => {
  await openWithCloudMachines(page);
  await page.getByRole('button', { name: 'Agents run on devbox. Switch machine', exact: true }).click();
  const menu = page.getByRole('menu', { name: 'Agents run on' });
  const header = menu.getByRole('menuitemradio', { name: /^Pane Cloud/ });
  await expect(header).toHaveCount(1);
  await expect(header).toContainText('2 Sessions');
  await expect(header).toBeDisabled();
  await expect(menu.getByRole('menuitemradio', { name: /Docs site migration/ })).toHaveCount(1);
  await expect(menu.getByRole('menuitemradio', { name: /Pricing page copy/ })).toHaveCount(1);
  await expect(menu.getByRole('menuitemradio', { name: /cloud-1|cloud-2/ })).toHaveCount(0);
  await menu.screenshot({ path: screenshotPath('d90-switcher.png') });
});

test('D-90: Your computers lists one Pane Cloud group, and its Details opens the Pane Cloud page', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 1000 });
  await openWithCloudMachines(page);
  await page.getByRole('button', { name: 'Settings' }).first().click();
  await page.getByRole('button', { name: 'Remote Access', exact: true }).click();
  await expect(page.getByRole('tab', { name: 'Computers · 2' })).toBeVisible();

  const group = page.getByTestId('machine-group-pane-cloud');
  await expect(group).toHaveCount(1);
  await expect(group).toContainText('2 Sessions');
  await expect(group.getByTestId('machine-Docs site migration')).toBeVisible();
  await expect(group.getByTestId('machine-Pricing page copy')).toBeVisible();
  await expect(page.getByTestId('machine-cloud-1')).toHaveCount(0);
  await page.locator('[data-setting-id="remote-machines"]').screenshot({ path: screenshotPath('d90-your-computers.png') });

  await group.getByRole('button', { name: 'Pane Cloud details', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Pane Cloud', exact: true })).toBeVisible();
  const sessions = page.getByRole('list', { name: 'Sessions' });
  await expect(sessions.getByRole('listitem')).toHaveText([/Docs site migration.*Running/, /Pricing page copy.*Stopped/]);
  const actions = page.getByRole('list', { name: 'Recent actions' }).getByRole('listitem');
  await expect(actions).toHaveCount(2);
  await expect(actions.first()).toContainText('Updated Pane · Docs site migration');
  await expect(actions.nth(1)).toContainText('Stopped · Pricing page copy');
  await page.screenshot({ path: screenshotPath('d90-page.png'), fullPage: true });

  // Only the running Session can take an update.
  await page.getByRole('button', { name: 'Update Pane', exact: true }).click();
  await expect.poll(() => page.evaluate(() => (
    // SAFETY: installElectronApiMock defines this test-only API before navigation.
    window as MockWindow
  ).__paneTestElectronMock.getPaneCloudCalls())).toEqual([{ action: 'updatePane', vmId: 'vm-1' }]);
});

test('Archive Session on a cloud row reports what happened where it was clicked', async ({ page }) => {
  await installSessionsFixture(page, [], [], {
    initialConfig: { appearanceMode: 'fixed', theme: 'dark' },
    machineConnections: {
      machines: [
        { id: 'local', label: 'This computer', kind: 'local', status: 'online', offlineSince: null },
        { id: 'cloud-1', label: 'Docs site migration', kind: 'remote', status: 'online', offlineSince: null },
      ],
      reads: { 'cloud-1': { 'orchestration-sessions:list': { success: true, data: { sessions: [{ id: 'c-1', name: 'Docs site migration', archived: false }] } } } },
    },
  });
  await page.addInitScript((parts) => {
    // SAFETY: installElectronApiMock's init script, registered first, defines this test-only API.
    (window as MockWindow).__paneTestElectronMock.setPaneCloud(parts);
  }, {
    ...CLOUD_SESSIONS,
    // What main answers when the unlink couldn't reach one of the person's computers.
    error: { message: 'Archived. Pane could not reach Travel Laptop, so it still lists this cloud machine.', next: 'Open Pane on Travel Laptop to remove it there.' },
  });
  await gotoApp(page);
  await dismissStartupDialogs(page);

  const row = page.locator('#orchestration-sessions-list').getByRole('button', { name: 'Open Session Docs site migration', exact: true });
  await row.click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Archive Session', exact: true }).click();

  await expect(page.getByText(/Pane could not reach Travel Laptop/).first()).toBeVisible();
  await expect.poll(() => page.evaluate(() => (
    // SAFETY: installElectronApiMock defines this test-only API before navigation.
    window as MockWindow
  ).__paneTestElectronMock.getPaneCloudCalls())).toContainEqual({ action: 'archive', vmId: 'vm-1' });
});

// D-102: the Pane Cloud card shows to everyone; without an invite it offers the waitlist, and Create stays off.
const WAITLIST_URL = 'https://runpane.com/cloud?from=pane-app';

async function openCloudCard(page: Page, cloud: Partial<PaneCloudSnapshot>) {
  await page.setViewportSize({ width: 1200, height: 1100 });
  const dialog = await openCreateSession(page, cloud);
  await dialog.getByTestId('where-it-runs-cloud').click();
  return dialog;
}

test('D-102: not signed in, the Pane Cloud card is invite-only with the waitlist and Sign in', async ({ page }) => {
  const dialog = await openCloudCard(page, { signIn: { state: 'signed-out' }, usage: null });
  const card = dialog.getByTestId('where-it-runs-cloud');
  await expect(card).toContainText('Pane Cloud is invite-only for now. Join the waitlist, or sign in if you have an invite.');
  await expect(card.getByRole('button', { name: 'Sign in', exact: true })).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Create Session on Pane Cloud', exact: true })).toBeDisabled();
  await card.screenshot({ path: screenshotPath('d102-signed-out.png') });
  await card.getByRole('button', { name: 'Join the waitlist', exact: true }).click();
  await expect.poll(() => page.evaluate(() => (
    // SAFETY: installElectronApiMock defines this test-only API before navigation.
    window as MockWindow
  ).__paneTestElectronMock.getOpenedExternalUrls())).toContain(WAITLIST_URL);
});

test('D-102: a signed-in account on the waitlist sees the waitlist state, not an error', async ({ page }) => {
  const dialog = await openCloudCard(page, {
    signIn: { state: 'signed-in', email: 'sam@example.com', name: 'Sam', access: 'waitlisted', signupState: 'ready', signupUrl: 'https://cloud.example.test/signup', organizationId: 'org-1' },
  });
  const card = dialog.getByTestId('where-it-runs-cloud');
  await expect(card).toContainText("You're on the waitlist. Pane Cloud is invite-only for now; your invite arrives by email.");
  await expect(card.getByRole('alert')).toHaveCount(0);
  await expect(dialog.getByRole('button', { name: 'Create Session on Pane Cloud', exact: true })).toBeDisabled();
  await card.screenshot({ path: screenshotPath('d102-waitlisted.png') });
});

test('D-102: when Pane Cloud can\'t be reached, the card says so and still offers the waitlist', async ({ page }) => {
  const dialog = await openCloudCard(page, {
    signIn: { state: 'signed-out' },
    usage: null,
    error: { message: 'Pane could not reach Pane Cloud (fetch failed).', next: 'Check your connection and try again.', code: 'ERR_PANE_CLOUD_UNREACHABLE' },
  });
  const card = dialog.getByTestId('where-it-runs-cloud');
  await expect(card).toContainText("Pane can't reach Pane Cloud right now, so you can't sign in.");
  await expect(card.getByRole('button', { name: 'Join the waitlist', exact: true })).toBeVisible();
  await expect(card.getByRole('button', { name: 'Sign in', exact: true })).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Create Session on Pane Cloud', exact: true })).toBeDisabled();
  await card.screenshot({ path: screenshotPath('d102-unreachable.png') });
});
