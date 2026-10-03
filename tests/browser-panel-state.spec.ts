import { expect, test } from '@playwright/test';
import { installElectronApiMock } from './electronApiMock';

const now = new Date(0).toISOString();
const project = { id: 519, name: 'Browser fixture', path: '/tmp/browser-state', active: true, created_at: now, updated_at: now };
const session = {
  id: 'browser-state-session', name: 'Browser state', worktreePath: project.path, prompt: '',
  status: 'stopped', createdAt: now, lastActivity: now, output: [], jsonMessages: [], isRunning: false,
  permissionMode: 'ignore', projectId: project.id, displayOrder: 0, isFavorite: false, toolType: 'none', archived: false,
};
const panel = {
  id: 'browser-state-panel', sessionId: session.id, type: 'browser', title: 'Browser',
  state: { isActive: true, hasBeenViewed: true, customState: { currentUrl: 'https://example.com/', isPopup: true } },
  metadata: { createdAt: now, lastActiveAt: now, position: 0 },
};

test('browser persistence preserves a page navigation while external updates still navigate', async ({ page }, testInfo) => {
  await installElectronApiMock(page, {
    initialProjects: [project], initialSessions: [session], initialPanels: [panel], activeProjectId: project.id,
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Expand repository Browser fixture', exact: true }).click();
  await page.getByRole('button', { name: 'Browser state', exact: true }).click();
  const webview = page.locator('webview');
  await expect(webview).toHaveAttribute('src', 'https://example.com/');

  // Chromium has no Electron guest webview. Supply its public navigation API
  // and echo accepted IPC updates through the same store used by panel:updated.
  await page.evaluate(async () => {
    const modulePath = '/src/stores/panelStore.ts';
    const { usePanelStore }: typeof import('../frontend/src/stores/panelStore') = await import(modulePath);
    const originalInvoke = window.electronAPI.invoke;
    const invoke: typeof originalInvoke = async (channel, ...args) => {
      if (channel === 'panels:update') {
        const [id, updates] = args;
        // SAFETY: This fixture intercepts the public panels:update request.
        const patch = updates as Partial<import('../shared/types/panels').ToolPanel>;
        const current = usePanelStore.getState().panels['browser-state-session'].find(item => item.id === id);
        if (!current) throw new Error('Panel missing');
        usePanelStore.getState().updatePanelState({ ...current, ...patch });
        document.body.dataset.persistedState = JSON.stringify(patch.state);
        return { success: true };
      }
      return originalInvoke(channel, ...args);
    };
    window.electronAPI.invoke = invoke;
    Object.defineProperty(window, 'electron', { configurable: true, value: { invoke } });
    const guest = document.querySelector('webview');
    if (!guest) throw new Error('Browser guest missing');
    Object.assign(guest, {
      getURL: () => 'https://example.com/form', canGoBack: () => true, canGoForward: () => false,
    });
    guest.dispatchEvent(new Event('did-navigate-in-page'));
  });
  await expect(page.getByPlaceholder('Enter a URL (e.g. localhost:3000)')).toHaveValue('https://example.com/form');
  await expect(page.locator('body')).toHaveAttribute('data-persisted-state', /example.com\/form/);
  // Updating src would force the guest to reload, throwing away its form/SPA state.
  await expect(webview).toHaveAttribute('src', 'https://example.com/');
  const persisted = await page.locator('body').getAttribute('data-persisted-state');
  expect(JSON.parse(persisted!)).toMatchObject({ isActive: true, hasBeenViewed: true, customState: { isPopup: true } });

  await page.evaluate(async () => {
    const modulePath = '/src/stores/panelStore.ts';
    const { usePanelStore }: typeof import('../frontend/src/stores/panelStore') = await import(modulePath);
    const current = usePanelStore.getState().panels['browser-state-session'][0];
    usePanelStore.getState().updatePanelState({ ...current,
      state: { isActive: true, customState: { currentUrl: 'https://example.org/external' } },
    });
  });
  await expect(webview).toHaveAttribute('src', 'https://example.org/external');
  await page.screenshot({ path: testInfo.outputPath('browser-external-navigation.png') });
});
