import { expect, test, type Page } from '@playwright/test';
import { installElectronApiMock } from './electronApiMock';

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

test('the header chip names the connected host and switches back to this computer', async ({ page }, testInfo) => {
  await installElectronApiMock(page);
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Collapse sidebar', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: /Switch host$/ })).toHaveCount(0);

  await saveHost(page, true);
  const chip = page.getByRole('button', { name: 'Agents run on parsas mac pro. Switch host' });
  await expect(chip).toBeVisible();
  await chip.click();
  await expect(page.getByRole('menuitemradio', { name: /parsas mac pro/ })).toHaveAttribute('aria-checked', 'true');
  await page.screenshot({ path: testInfo.outputPath('chip-open.png') });

  await page.getByRole('menuitemradio', { name: /This computer/ }).click();
  await expect(page.getByRole('button', { name: 'Agents run on This computer. Switch host' })).toBeVisible();
});

test('the collapsed rail dot opens the switcher once a host is saved', async ({ page }, testInfo) => {
  await installElectronApiMock(page);
  await page.goto('/');
  await page.getByRole('button', { name: 'Collapse sidebar', exact: true }).click();

  await saveHost(page, true);
  await page.getByRole('button', { name: 'Connected to remote runtime', exact: true }).click();
  await expect(page.getByRole('menuitemradio', { name: /parsas mac pro/ })).toHaveAttribute('aria-checked', 'true');
  await page.screenshot({ path: testInfo.outputPath('rail-open.png') });

  await page.getByRole('button', { name: 'Manage connections…' }).click();
  await expect(page.getByRole('heading', { name: 'Remote Access', exact: true })).toBeVisible();
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

/** Switches through the real dropdown and waits for the chip to name the new host. */
async function pickHost(page: Page, label: 'parsas mac pro' | 'This computer') {
  await page.getByRole('button', { name: /Switch host$/ }).click();
  await page.getByRole('menuitemradio', { name: new RegExp(label) }).click();
  await expect(page.getByRole('button', { name: `Agents run on ${label}. Switch host` })).toBeVisible();
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

  await pickHost(page, 'This computer');
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

  await pickHost(page, 'This computer');
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
