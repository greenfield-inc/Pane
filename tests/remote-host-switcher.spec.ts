import { expect, test, type Page } from '@playwright/test';
import { installElectronApiMock } from './electronApiMock';
import type { TailnetMachineList } from '../shared/types/workspaceAccess';

async function saveHost(page: Page, connect: boolean) {
  await page.evaluate(async (connect) => {
    await window.electronAPI.remoteDaemon.upsertConnectionProfile({
      id: 'mac', label: 'parsas mac pro', baseUrl: 'https://parsas-macbook-pro.example.ts.net',
      token: 'synthetic', transport: 'http+sse',
    });
    if (connect) {
      await window.electronAPI.remoteDaemon.updateClientState({ mode: 'remote', activeProfileId: 'mac' });
    }
  }, connect);
}

test('the header pill names the connected machine and switches back to this computer', async ({ page }, testInfo) => {
  await installElectronApiMock(page);
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Collapse sidebar', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: /Switch machine$/ })).toHaveCount(0);

  await saveHost(page, true);
  const pill = page.getByRole('button', { name: 'Agents run on parsas mac pro. Switch machine' });
  await expect(pill).toBeVisible();
  await pill.click();
  await expect(page.getByRole('menuitemradio', { name: /parsas mac pro/ })).toHaveAttribute('aria-checked', 'true');
  await expect(page.getByRole('menuitemradio', { name: /devbox/ })).toContainText('Linux · This computer');
  await page.screenshot({ path: testInfo.outputPath('pill-open.png') });

  await page.getByRole('menuitemradio', { name: /devbox/ }).click();
  await expect(page.getByRole('button', { name: 'Agents run on devbox. Switch machine' })).toBeVisible();
});

test('the collapsed rail shows the active machine and opens the same menu', async ({ page }, testInfo) => {
  await installElectronApiMock(page);
  await page.goto('/');
  await page.getByRole('button', { name: 'Collapse sidebar', exact: true }).click();

  await saveHost(page, true);
  await page.getByRole('button', { name: 'Agents run on parsas mac pro. Switch machine', exact: true }).click();
  await expect(page.getByRole('menuitemradio', { name: /parsas mac pro/ })).toHaveAttribute('aria-checked', 'true');
  await page.screenshot({ path: testInfo.outputPath('rail-open.png') });

  await page.getByRole('button', { name: 'Add a machine…' }).click();
  await expect(page.getByRole('heading', { name: 'Remote Access', exact: true })).toBeVisible();
  await expect(page.getByLabel('Connection Code')).toBeVisible();
});

const tailnetMachines: TailnetMachineList = {
  ok: true,
  tailnet: 'demo.github',
  domain: 'tail1234.ts.net',
  machines: [
    { name: 'office-pc', dnsName: 'office-pc.tail1234.ts.net', url: 'https://office-pc.tail1234.ts.net:8443', os: 'Windows', ownerLogin: 'demo@github', mine: true, state: 'available' },
    { name: 'build-box', dnsName: 'build-box.tail1234.ts.net', url: 'https://build-box.tail1234.ts.net:8443', os: 'Linux', ownerLogin: 'demo@github', mine: true, state: 'password-required' },
    { name: 'travel-laptop', dnsName: 'travel-laptop.tail1234.ts.net', url: 'https://travel-laptop.tail1234.ts.net:8443', os: 'macOS', ownerLogin: 'demo@github', mine: true, state: 'offline' },
  ],
};

test('the menu lists Tailscale machines never connected and connects one in one click', async ({ page }) => {
  await installElectronApiMock(page, { tailnetMachines });
  await page.goto('/');
  await page.getByRole('button', { name: 'Agents run on devbox. Switch machine' }).click();
  await expect(page.getByRole('menuitemradio', { name: /office-pc/ })).toContainText('Windows · Ready · Never connected');
  await expect(page.getByRole('menuitemradio', { name: /travel-laptop/ })).toBeDisabled();

  await page.getByRole('menuitemradio', { name: /office-pc/ }).click();
  await expect(page.getByRole('button', { name: 'Agents run on office-pc. Switch machine' })).toBeVisible();
  await page.getByRole('button', { name: 'Agents run on office-pc. Switch machine' }).click();
  await expect(page.getByRole('menuitemradio', { name: /office-pc/ })).toContainText('Windows · Agents run here');
});

test('a machine that needs a password opens its password field in Remote Access', async ({ page }) => {
  await installElectronApiMock(page, { tailnetMachines });
  await page.goto('/');
  await page.getByRole('button', { name: 'Agents run on devbox. Switch machine' }).click();
  await page.getByRole('menuitemradio', { name: /build-box/ }).click();

  const field = page.getByLabel('Password for build-box');
  await expect(field).toBeFocused();
  // Focus stays in the field after Settings settles, so typing right away lands there.
  await page.waitForTimeout(400);
  await page.keyboard.type('correct horse');
  await expect(field).toHaveValue('correct horse');
  await page.getByTestId('machine-build-box').getByRole('button', { name: 'Connect' }).click();
  await expect(page.getByTestId('active-machine')).toContainText('Linux · Agents run here');
});

test('the active machine asks for a new password from the menu', async ({ page }) => {
  await installElectronApiMock(page, { tailnetMachines, remoteConnectError: 'build-box refused the password.' });
  await page.goto('/');
  await page.getByRole('button', { name: 'Agents run on devbox. Switch machine' }).click();
  await page.getByRole('menuitemradio', { name: /build-box/ }).click();
  await page.getByLabel('Password for build-box').fill('wrong horse');
  await page.getByTestId('machine-build-box').getByRole('button', { name: 'Connect' }).click();
  const active = page.getByTestId('active-machine');
  await expect(active).toContainText('Linux · Needs password');

  await page.getByRole('button', { name: 'Back', exact: true }).first().click();
  await page.getByRole('button', { name: 'Agents run on build-box. Switch machine' }).click();
  await page.getByRole('menuitemradio', { name: /build-box/ }).click();
  const field = active.getByLabel('Password for build-box');
  await expect(field).toBeFocused();
  await page.waitForTimeout(400);
  await expect(field).toBeFocused();
});


