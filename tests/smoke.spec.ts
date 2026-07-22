import { test, expect, Page } from '@playwright/test';
import type { JsonObject } from '../shared/validation/boundaryDecoder';
import { installElectronApiMock } from './electronApiMock';

test.beforeEach(async ({ page }) => {
  await installElectronApiMock(page, {
    initialProjects: [
      {
        id: 1,
        name: 'Mock Repo',
        path: '/tmp/mock-repo',
        system_prompt: null,
        run_script: null,
        build_script: null,
        archive_script: null,
        active: true,
        created_at: new Date(0).toISOString(),
        updated_at: new Date(0).toISOString(),
        open_ide_command: null,
        displayOrder: 0,
        worktree_folder: null,
      },
    ],
  });
});

async function dismissStartupDialogs(page: Page) {
  // Dismiss analytics consent dialog if present (shows before welcome)
  const analyticsDecline = page.locator('button:has-text("No thanks")');
  if (await analyticsDecline.isVisible({ timeout: 3000 }).catch(() => false)) {
    await analyticsDecline.click();
    await page.waitForTimeout(500);
  }

  // Dismiss welcome dialog if present (shows after analytics consent)
  const getStartedButton = page.locator('button:has-text("Get Started")');
  if (await getStartedButton.isVisible({ timeout: 2000 }).catch(() => false)) {
    await getStartedButton.click();
    await page.waitForTimeout(500);
  }
}

async function clickDomNode(locator: ReturnType<Page['locator']>) {
  await locator.evaluate((node: HTMLElement) => {
    node.click();
  });
}

async function setInputValue(locator: ReturnType<Page['locator']>, value: string) {
  await locator.evaluate((node: HTMLElement, nextValue) => {
    if (!(node instanceof HTMLInputElement) && !(node instanceof HTMLTextAreaElement)) {
      throw new Error('Expected an input or textarea element');
    }
    const input = node;
    const prototype = input instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
    const descriptor = Object.getOwnPropertyDescriptor(prototype, 'value');

    input.focus();
    descriptor?.set?.call(input, nextValue);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }, value);
}

async function openSettings(page: Page) {
  const collapseSidebarButton = page.getByRole('button', { name: 'Collapse sidebar' });
  await expect(collapseSidebarButton).toBeVisible({ timeout: 5000 });
  await collapseSidebarButton.click();

  const settingsButton = page.getByRole('button', { name: 'Settings' }).first();
  await expect(settingsButton).toBeVisible({ timeout: 5000 });
  await clickDomNode(settingsButton);

  await expect(page.getByText('Pane Settings')).toBeVisible({ timeout: 5000 });
}

async function openRemotePaneSettings(page: Page) {
  const remoteAccessButton = page.getByRole('button', { name: 'Remote Access', exact: true });
  await expect(remoteAccessButton).toBeVisible({ timeout: 5000 });
  await clickDomNode(remoteAccessButton);
}

async function openAdvancedRemoteSetup(page: Page) {
  const advancedRemoteSetupButton = page.getByTestId('settings-content').getByRole('button', { name: 'Advanced', exact: true });
  await expect(advancedRemoteSetupButton).toBeVisible({ timeout: 5000 });
  await clickDomNode(advancedRemoteSetupButton);
}

