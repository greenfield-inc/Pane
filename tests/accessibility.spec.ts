import { expect, test, type Page } from '@playwright/test';
import { expectNoAxeViolations } from './axeTest';
import { installElectronApiMock } from './electronApiMock';
import type { JsonValue } from '../shared/validation/boundaryDecoder';

const project = {
  id: 1,
  name: 'Accessibility fixture',
  path: '/tmp/accessibility-fixture',
  active: true,
  created_at: new Date(0).toISOString(),
  updated_at: new Date(0).toISOString(),
};

const session = {
  id: 'accessibility-session',
  name: 'Accessibility pane',
  worktreePath: '/tmp/accessibility-fixture/accessibility-pane',
  prompt: 'Verify the accessible UI',
  status: 'stopped',
  createdAt: new Date(0).toISOString(),
  lastActivity: new Date(0).toISOString(),
  output: [],
  jsonMessages: [],
  isRunning: false,
  permissionMode: 'ignore',
  projectId: project.id,
  displayOrder: 0,
  isFavorite: false,
  toolType: 'none',
  archived: false,
};

const panels = [
  {
    id: 'accessibility-terminal',
    sessionId: session.id,
    type: 'terminal',
    title: 'Terminal',
    state: { isActive: true, hasBeenViewed: true, customState: { isInitialized: false } },
    metadata: {
      createdAt: new Date(0).toISOString(),
      lastActiveAt: new Date(0).toISOString(),
      position: 0,
      permanent: true,
    },
  },
  {
    id: 'accessibility-explorer',
    sessionId: session.id,
    type: 'explorer',
    title: 'Explorer',
    state: { isActive: false, hasBeenViewed: true },
    metadata: {
      createdAt: new Date(0).toISOString(),
      lastActiveAt: new Date(0).toISOString(),
      position: 1,
    },
  },
  {
    id: 'accessibility-dashboard',
    sessionId: session.id,
    type: 'dashboard',
    title: 'Dashboard',
    state: { isActive: false, hasBeenViewed: true },
    metadata: {
      createdAt: new Date(0).toISOString(),
      lastActiveAt: new Date(0).toISOString(),
      position: 2,
    },
  },
  {
    id: 'accessibility-logs',
    sessionId: session.id,
    type: 'logs',
    title: 'Logs',
    state: { isActive: false, hasBeenViewed: true },
    metadata: {
      createdAt: new Date(0).toISOString(),
      lastActiveAt: new Date(0).toISOString(),
      position: 9,
    },
  },
];

const remoteSession = {
  ...session,
  id: 'remote-accessibility-session',
  name: 'Remote accessibility pane',
  worktreePath: '/tmp/remote-accessibility-fixture/remote-accessibility-pane',
  projectId: 2,
};

const remoteProject = {
  ...project,
  id: 2,
  name: 'Remote accessibility fixture',
  path: '/tmp/remote-accessibility-fixture',
  sessions: [remoteSession],
};

const remotePanels = [{
  ...panels[1],
  id: 'remote-accessibility-explorer',
  sessionId: remoteSession.id,
}];

const remoteAffordances = {
  terminalShortcuts: [],
  customCommands: [],
  voiceTranscription: {
    availableModes: [],
    defaultMode: 'streaming',
    configured: {
      cleanup: false,
      recorded: false,
      streaming: false,
      fal: false,
      deepgram: false,
      openRouter: false,
    },
    modes: {
      streaming: {
        label: 'Live',
        priceLabel: '~$0.462/hr ASR + cleanup',
        latencyLabel: 'Realtime text while speaking',
        recommended: true,
      },
      recorded: {
        label: 'Batch',
        priceLabel: '~$0.084/hr full pipeline',
        latencyLabel: 'Text appears after stop',
        recommended: false,
      },
    },
  },
};