const repositories = [
  {
    id: 1,
    name: 'Mock Repo',
    path: '/tmp/repo',
    active: true,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
  },
];

function pane(id: string, name: string) {
  return {
    id,
    name,
    projectId: 1,
    worktreePath: `/tmp/${id}`,
    prompt: '',
    status: 'stopped',
    createdAt: '2026-01-01T00:00:00.000Z',
    lastActivity: '2026-01-01T00:00:00.000Z',
    output: [],
    jsonMessages: [],
    permissionMode: 'ignore',
    toolType: 'none',
    archived: false,
    isHidden: false,
    isFavorite: false,
  };
}

interface NavigationMemoryMock {
  setSessions: (sessions: ReturnType<typeof pane>[]) => void;
  emitRemoteDaemonResyncRequested: (event: { hostChanged: boolean }) => void;
  getNavigationMemory: (hostId: string | null) => { paneId: string | null } | null;
}

function navigationMemoryMock(page: Page) {
  return {
    /** The debounced write is what a later switch reads back; wait for it to land. */
    expectRemembered: (hostId: string | null, paneId: string | null) => expect.poll(() => page.evaluate(
      // SAFETY: installElectronApiMock defines this control before the app loads.
      ([id]) => ((window as typeof window & { __paneTestElectronMock: NavigationMemoryMock })
        .__paneTestElectronMock.getNavigationMemory(id as string | null))?.paneId ?? null,
      [hostId],
    )).toBe(paneId),
    /** Stands in for main: the host's own Panes land, then the renderer reconciles. */
    arriveOnHost: (panes: ReturnType<typeof pane>[]) => page.evaluate((hostPanes) => {
      // SAFETY: installElectronApiMock defines these controls before the app loads.
      const mock = (window as typeof window & { __paneTestElectronMock: NavigationMemoryMock }).__paneTestElectronMock;
      mock.setSessions(hostPanes);
      mock.emitRemoteDaemonResyncRequested({ hostChanged: true });
    }, panes),
  };
}

/** Clicks the sidebar row for a Pane; its row actions share the Pane's name. */
function openPane(page: Page, name: string) {
  return page.getByRole('button', { name, exact: true }).click();
}

/** Switches through the real menu and waits for the pill to name the new machine. */
async function pickHost(page: Page, label: 'parsas mac pro' | 'devbox') {
  await page.getByRole('button', { name: /Switch machine$/ }).click();
  await page.getByRole('menuitemradio', { name: new RegExp(label) }).click();
  await expect(page.getByRole('button', { name: `Agents run on ${label}. Switch machine` })).toBeVisible();
}

test('switching hosts returns to the Pane that was open on each of them', async ({ page }) => {
  const localPane = pane('local-work', 'Local work');
  const remotePane = pane('remote-work', 'Remote work');
  await installElectronApiMock(page, {
    initialProjects: repositories,
    initialSessions: [localPane],
    initialUiState: { expandedProjects: [1] },
  });
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  const memory = navigationMemoryMock(page);
  await saveHost(page, false);

  await openPane(page, 'Local work');
  await expect(page).toHaveTitle('Mock Repo · Local work');
  await memory.expectRemembered(null, 'local-work');

  // A first visit to the remote host has nothing remembered, so #872's clearing
  // stands: this computer's Pane must not stay on screen.
  await pickHost(page, 'parsas mac pro');
  await memory.arriveOnHost([remotePane]);
  await expect(page).toHaveTitle('Pane');

  await openPane(page, 'Remote work');
  await expect(page).toHaveTitle('Mock Repo · Remote work');
  await memory.expectRemembered('mac', 'remote-work');

  await pickHost(page, 'devbox');
  await memory.arriveOnHost([localPane]);
  await expect(page).toHaveTitle('Mock Repo · Local work');

  await pickHost(page, 'parsas mac pro');
  await memory.arriveOnHost([remotePane]);
  await expect(page).toHaveTitle('Mock Repo · Remote work');
});

test('a remembered Pane that is gone from the host falls back to the home view', async ({ page }) => {
  const localPane = pane('local-work', 'Local work');
  const remotePane = pane('remote-work', 'Remote work');
  await installElectronApiMock(page, {
    initialProjects: repositories,
    initialSessions: [localPane],
    initialUiState: { expandedProjects: [1] },
  });
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  const memory = navigationMemoryMock(page);
  await saveHost(page, false);

  await pickHost(page, 'parsas mac pro');
  await memory.arriveOnHost([remotePane]);
  await openPane(page, 'Remote work');
  await expect(page).toHaveTitle('Mock Repo · Remote work');
  await memory.expectRemembered('mac', 'remote-work');

  await pickHost(page, 'devbox');
  await memory.arriveOnHost([localPane]);
  await expect(page).toHaveTitle('Pane');

  // The remembered Pane was archived on the remote host while we were away.
  await pickHost(page, 'parsas mac pro');
  await memory.arriveOnHost([pane('other-work', 'Other work')]);
  await expect(page).toHaveTitle('Pane');
  await expect(page.getByRole('button', { name: 'Other work', exact: true })).toBeVisible();
  // The dead Pane is retired rather than retried on every future switch.
  await memory.expectRemembered('mac', null);
});