test.describe('Smoke Tests', () => {
  test('Application should start successfully', async ({ page }) => {
    // Navigate to the app
    await page.goto('/', { waitUntil: 'domcontentloaded', timeout: 30000 });

    // Wait for any content to appear
    await page.waitForSelector('body', { timeout: 10000 });

    // Check that the page has loaded
    const title = await page.title();
    expect(title).toBe('Pane');
    await expect(page.getByText('Something went wrong')).toHaveCount(0);

    // Take a screenshot for debugging
    await page.screenshot({ path: 'test-results/smoke-test.png' });
  });

  test('Main UI elements should be visible', async ({ page }) => {
    await page.goto('/', { waitUntil: 'domcontentloaded', timeout: 30000 });

    await dismissStartupDialogs(page);

    // Sidebar should be visible
    const sidebar = page.locator('[data-testid="sidebar"]').first();
    await expect(sidebar).toBeVisible({ timeout: 10000 });

    const sidebarMenuButton = page.getByRole('button', { name: 'Sidebar menu' });
    await expect(sidebarMenuButton).toBeVisible();
  });

  test('Settings menu item is clickable', async ({ page }) => {
    await page.goto('/', { waitUntil: 'domcontentloaded', timeout: 30000 });

    await dismissStartupDialogs(page);

    await openSettings(page);

    // Small wait to ensure no errors are thrown
    await page.waitForTimeout(500);
  });

  test('Worktree file sync custom entries remain editable while typing', async ({ page }) => {
    await page.goto('/', { waitUntil: 'domcontentloaded', timeout: 30000 });

    await dismissStartupDialogs(page);

    await openSettings(page);

    const worktreeFileSyncButton = page.getByRole('button', { name: 'Worktrees & Git', exact: true });
    await expect(worktreeFileSyncButton).toBeVisible({ timeout: 5000 });
    await clickDomNode(worktreeFileSyncButton);

    await clickDomNode(page.getByRole('button', { name: 'Add Entry' }));

    const customPathInput = page.getByPlaceholder('e.g. .env').last();
    await expect(customPathInput).toBeVisible();
    await customPathInput.pressSequentially('./venv/*');

    await expect(customPathInput).toHaveValue('./venv/*');
    await expect(page.getByText('Something went wrong')).toHaveCount(0);
  });

  test('Repository menu opens Project Settings with editable Worktree Folder', async ({ page }) => {
    await page.goto('/', { waitUntil: 'domcontentloaded', timeout: 30000 });

    await dismissStartupDialogs(page);

    const repoActionsButton = page.getByRole('button', { name: 'Repository actions for Mock Repo' });
    await expect(repoActionsButton).toBeVisible({ timeout: 5000 });
    await clickDomNode(repoActionsButton);

    await clickDomNode(page.getByRole('menuitem', { name: 'Project Settings' }));

    await expect(page.getByText('Project Settings')).toBeVisible({ timeout: 5000 });
    await expect(page.getByText('Worktree Folder')).toBeVisible();

    const worktreeFolderInput = page.getByPlaceholder('worktrees');
    await setInputValue(worktreeFolderInput, '/tmp/pane-worktrees');
    await clickDomNode(page.getByRole('button', { name: 'Save Changes' }).first());

    const projectUpdates = await page.evaluate(() => {
      const mock = (window as typeof window & {
        __paneTestElectronMock?: {
          getProjectUpdates: () => Array<{ projectId: string; updates: Record<string, unknown> }>;
        };
      }).__paneTestElectronMock;

      return mock?.getProjectUpdates() ?? [];
    });

    expect(projectUpdates).toHaveLength(1);
    expect(projectUpdates[0]).toMatchObject({
      projectId: '1',
      updates: {
        worktree_folder: '/tmp/pane-worktrees',
      },
    });
    await expect(page.getByText('Something went wrong')).toHaveCount(0);
  });

  test('Remote daemon settings can create a paired profile and switch modes', async ({ page }) => {
    await page.goto('/', { waitUntil: 'domcontentloaded', timeout: 30000 });

    await dismissStartupDialogs(page);

    await openSettings(page);
    await openRemotePaneSettings(page);
    await openAdvancedRemoteSetup(page);

    await setInputValue(page.getByLabel('Connection Label', { exact: true }), 'Office Mac mini');
    await setInputValue(page.getByLabel('Remote Base URL', { exact: true }), 'http://127.0.0.1:42137');
    await clickDomNode(page.getByRole('button', { name: 'Create Paired Profile' }));

    await expect(page.getByText('Latest generated remote token')).toBeVisible();
    await clickDomNode(page.getByRole('button', { name: 'Back to Remote Access' }));
    await clickDomNode(page.getByRole('button', { name: 'Connections', exact: true }));
    await expect(page.getByText('Office Mac mini').first()).toBeVisible();

    await clickDomNode(page.getByRole('button', { name: 'Connect', exact: true }).first());

    await expect(page.getByText('Connected to Office Mac mini').first()).toBeVisible();

    const useLocalRuntimeButton = page.getByRole('button', { name: 'Use Local Runtime' }).first();
    await expect(useLocalRuntimeButton).toBeEnabled();
    await clickDomNode(useLocalRuntimeButton);

    await expect(page.getByText('Using local runtime').first()).toBeVisible();
    await expect(page.getByText('Something went wrong')).toHaveCount(0);
  });

  test('Remote daemon settings can save an existing remote profile', async ({ page }) => {
    await page.goto('/', { waitUntil: 'domcontentloaded', timeout: 30000 });

    await dismissStartupDialogs(page);

    await openSettings(page);
    await openRemotePaneSettings(page);
    await openAdvancedRemoteSetup(page);

    await setInputValue(page.getByLabel('Existing Profile Label'), 'Tunnel from laptop');
    await setInputValue(page.getByLabel('Existing Remote Base URL'), 'http://127.0.0.1:42137');
    await setInputValue(page.getByLabel('Existing Remote Token'), 'shared-host-token');
    await clickDomNode(page.getByRole('button', { name: 'Save Remote Profile' }));

    await clickDomNode(page.getByRole('button', { name: 'Back to Remote Access' }));
    await clickDomNode(page.getByRole('button', { name: 'Connections', exact: true }));
    await expect(page.getByText('Tunnel from laptop').first()).toBeVisible();
    await expect(page.getByText('Something went wrong')).toHaveCount(0);
  });

  test('Remote daemon settings seed IPv6 loopback defaults with brackets', async ({ page }) => {
    await page.goto('/', { waitUntil: 'domcontentloaded', timeout: 30000 });

    await dismissStartupDialogs(page);

    await page.evaluate(async () => {
      await window.electronAPI.remoteDaemon.updateHostConfig({
        listenHost: '::1',
        listenPort: 42137,
      });
    });

    await openSettings(page);
    await openRemotePaneSettings(page);
    await openAdvancedRemoteSetup(page);

    await expect(page.getByLabel('Existing Remote Base URL')).toHaveValue('http://[::1]:42137');
    await expect(page.getByText('Something went wrong')).toHaveCount(0);
  });

  test('Permission dialog can approve a daemonized permission request', async ({ page }) => {
    await page.goto('/', { waitUntil: 'domcontentloaded', timeout: 30000 });

    await dismissStartupDialogs(page);

    await page.evaluate(() => {
      // SAFETY: installElectronApiMock defines this test-only bridge before the page loads.
      const mock = (window as typeof window & {
        __paneTestElectronMock?: { emitPermissionRequest: (request: JsonObject) => void };
      }).__paneTestElectronMock;

      mock?.emitPermissionRequest({
        id: 'permission-1',
        sessionId: 'session-1',
        toolName: 'Bash',
        input: { command: 'pwd' },
        timestamp: Date.now(),
      });
    });

    await expect(page.getByText('Permission Required')).toBeVisible({ timeout: 5000 });
    await expect(page.getByText('Execute shell commands')).toBeVisible();
    await expect(page.getByText('Bash')).toBeVisible();

    await page.getByRole('button', { name: 'Allow' }).click();

    await expect(page.getByText('Permission Required')).toHaveCount(0);
    await expect(page.getByText('Something went wrong')).toHaveCount(0);
  });

  test('Remote daemon resync refreshes renderer config', async ({ page }) => {
    await page.goto('/', { waitUntil: 'domcontentloaded', timeout: 30000 });

    await dismissStartupDialogs(page);

    await page.waitForTimeout(250);

    const beforeCount = await page.evaluate(() => {
      // SAFETY: installElectronApiMock defines this test-only bridge before the page loads.
      const mock = (window as typeof window & {
        __paneTestElectronMock?: {
          emitRemoteDaemonResyncRequested: () => void;
          getConfigReadCount: () => number;
        };
      }).__paneTestElectronMock;

      const count = mock?.getConfigReadCount() ?? 0;
      mock?.emitRemoteDaemonResyncRequested();
      return count;
    });

    await expect.poll(async () => page.evaluate(() => {
      // SAFETY: installElectronApiMock defines this test-only bridge before the page loads.
      const mock = (window as typeof window & {
        __paneTestElectronMock?: { getConfigReadCount: () => number };
      }).__paneTestElectronMock;

      return mock?.getConfigReadCount() ?? 0;
    })).toBeGreaterThan(beforeCount);
  });

  test('Remote daemon resync replaces stale renderer sessions', async ({ page }) => {
    await page.goto('/', { waitUntil: 'domcontentloaded', timeout: 30000 });

    await dismissStartupDialogs(page);

    const staleSessionName = 'Remote stale pane';

    await page.evaluate((sessionName) => {
      // SAFETY: installElectronApiMock defines this test-only bridge before the page loads.
      const mock = (window as typeof window & {
        __paneTestElectronMock?: {
          emitRemoteDaemonResyncRequested: () => void;
          setSessions: (sessions: JsonObject[]) => void;
        };
      }).__paneTestElectronMock;

      mock?.setSessions([{
        id: 'remote-stale-session',
        name: sessionName,
        worktreePath: '/tmp/remote-stale-session',
        prompt: 'remote stale session',
        status: 'stopped',
        createdAt: new Date().toISOString(),
        lastActivity: new Date().toISOString(),
        output: [],
        jsonMessages: [],
      }]);
      mock?.emitRemoteDaemonResyncRequested();
    }, staleSessionName);

    await expect(page.getByText(staleSessionName)).toBeVisible({ timeout: 5000 });

    await page.evaluate(() => {
      // SAFETY: installElectronApiMock defines this test-only bridge before the page loads.
      const mock = (window as typeof window & {
        __paneTestElectronMock?: {
          emitRemoteDaemonResyncRequested: () => void;
          setSessions: (sessions: JsonObject[]) => void;
        };
      }).__paneTestElectronMock;

      mock?.setSessions([]);
      mock?.emitRemoteDaemonResyncRequested();
    });

    await expect(page.getByText(staleSessionName)).toHaveCount(0);
  });

  test('Cloud widget treats connected daemon-backed hosted workspaces as ready, not reconnect-needed', async ({ page }) => {
    await page.goto('/', { waitUntil: 'domcontentloaded', timeout: 30000 });

    await dismissStartupDialogs(page);

    await page.evaluate(async () => {
      await window.electronAPI.remoteDaemon.upsertConnectionProfile({
        id: 'remote-cloud-1',
        label: 'Pane Cloud Workspace',
        baseUrl: 'https://pane.example.com/daemon/',
        token: 'secret-token',
        transport: 'http+sse',
      });
    });

    await page.evaluate(() => {
      // SAFETY: installElectronApiMock defines this test-only bridge before the page loads.
      const mock = (window as typeof window & {
        __paneTestElectronMock?: { setCloudState: (updates: JsonObject) => void };
      }).__paneTestElectronMock;

      mock?.setCloudState({
        status: 'running',
        tunnelStatus: 'off',
        daemonStatus: 'ready',
        daemonBaseUrl: 'https://pane.example.com/daemon/',
        linkedRemoteProfileId: 'remote-cloud-1',
        remoteConnectionStatus: 'connected',
        preferredAccess: 'daemon',
      });
    });

    await expect(page.getByText('Cloud Connected')).toBeVisible({ timeout: 5000 });
    await expect(page.getByRole('button', { name: 'Use Local Runtime' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Reconnect' })).toHaveCount(0);
    await expect(page.locator('button[title="Stop Cloud VM"]')).toHaveCount(0);
    await expect(page.getByText('Something went wrong')).toHaveCount(0);
  });

  test('Cloud widget preserves VM stop control for daemon-ready managed VMs', async ({ page }) => {
    await page.goto('/', { waitUntil: 'domcontentloaded', timeout: 30000 });

    await dismissStartupDialogs(page);

    await page.evaluate(() => {
      // SAFETY: installElectronApiMock defines this test-only bridge before the page loads.
      const mock = (window as typeof window & {
        __paneTestElectronMock?: { setCloudState: (updates: JsonObject) => void };
      }).__paneTestElectronMock;

      mock?.setCloudState({
        status: 'running',
        tunnelStatus: 'off',
        daemonStatus: 'ready',
        daemonBaseUrl: 'https://pane.example.com/daemon/',
        noVncUrl: 'http://localhost:9000/novnc/vnc.html',
        linkedRemoteProfileId: null,
        linkedRemoteProfileLabel: null,
        remoteConnectionStatus: 'unlinked',
        preferredAccess: 'daemon',
      });
    });

    await expect(page.getByText('Daemon Ready')).toBeVisible({ timeout: 5000 });
    await expect(page.locator('button[title="Stop Cloud VM"]')).toBeVisible();
    await expect(page.getByText('Something went wrong')).toHaveCount(0);
  });

  test('Cloud widget keeps local runtime switch available when hosted daemon connection fails', async ({ page }) => {
    await page.goto('/', { waitUntil: 'domcontentloaded', timeout: 30000 });

    await dismissStartupDialogs(page);

    await page.evaluate(() => {
      // SAFETY: installElectronApiMock defines this test-only bridge before the page loads.
      const mock = (window as typeof window & {
        __paneTestElectronMock?: { setCloudState: (updates: JsonObject) => void };
      }).__paneTestElectronMock;

      mock?.setCloudState({
        status: 'running',
        tunnelStatus: 'off',
        daemonStatus: 'ready',
        daemonBaseUrl: 'https://pane.example.com/daemon/',
        linkedRemoteProfileId: 'remote-cloud-1',
        linkedRemoteProfileLabel: 'Pane Cloud Workspace',
        remoteConnectionStatus: 'error',
        preferredAccess: 'daemon',
      });
    });

    await expect(page.getByText('Cloud Connection Error')).toBeVisible({ timeout: 5000 });
    await expect(page.getByRole('button', { name: 'Use Local Runtime' })).toBeVisible();
    await expect(page.getByText('Daemon Ready')).toHaveCount(0);

    await clickDomNode(page.getByRole('button', { name: 'Use Local Runtime' }));

    await expect(page.getByRole('button', { name: 'Connect Cloud' })).toBeVisible({ timeout: 5000 });
    await expect(page.getByText('Something went wrong')).toHaveCount(0);
  });

  test('Cloud widget preserves tunnel controls for legacy noVNC workspaces', async ({ page }) => {
    await page.goto('/', { waitUntil: 'domcontentloaded', timeout: 30000 });

    await dismissStartupDialogs(page);

    await page.evaluate(() => {
      // SAFETY: installElectronApiMock defines this test-only bridge before the page loads.
      const mock = (window as typeof window & {
        __paneTestElectronMock?: { setCloudState: (updates: JsonObject) => void };
      }).__paneTestElectronMock;

      mock?.setCloudState({
        status: 'running',
        tunnelStatus: 'running',
        daemonStatus: 'unknown',
        noVncUrl: 'http://localhost:9000/novnc/vnc.html',
        preferredAccess: 'daemon',
      });
    });

    await expect(page.getByRole('button', { name: 'Cloud', exact: true })).toBeVisible({ timeout: 5000 });
    await expect(page.locator('button[title="Stop Cloud VM"]')).toBeVisible();
    await expect(page.getByText('Daemon Ready')).toHaveCount(0);
    await expect(page.getByText('Something went wrong')).toHaveCount(0);
  });

  test('Cloud widget honors noVNC fallback when daemon metadata is unhealthy', async ({ page }) => {
    await page.goto('/', { waitUntil: 'domcontentloaded', timeout: 30000 });

    await dismissStartupDialogs(page);

    await page.evaluate(() => {
      // SAFETY: installElectronApiMock defines this test-only bridge before the page loads.
      const mock = (window as typeof window & {
        __paneTestElectronMock?: { setCloudState: (updates: JsonObject) => void };
      }).__paneTestElectronMock;

      mock?.setCloudState({
        status: 'running',
        tunnelStatus: 'running',
        daemonStatus: 'error',
        daemonBaseUrl: 'https://pane.example.com/daemon/',
        noVncUrl: 'http://localhost:9000/novnc/vnc.html',
        preferredAccess: 'daemon',
        allowNoVncFallback: true,
      });
    });

    await expect(page.getByRole('button', { name: 'Cloud', exact: true })).toBeVisible({ timeout: 5000 });
    await expect(page.locator('button[title="Stop Cloud VM"]')).toBeVisible();
    await expect(page.getByText('Daemon Ready')).toHaveCount(0);
    await expect(page.getByText('Something went wrong')).toHaveCount(0);
  });

  test('Cloud widget offers connect for available daemon-backed hosted workspaces', async ({ page }) => {
    await page.goto('/', { waitUntil: 'domcontentloaded', timeout: 30000 });

    await dismissStartupDialogs(page);

    await page.evaluate(async () => {
      await window.electronAPI.remoteDaemon.upsertConnectionProfile({
        id: 'remote-cloud-1',
        label: 'Pane Cloud Workspace',
        baseUrl: 'https://pane.example.com/daemon/',
        token: 'secret-token',
        transport: 'http+sse',
      });
    });

    await page.evaluate(() => {
      // SAFETY: installElectronApiMock defines this test-only bridge before the page loads.
      const mock = (window as typeof window & {
        __paneTestElectronMock?: { setCloudState: (updates: JsonObject) => void };
      }).__paneTestElectronMock;

      mock?.setCloudState({
        status: 'running',
        tunnelStatus: 'off',
        daemonStatus: 'ready',
        daemonBaseUrl: 'https://pane.example.com/daemon/',
        linkedRemoteProfileId: 'remote-cloud-1',
        remoteConnectionStatus: 'available',
        preferredAccess: 'daemon',
      });
    });

    await expect(page.getByRole('button', { name: 'Connect Cloud' })).toBeVisible({ timeout: 5000 });
    await expect(page.getByText('Cloud Connected')).toHaveCount(0);
    await expect(page.locator('button[title="Stop Cloud VM"]')).toHaveCount(0);

    await clickDomNode(page.getByRole('button', { name: 'Connect Cloud' }));

    await expect(page.getByText('Cloud Connected')).toBeVisible({ timeout: 5000 });
    await expect(page.getByRole('button', { name: 'Use Local Runtime' })).toBeVisible();
    await expect(page.getByText('Something went wrong')).toHaveCount(0);
  });

  test('Cloud widget surfaces hosted workspace connection failures', async ({ page }) => {
    await page.goto('/', { waitUntil: 'domcontentloaded', timeout: 30000 });

    await dismissStartupDialogs(page);

    await page.evaluate(() => {
      // SAFETY: installElectronApiMock defines this test-only bridge before the page loads.
      const mock = (window as typeof window & {
        __paneTestElectronMock?: { setCloudState: (updates: JsonObject) => void };
      }).__paneTestElectronMock;

      mock?.setCloudState({
        status: 'running',
        tunnelStatus: 'off',
        daemonStatus: 'ready',
        daemonBaseUrl: 'https://pane.example.com/daemon/',
        linkedRemoteProfileId: 'missing-profile',
        remoteConnectionStatus: 'available',
        preferredAccess: 'daemon',
      });
    });

    await clickDomNode(page.getByRole('button', { name: 'Connect Cloud' }));

    await expect(page.getByText(/does not exist/i)).toBeVisible({ timeout: 5000 });
    await expect(page.getByText('Something went wrong')).toHaveCount(0);
  });

  test('Cloud widget surfaces hosted workspace disconnect failures', async ({ page }) => {
    await page.goto('/', { waitUntil: 'domcontentloaded', timeout: 30000 });

    await dismissStartupDialogs(page);

    await page.evaluate(() => {
      // SAFETY: installElectronApiMock defines this test-only bridge before the page loads.
      const mock = (window as typeof window & {
        __paneTestElectronMock?: {
          setCloudState: (updates: JsonObject) => void;
          setCloudDisconnectError: (error: string | null) => void;
        };
      }).__paneTestElectronMock;

      mock?.setCloudState({
        status: 'running',
        tunnelStatus: 'off',
        daemonStatus: 'ready',
        daemonBaseUrl: 'https://pane.example.com/daemon/',
        linkedRemoteProfileId: 'remote-cloud-1',
        linkedRemoteProfileLabel: 'Pane Cloud Workspace',
        remoteConnectionStatus: 'connected',
        preferredAccess: 'daemon',
      });
      mock?.setCloudDisconnectError('Unable to switch back to local runtime');
    });

    await clickDomNode(page.getByRole('button', { name: 'Use Local Runtime' }));

    await expect(page.getByText('Unable to switch back to local runtime')).toBeVisible({ timeout: 5000 });
    await expect(page.getByText('Something went wrong')).toHaveCount(0);
  });
});
