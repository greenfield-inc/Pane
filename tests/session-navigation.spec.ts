import { expect, test } from '@playwright/test';
import { installElectronApiMock } from './electronApiMock';

const now = new Date(0).toISOString();
const project = { id: 526, name: 'Navigation', path: '/tmp/navigation', active: true, created_at: now, updated_at: now };
const session = {
  id: 'navigation-a', name: 'Pane A', worktreePath: '/tmp/navigation/a', prompt: '',
  status: 'stopped', createdAt: now, lastActivity: now, output: [], jsonMessages: [], isRunning: false,
  permissionMode: 'ignore', projectId: project.id, displayOrder: 0, isFavorite: false, toolType: 'none', archived: false,
  gitStatus: { state: 'clean', ahead: 0, behind: 0, hasUncommittedChanges: false, hasUntrackedFiles: false, filesChanged: 0 },
};
const panel = (id: string, type: string, position: number, isActive = false) => ({
  id, sessionId: session.id, type, title: id,
  state: { isActive, hasBeenViewed: true, customState: { isInitialized: false } },
  metadata: { createdAt: now, lastActiveAt: now, position },
});

test('numbered tab shortcuts follow the visible browser-first order', async ({ page }, testInfo) => {
  await installElectronApiMock(page, {
    platform: 'darwin', initialProjects: [project], initialSessions: [session], activeProjectId: project.id,
    initialPanels: [panel('Dock', 'terminal', 0), panel('Shell', 'terminal', 1, true), panel('Web', 'browser', 2)],
    initialUiState: { expandedProjects: [project.id] },
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Pane A', exact: true }).click();
  await expect(page.getByRole('tab', { name: 'Shell', exact: true })).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('Meta+Shift+1');
  await expect(page.getByRole('tab', { name: 'Web', exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByPlaceholder('Enter a URL (e.g. localhost:3000)')).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('numbered-tabs.png') });
});

test('loading a pane without an active panel preserves the selected inspector tab', async ({ page }, testInfo) => {
  await installElectronApiMock(page, {
    platform: 'darwin', initialProjects: [project], initialSessions: [session], activeProjectId: project.id,
    initialPanels: [panel('Files', 'explorer', 0), panel('Dock', 'terminal', 1), panel('Shell', 'terminal', 2)],
    initialUiState: { expandedProjects: [project.id] },
  });
  await page.addInitScript(() => localStorage.setItem('pane-inspector-tab', 'details'));
  await page.goto('/');
  await page.getByRole('button', { name: 'Pane A', exact: true }).click();
  await expect(page.getByRole('tab', { name: 'Shell', exact: true })).toBeVisible();
  await expect(page.getByRole('tab', { name: 'Details', exact: true })).toHaveAttribute('aria-selected', 'true');
  await page.screenshot({ path: testInfo.outputPath('inspector-preference.png') });
});

test('each pane checks terminal creation and handles a rejected check', async ({ page }) => {
  const sessions = [session, { ...session, id: 'navigation-b', name: 'Pane B', displayOrder: 1 }, { ...session, id: 'navigation-c', name: 'Pane C', displayOrder: 2 }];
  await installElectronApiMock(page, {
    platform: 'darwin', initialProjects: [project], initialSessions: sessions, activeProjectId: project.id,
    initialPanels: [], initialUiState: { expandedProjects: [project.id] },
  });
  await page.goto('/');
  await page.evaluate(() => {
    window.addEventListener('unhandledrejection', () => { document.body.dataset.unhandledTerminalCheck = 'true'; });
    const createPanel = window.electronAPI.panels.createPanel;
    window.electronAPI.panels.createPanel = async (...args) => {
      const response = await createPanel(...args);
      document.body.dataset.createdTerminals = `${document.body.dataset.createdTerminals ?? ''},${args[0]}`;
      return response;
    };
    const invoke = window.electronAPI.invoke;
    window.electronAPI.invoke = async (channel, ...args) => {
      if (channel === 'panels:shouldAutoCreate') {
        document.body.dataset.terminalChecks = `${document.body.dataset.terminalChecks ?? ''},${String(args[0])}`;
        if (args[0] === 'navigation-b') throw new Error('Terminal policy unavailable');
        return true;
      }
      return invoke(channel, ...args);
    };
  });
  for (const pane of sessions) {
    await page.getByRole('button', { name: pane.name, exact: true }).click();
    await expect(page.locator('body')).toHaveAttribute('data-terminal-checks', new RegExp(pane.id));
    if (pane.id !== 'navigation-b') {
      await expect(page.locator('body')).toHaveAttribute('data-created-terminals', new RegExp(pane.id));
    }
  }
  await expect(page.locator('body')).not.toHaveAttribute('data-unhandled-terminal-check', 'true');
});

for (const isMainRepo of [false, true]) {
test(`tracking responses stay with their ${isMainRepo ? 'primary checkout' : 'worktree'} and the dialog supports Escape`, async ({ page }) => {
  await installElectronApiMock(page, {
    platform: 'darwin', initialProjects: [project], initialSessions: [{ ...session, isMainRepo }, { ...session, id: 'navigation-b', name: 'Pane B', isMainRepo }],
    activeProjectId: project.id, initialPanels: [panel('Dock', 'terminal', 0, true)],
    initialUiState: { expandedProjects: [project.id] },
  });
  await page.goto('/');
  await page.evaluate(() => {
    window.electronAPI.sessions.getRemoteBranches = async (sessionId) => {
      if (sessionId === 'navigation-a') {
        document.body.dataset.trackingRequested = 'true';
        await new Promise<void>(resolve => document.addEventListener('release-branches', () => resolve(), { once: true }));
        return { success: true, data: ['origin/pane-a'] };
      }
      return { success: true, data: ['origin/pane-b'] };
    };
  });
  await page.getByRole('button', { name: 'Pane A', exact: true }).click();
  await page.getByRole('tab', { name: 'Details', exact: true }).click();
  await page.getByRole('button', { name: /Set Tracking/ }).click();
  await expect(page.locator('body')).toHaveAttribute('data-tracking-requested', 'true');
  await page.getByRole('button', { name: 'Pane B', exact: true }).click();
  await page.evaluate(async () => {
    document.dispatchEvent(new Event('release-branches'));
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  });
  await expect(page.getByText('Set Tracking Branch', { exact: true })).toBeHidden();
  await page.getByRole('button', { name: /Set Tracking/ }).click();
  await expect(page.getByRole('button', { name: 'origin/pane-b' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByText('Set Tracking Branch', { exact: true })).toBeHidden();
});

}

test('a primary checkout opened as a pane offers shared Git actions and reports failures', async ({ page }, testInfo) => {
  await installElectronApiMock(page, {
    platform: 'darwin', initialProjects: [project], initialSessions: [{ ...session, isMainRepo: true }],
    activeProjectId: project.id, initialPanels: [panel('Dock', 'terminal', 0, true)],
    initialUiState: { expandedProjects: [project.id] },
  });
  await page.goto('/');
  await page.evaluate(() => {
    window.electronAPI.sessions.gitFetch = async sessionId => {
      document.body.dataset.fetchSession = sessionId;
      return { success: false, error: 'Remote temporarily unavailable' };
    };
  });
  await page.getByRole('button', { name: 'Pane A', exact: true }).click();
  await page.getByRole('tab', { name: 'Details', exact: true }).click();
  await page.getByRole('button', { name: 'Fetch', exact: true }).click();
  await expect(page.locator('body')).toHaveAttribute('data-fetch-session', session.id);
  await expect(page.getByText('Remote temporarily unavailable', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Commit to branch', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Undo Commit', exact: true })).toBeDisabled();
  await page.screenshot({ path: testInfo.outputPath('primary-checkout-actions.png') });
});


test('project checkout shortcuts follow the same visible tab order', async ({ page }) => {
  await installElectronApiMock(page, {
    platform: 'darwin', initialProjects: [project], initialSessions: [{ ...session, isMainRepo: true }],
    activeProjectId: project.id,
    initialPanels: [panel('Shell', 'terminal', 0, true), panel('Web', 'browser', 1)],
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Repository actions for Navigation', exact: true }).click();
  await page.getByText('Open session on main', { exact: true }).click();
  await expect(page.getByRole('tab', { name: 'Shell', exact: true })).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('Meta+Shift+1');
  await expect(page.getByRole('tab', { name: 'Web', exact: true })).toHaveAttribute('aria-selected', 'true');
});

for (const addBrowser of [false, true]) {
  test(`numbered shortcuts retain ${addBrowser ? 'an appended browser' : 'persisted Shell then Web'} tab order`, async ({ page }, testInfo) => {
    await installElectronApiMock(page, {
      platform: 'darwin', initialProjects: [project], initialSessions: [session], activeProjectId: project.id,
      initialPanels: [panel('Dock', 'terminal', 0), panel('Shell', 'terminal', 1, true), ...(!addBrowser ? [panel('Web', 'browser', 2)] : [])],
      initialLayout: { version: 1, root: { type: 'group', id: 'saved', panelIds: addBrowser ? ['Shell'] : ['Shell', 'Web'], activePanelId: 'Shell' }, focusedGroupId: 'saved' },
      initialUiState: { expandedProjects: [project.id] },
    });
    await page.goto('/');
    await page.getByRole('button', { name: 'Pane A', exact: true }).click();
    const shell = page.getByRole('tab', { name: 'Shell', exact: true });
    await expect(shell).toHaveAttribute('aria-selected', 'true');
    if (addBrowser) {
      await page.getByRole('button', { name: 'Add tool', exact: true }).click();
      await page.getByRole('menuitem', { name: 'Browser', exact: true }).click();
    } else {
      await page.getByRole('tab', { name: 'Web', exact: true }).click();
    }
    await shell.hover();
    await expect(page.getByRole('tooltip')).toContainText('⌘⇧1');
    await page.keyboard.press('Meta+Shift+1');
    await expect(shell).toHaveAttribute('aria-selected', 'true');
    await page.screenshot({ path: testInfo.outputPath('layout-shortcut-order.png') });
  });
}

test('closing the fallback stage panel preserves the pinned terminal', async ({ page }) => {
  await installElectronApiMock(page, {
    platform: 'darwin', initialProjects: [project], initialSessions: [session], activeProjectId: project.id,
    initialPanels: [panel('Files', 'explorer', 0), panel('Dock', 'terminal', 1), panel('Shell', 'terminal', 2)],
    initialUiState: { expandedProjects: [project.id] },
  });
  await page.goto('/');
  await page.evaluate(() => {
    const remove = window.electronAPI.panels.deletePanel;
    window.electronAPI.panels.deletePanel = async id => {
      document.body.dataset.closedPanel = id;
      return remove(id);
    };
  });
  await page.getByRole('button', { name: 'Pane A', exact: true }).click();
  await expect(page.getByRole('tab', { name: 'Shell', exact: true })).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('Meta+w');
  await expect(page.locator('body')).toHaveAttribute('data-closed-panel', 'Shell');
  await expect(page.getByRole('tab', { name: 'Shell', exact: true })).toBeHidden();
});

test('returning to a pane shares its pending terminal creation', async ({ page }) => {
  await installElectronApiMock(page, {
    platform: 'darwin', initialProjects: [project], initialSessions: [session, { ...session, id: 'navigation-b', name: 'Pane B' }],
    activeProjectId: project.id, initialPanels: [], initialUiState: { expandedProjects: [project.id] },
  });
  await page.goto('/');
  await page.evaluate(() => {
    const invoke = window.electronAPI.invoke;
    window.electronAPI.invoke = async (channel, ...args) => channel === 'panels:shouldAutoCreate' ? true : invoke(channel, ...args);
    const create = window.electronAPI.panels.createPanel;
    window.electronAPI.panels.createPanel = async (...args) => {
      if (args[0] === 'navigation-a') {
        document.body.dataset.aTerminalRequests = String(Number(document.body.dataset.aTerminalRequests ?? 0) + 1);
        await new Promise<void>(resolve => document.addEventListener('release-terminal', () => resolve(), { once: true }));
      } else {
        document.body.dataset.bTerminalRequested = 'true';
      }
      const result = await create(...args);
      if (args[0] === 'navigation-a') document.body.dataset.aTerminalFinished = 'true';
      return result;
    };
  });
  await page.getByRole('button', { name: 'Pane A', exact: true }).click();
  await expect(page.locator('body')).toHaveAttribute('data-a-terminal-requests', '1');
  await page.getByRole('button', { name: 'Pane B', exact: true }).click();
  await expect(page.locator('body')).toHaveAttribute('data-b-terminal-requested', 'true');
  await page.getByRole('button', { name: 'Pane A', exact: true }).click();
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  await expect(page.locator('body')).toHaveAttribute('data-a-terminal-requests', '1');
  await page.evaluate(() => document.dispatchEvent(new Event('release-terminal')));
  await expect(page.locator('body')).toHaveAttribute('data-a-terminal-finished', 'true');
});