async function openDesktop(
  page: Page,
  options: Parameters<typeof installElectronApiMock>[1] = {},
): Promise<void> {
  await installElectronApiMock(page, {
    ...options,
    initialConfig: { theme: 'light-rounded', appearanceMode: 'fixed', ...options.initialConfig },
    initialProjects: [project],
    initialSessions: [session],
    initialPanels: panels,
    activeProjectId: project.id,
  });
  await page.goto('/', { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await expect(page.locator('[data-testid="sidebar"]').first()).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText('Something went wrong')).toHaveCount(0);
}

async function openConnectedRemote(page: Page): Promise<void> {
  await page.addInitScript((profile) => {
    window.localStorage.setItem('pane.remotePwa.savedProfiles', JSON.stringify([profile]));

    class MockEventSource extends EventTarget {
      onopen: ((event: Event) => void) | null = null;
      onerror: ((event: Event) => void) | null = null;

      private readonly emitTestEvent = (event: Event) => {
        if (event instanceof CustomEvent) {
          this.dispatchEvent(new MessageEvent('daemon-event', { data: JSON.stringify(event.detail) }));
        }
      };

      constructor(readonly url: string) {
        super();
        window.addEventListener('pane-test-daemon-event', this.emitTestEvent);
        window.setTimeout(() => this.onopen?.(new Event('open')), 0);
      }

      close(): void {
        window.removeEventListener('pane-test-daemon-event', this.emitTestEvent);
      }
    }

    Object.defineProperty(window, 'EventSource', {
      configurable: true,
      value: MockEventSource,
    });
  }, {
    id: 'qa-host',
    label: 'QA host',
    baseUrl: 'http://qa-pane.test/remote/browser',
    token: 'qa-token-12345678',
    transport: 'http+sse',
  });

  await page.route('http://qa-pane.test/**', async (route) => {
    const request = route.request();
    if (request.method() === 'GET') {
      await route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
      return;
    }

    // SAFETY: the test route receives the remote invoke envelope emitted by this fixture.
    const body = JSON.parse(request.postData() ?? '{}') as { channel?: string };
    let result: JsonValue = null;
    switch (body.channel) {
      case 'sessions:get-all-with-projects':
        result = [remoteProject];
        break;
      case 'panels:list':
        result = remotePanels;
        break;
      case 'panels:getActive':
        result = remotePanels[0];
        break;
      case 'remote:pwa-affordances':
        result = remoteAffordances;
        break;
      case 'projects:list-branches':
        result = [
          { name: 'origin/main', isCurrent: false, hasWorktree: false, isRemote: true },
          { name: 'main', isCurrent: true, hasWorktree: false, isRemote: false },
        ];
        break;
      case 'projects:detect-branch':
        result = 'main';
        break;
      default:
        await route.fulfill({
          status: 500,
          contentType: 'application/json',
          body: JSON.stringify({ ok: false, error: { message: `Unexpected channel: ${body.channel ?? 'unknown'}` } }),
        });
        return;
    }

    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ok: true, result }),
    });
  });

  await page.goto('/remote.html', { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await page.getByRole('button', { name: 'Connect', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Remote accessibility pane' })).toBeVisible({ timeout: 10_000 });
}

test('Home and About are axe-clean and the modal contains and restores focus', async ({ page }) => {
  await openDesktop(page);
  await expectNoAxeViolations(page);

  // About lives in the sidebar's ⋯ menu; the menu trigger is what focus returns to.
  const menuButton = page.getByRole('button', { name: 'Home menu' });
  await menuButton.focus();
  await menuButton.click();
  const aboutItem = page.getByRole('menuitem', { name: /About Pane/i });
  await expect(aboutItem).toBeVisible();
  await aboutItem.click();

  const dialog = page.getByRole('dialog', { name: 'About Pane' });
  await expect(dialog).toBeVisible();
  // SAFETY: installElectronApiMock defines this test-only bridge before the page loads.
  await expect.poll(() => page.evaluate(() => (
    document.activeElement?.closest('[role="dialog"]') !== null
  ))).toBe(true);

  for (let index = 0; index < 8; index += 1) {
    await page.keyboard.press('Tab');
    await expect.poll(() => page.evaluate(() => (
      document.activeElement?.closest('[role="dialog"]') !== null
    ))).toBe(true);
  }

  await expectNoAxeViolations(page);
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(menuButton).toBeFocused();

  const themeTrigger = page.getByRole('button', { name: /\(sharp\)|\(rounded\)|OLED|Dusk|Forge|Ember|Aurora|Night Owl|Terracotta|Synthwave|Acid Terminal|Tokyo Rain|Folio|Newsprint|Walnut|Amber CRT|Teletype|Dot Matrix|Haar|Abyss|Understory|Colorblind Safe|Low Fatigue|High Legibility/ }).last();
  await themeTrigger.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('menu')).toBeVisible();
  await expect(page.locator('[role="menuitemradio"]:focus')).toHaveCount(1);
  await page.keyboard.press('Escape');
  await expect(themeTrigger).toBeFocused();
});

test('Night Owl recent-pane metadata remains axe-clean', async ({ page }) => {
  await openDesktop(page);

  const themeTrigger = page.getByRole('button', { name: /\(sharp\)|\(rounded\)|OLED|Dusk|Forge|Ember|Aurora|Night Owl|Terracotta|Synthwave|Acid Terminal|Tokyo Rain|Folio|Newsprint|Walnut|Amber CRT|Teletype|Dot Matrix|Haar|Abyss|Understory|Colorblind Safe|Low Fatigue|High Legibility/ }).last();
  await themeTrigger.click();
  // Item names include the picker description, so match the label prefix (and not the OLED variant).
  await page.getByRole('menuitemradio', { name: /^Night Owl(?! \(OLED\))/ }).click();
  await expect(themeTrigger).toHaveText(/Night Owl/);
  await expectNoAxeViolations(page);
});

test('seeded Create Pane dialog is keyboard reachable and axe-clean', async ({ page }) => {
  await openDesktop(page);

  await page.getByRole('button', { name: /^Expand project Accessibility fixture$/ }).click();
  const newPaneButton = page.getByRole('button', { name: /New (workspace|pane)/i }).first();
  await expect(newPaneButton).toBeVisible();
  await newPaneButton.click();

  const dialog = page.getByRole('dialog', { name: /New Pane in Accessibility fixture/i });
  await expect(dialog).toBeVisible();
  // The dialog moves focus to the name input 100 ms after opening; let that
  // land before taking focus elsewhere, or it steals it back mid-test.
  await expect(page.getByRole('textbox', { name: 'Enter a name for your pane' })).toBeFocused();
  const branchCombobox = page.getByRole('combobox', { name: /Base Branch/i });
  await expect(branchCombobox).toBeVisible();
  await branchCombobox.click();
  await expect(page.getByRole('listbox', { name: 'Branches' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeVisible();
  await expect(page.getByRole('listbox', { name: 'Branches' })).toBeHidden();
  await expect(branchCombobox).toBeFocused();

  await page.getByRole('button', { name: 'Advanced' }).click();
  await expect(page.getByRole('switch', { name: 'Start pinned' })).toBeVisible();
  await expect(page.getByRole('switch', { name: 'Use worktree' })).toBeVisible();
  await expectNoAxeViolations(page);
});

test('queued pane creation failures show a dismissible accessible error', async ({ page }) => {
  await openDesktop(page);
  await page.evaluate(() => {
    // SAFETY: installElectronApiMock installs this test event bridge before navigation.
    const mock = (window as typeof window & { __paneTestElectronMock: {
      emitSessionCreationFailed(name: string, error: string): void;
    } }).__paneTestElectronMock;
    mock.emitSessionCreationFailed('Feature', 'Git could not create the worktree.');
  });
  const dialog = page.getByRole('dialog', { name: 'Failed to Create Pane' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText('Git could not create the worktree.')).toBeVisible();
  await expect(dialog.getByText('Pane: Feature')).toBeVisible();
  await expectNoAxeViolations(page);
  await page.screenshot({ path: 'test-results/pane-creation-error.png' });
  await dialog.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(dialog).toBeHidden();
});

test('seeded pane exposes right-click actions and arrow-keyed panel tabs', async ({ page }) => {
  await openDesktop(page);

  await page.getByRole('button', { name: /^Expand project Accessibility fixture$/ }).click();
  const paneButton = page.getByRole('button', { name: 'Accessibility pane', exact: true });
  await expect(paneButton).toBeVisible();
  await expect(page.getByRole('button', { name: /Archive Accessibility pane/i })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /Pin Accessibility pane/i })).toHaveCount(0);
  await expect(paneButton.locator('button, a, [role="button"]')).toHaveCount(0);
  await paneButton.click({ button: 'right' });
  let menu = page.getByRole('menu', { name: 'Pane actions for Accessibility pane' });
  await expect(menu.getByRole('menuitem', { name: 'Pin', exact: true })).toBeVisible();
  await expect(menu.getByRole('menuitem', { name: 'Archive', exact: true })).toBeVisible();
  await menu.getByRole('menuitem', { name: 'Pin', exact: true }).click();
  // SAFETY: installElectronApiMock defines this test-only bridge before the page loads.
  await expect.poll(() => page.evaluate(() => (
    window as typeof window & {
      __paneTestElectronMock: { getSessionFavoriteToggleCalls: () => string[] };
    }
  ).__paneTestElectronMock.getSessionFavoriteToggleCalls())).toEqual([session.id]);
  await expect(paneButton).not.toHaveAttribute('aria-current', 'page');
  await paneButton.click({ button: 'right' });
  menu = page.getByRole('menu', { name: 'Pane actions for Accessibility pane' });
  await menu.getByRole('menuitem', { name: 'Archive', exact: true }).click();
  // SAFETY: installElectronApiMock defines this test-only bridge before the page loads.
  await expect.poll(() => page.evaluate(() => (
    window as typeof window & {
      __paneTestElectronMock: { getSessionDeleteCalls: () => string[] };
    }
  ).__paneTestElectronMock.getSessionDeleteCalls())).toEqual([session.id]);
  await expect(paneButton).not.toHaveAttribute('aria-current', 'page');
  await paneButton.click();

  // Explorer lives in the right inspector now, not the tab strip.
  await expect(page.getByRole('tablist', { name: 'Inspector' }).getByRole('tab', { name: 'Files' })).toBeVisible();
  const dashboardTab = page.getByRole('tab', { name: /^Dashboard/ }).first();
  const logsTab = page.getByRole('tab', { name: /^Logs/ }).first();
  await dashboardTab.click();
  await expect(dashboardTab).toHaveAttribute('aria-selected', 'true');
  await dashboardTab.focus();
  await page.keyboard.press('ArrowRight');
  await expect(logsTab).toBeFocused();
  await expect(logsTab).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('Tab');
  const closeLogs = page.getByRole('button', { name: 'Close Logs' });
  await expect(closeLogs).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(logsTab).toHaveCount(0);
  await expect(dashboardTab).toBeFocused();

  const explorerTabId = await dashboardTab.getAttribute('id');
  expect(explorerTabId).not.toBeNull();
  await dashboardTab.dblclick();
  const panelTablist = page.locator('[role="tablist"][aria-label="Panel tabs"]').first();
  await expect.poll(async () => (
    (await panelTablist.getAttribute('aria-owns'))?.split(' ').includes(explorerTabId!) ?? false
  )).toBe(false);
  await expectNoAxeViolations(page, { include: '.pane-session-shell' });
  await page.keyboard.press('Escape');

  await expectNoAxeViolations(page, { include: '.pane-session-shell' });
});

test('Pane Chat legacy fallback exposes a static agent badge', async ({ page }) => {
  await openDesktop(page);

  await page.getByRole('button', { name: 'Pane Chat' }).click();
  const shell = page.locator('.pane-chat-shell');
  await expect(shell.getByTestId('pane-chat-agent-badge')).toHaveText('Claude');
  await expect(shell.getByRole('radio')).toHaveCount(0);
  await expectNoAxeViolations(page, { include: '.pane-chat-shell' });
});

test('disconnected Remote Pane screen is axe-clean', async ({ page }) => {
  await page.goto('/remote.html', { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await expect(page.getByRole('heading', { name: 'Remote Pane' })).toBeVisible({ timeout: 10_000 });
  await page.getByRole('button', { name: /Connect with a code/i }).click();
  const codeInput = page.getByLabel('Connection Code');
  await codeInput.fill('pane-remote://not-json');
  await expectNoAxeViolations(page);
  await page.getByRole('button', { name: 'Import & Connect' }).click();
  await expect(page.getByRole('alert')).toContainText('Connection code is not valid');
  await expect(page.getByRole('alert')).not.toContainText('Tailscale');
  await expect(codeInput).toHaveAttribute('aria-invalid', 'true');
  await expectNoAxeViolations(page);
});

test('Remote pane creation failures remain visible across later daemon events', async ({ page }) => {
  await openConnectedRemote(page);
  await page.evaluate(() => {
    window.dispatchEvent(new CustomEvent('pane-test-daemon-event', { detail: {
      channel: 'session:creation-failed',
      args: [{ name: 'Feature', error: 'Git could not create the worktree.' }],
      timestamp: new Date().toISOString(),
    } }));
  });
  const dialog = page.getByRole('dialog', { name: 'Failed to Create Pane' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText('Git could not create the worktree.')).toBeVisible();
  await page.evaluate(() => {
    window.dispatchEvent(new CustomEvent('pane-test-daemon-event', { detail: {
      channel: 'project:updated', args: [], timestamp: new Date().toISOString(),
    } }));
  });
  await expect(dialog).toBeVisible();
  await expectNoAxeViolations(page);
  await dialog.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(dialog).toBeHidden();
});

test('connected Remote Create Pane keeps its dialog open on branch Escape and is axe-clean', async ({ page }) => {
  await openConnectedRemote(page);

  await page.getByRole('button', { name: 'New pane in Remote accessibility fixture' }).click();
  const dialog = page.getByRole('dialog', { name: 'New Pane in Remote accessibility fixture' });
  await expect(dialog).toBeVisible();

  const branchCombobox = page.getByRole('combobox', { name: 'Base Branch' });
  await branchCombobox.click();
  await expect(page.getByRole('listbox', { name: 'Base branches' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeVisible();
  await expect(page.getByRole('listbox', { name: 'Base branches' })).toBeHidden();
  await expect(branchCombobox).toBeFocused();
  await expectNoAxeViolations(page, { include: '[role="dialog"]' });
});
