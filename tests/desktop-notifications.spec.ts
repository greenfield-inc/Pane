import { expect, test } from '@playwright/test';
import { installElectronApiMock } from './electronApiMock';
import type { VersionUpdateInfo } from '../frontend/src/types/session';
import type { PanelAgentStatusEvent } from '../shared/types/agentStatus';

declare global {
  interface Window {
    __emitVersionNotification: (event: VersionUpdateInfo) => void;
    __emitNotificationStatus: (event: PanelAgentStatusEvent) => void;
    __desktopNotifications: Array<{ title: string; tag: string }>;
    __visibleNotifications: Record<string, string>;
  }
}

const project = {
  id: 381, name: 'Terminal input fixture', path: '/tmp/terminal-input-fixture',
  active: true, created_at: new Date(0).toISOString(), updated_at: new Date(0).toISOString(),
};
const session = {
  id: 'terminal-input-session', name: 'Terminal input pane', worktreePath: project.path,
  prompt: '', status: 'stopped', createdAt: new Date(0).toISOString(),
  lastActivity: new Date(0).toISOString(), output: [], jsonMessages: [], isRunning: false,
  permissionMode: 'ignore', projectId: project.id, displayOrder: 0, isFavorite: false,
  toolType: 'none', archived: false,
};
const panels = ['Bottom Terminal', 'Input Terminal'].map((title, index) => ({
  id: `input-terminal-${index}`, sessionId: session.id, type: 'terminal', title,
  state: { isActive: index === 1, hasBeenViewed: true, customState: { isInitialized: true } },
  metadata: {
    createdAt: new Date(index).toISOString(), lastActiveAt: new Date(index).toISOString(),
    position: index, permanent: index === 0,
  },
}));

test('different panels keep separate notifications while newer status replaces the same panel', async ({ page }, testInfo) => {
  await installElectronApiMock(page, {
    initialProjects: [project], initialSessions: [session], initialPanels: panels,
    activeProjectId: project.id, initialWindowFocused: false,
    initialConfig: { notifications: { enabled: true, playSound: false } },
  });
  await page.addInitScript(() => {
    window.__desktopNotifications = [];
    window.__visibleNotifications = {};
    Object.defineProperty(window, 'Notification', { value: class {
      static permission = 'granted';
      constructor(title: string, options: NotificationOptions) {
        const tag = options.tag ?? '';
        window.__desktopNotifications.push({ title, tag });
        window.__visibleNotifications[tag] = title;
      }
    } });
    window.electronAPI.events = new Proxy(window.electronAPI.events, {
      get(target, key) {
        if (key === 'onPanelAgentStatus') return (callback: (event: PanelAgentStatusEvent) => void) => {
          window.__emitNotificationStatus = callback;
          return () => { window.__emitNotificationStatus = () => {}; };
        };
        if (key === 'onVersionUpdateAvailable') return (callback: (event: VersionUpdateInfo) => void) => {
          window.__emitVersionNotification = callback;
          return () => { window.__emitVersionNotification = () => {}; };
        };
        // SAFETY: This proxy forwards the remaining declared Electron event methods unchanged.
        return target[key as keyof typeof target];
      },
    });
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Expand repository Terminal input fixture', exact: true }).click();
  await page.getByRole('button', { name: session.name, exact: true }).click();
  await expect(page.getByRole('tab', { name: 'Input Terminal', exact: true })).toBeVisible();
  await page.evaluate(() => {
    window.__emitNotificationStatus({ panelId: 'input-terminal-0', sessionId: 'terminal-input-session', state: 'blocked', reason: null });
    window.__emitNotificationStatus({ panelId: 'input-terminal-1', sessionId: 'terminal-input-session', state: 'working', reason: null });
    window.__emitNotificationStatus({ panelId: 'input-terminal-1', sessionId: 'terminal-input-session', state: 'idle', reason: null });
  });
  await expect.poll(() => page.evaluate(() => Object.values(window.__visibleNotifications).sort())).toEqual([
    'Bottom Terminal needs your input', 'Input Terminal finished',
  ]);
  await page.evaluate(() => window.__emitNotificationStatus({
    panelId: 'input-terminal-1', sessionId: 'terminal-input-session', state: 'blocked', reason: null,
  }));
  await expect.poll(() => page.evaluate(() => Object.values(window.__visibleNotifications).sort())).toEqual([
    'Bottom Terminal needs your input', 'Input Terminal needs your input',
  ]);
  await page.evaluate(() => {
    const update = { current: '1.0.0', latest: '2.0.0', version: '2.0.0', hasUpdate: true };
    window.__emitVersionNotification(update);
    window.__emitVersionNotification(update);
  });
  await expect.poll(() => page.evaluate(() => Object.values(window.__visibleNotifications).sort())).toEqual([
    'Bottom Terminal needs your input', 'Input Terminal needs your input', '🚀 Update Available - Pane v2.0.0',
  ]);
  expect(await page.evaluate(() => window.__desktopNotifications.length)).toBe(5);
  await testInfo.attach('notification-records', {
    body: JSON.stringify(await page.evaluate(() => window.__desktopNotifications), null, 2),
    contentType: 'application/json',
  });
});
