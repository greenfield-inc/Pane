import { expect, test, type Page } from '@playwright/test';
import path from 'node:path';
import { installElectronApiMock, gotoApp } from './electronApiMock';

// A plain click opens a link in its Pane, Cmd-click in the system browser; resting on a link or
// right-clicking it shows Open in Pane, Open in browser and Copy link.
const PR = 'https://github.com/greenfield-inc/Pane/pull/1272';
const fixture = path.resolve('tests/fixtures/chat-tab-composer.tsx');
const opened = (page: Page) => page.evaluate(() => window.qaOpened);

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => Object.defineProperty(navigator, 'platform', { configurable: true, value: 'MacIntel' }));
});

test('a chat link opens in its Pane on click, in the browser on Cmd-click, and offers both on hover', async ({ page }) => {
  await page.route('**/chat-tab-composer.html*', route => route.fulfill({ contentType: 'text/html', body: `<html><head><meta charset="UTF-8"></head><body><div id="root"></div><script type="module">import RefreshRuntime from "/@react-refresh"; RefreshRuntime.injectIntoGlobalHook(window); window.$RefreshReg$ = () => {}; window.$RefreshSig$ = () => type => type; window.__vite_plugin_react_preamble_installed__ = true;</script><script type="module" src="/@vite/client"></script><script type="module" src="/@fs/${fixture}"></script></body></html>` }));
  await page.goto('/chat-tab-composer.html?conversation=1&links=1&width=640');
  const link = page.getByRole('link', { name: 'pull request #1272' });
  const popover = page.getByTestId('link-popover');

  await link.click();
  await link.click({ modifiers: ['Meta'] });
  await expect.poll(() => opened(page)).toEqual([`runpane:panels:open pane-1 ${PR}`, `external ${PR}`]);

  await page.mouse.move(900, 50);
  await link.hover();
  await expect(popover).toContainText(PR);
  await expect(popover).toContainText('Cmd-click opens in browser');
  await page.mouse.move(900, 50);
  await expect(popover).toHaveCount(0);

  await link.click({ button: 'right' });
  await page.getByRole('button', { name: 'Open in Pane' }).click();
  await expect(popover).toHaveCount(0);
  await link.click({ button: 'right' });
  await page.getByRole('button', { name: 'Open in browser' }).click();
  await link.click({ button: 'right' });
  await page.keyboard.press('Escape');
  await expect(popover).toHaveCount(0);
  await expect.poll(() => opened(page)).toEqual([`runpane:panels:open pane-1 ${PR}`, `external ${PR}`, `runpane:panels:open pane-1 ${PR}`, `external ${PR}`]);
});

const project = { id: 383, name: 'Link fixture', path: '/tmp/link-fixture', active: true, created_at: new Date(0).toISOString(), updated_at: new Date(0).toISOString() };
const session = {
  id: 'link-session', name: 'Link pane', worktreePath: project.path,
  prompt: '', status: 'stopped', createdAt: new Date(0).toISOString(),
  lastActivity: new Date(0).toISOString(), output: [], jsonMessages: [], isRunning: false,
  permissionMode: 'ignore', projectId: project.id, displayOrder: 0, isFavorite: false,
  toolType: 'none', archived: false,
};
const panels = ['Bottom Terminal', 'Link Terminal'].map((title, index) => ({
  id: `link-terminal-${index}`, sessionId: session.id, type: 'terminal', title,
  state: { isActive: index === 1, hasBeenViewed: true, customState: { isInitialized: true } },
  metadata: { createdAt: new Date(index).toISOString(), lastActiveAt: new Date(index).toISOString(), position: index, permanent: index === 0 },
}));

test('a terminal URL opens on click, shows the popover on hover and right-click, and right-click opens nothing', async ({ page }) => {
  await installElectronApiMock(page, {
    initialProjects: [project], initialSessions: [session], initialPanels: panels,
    initialTerminalStates: { [panels[1].id]: { scrollbackBuffer: `See ${PR} for the fix\r\n` } },
    activeProjectId: project.id,
  });
  await gotoApp(page);
  await page.evaluate(() => {
    window.qaOpened = [];
    const invoke = window.electronAPI.invoke;
    window.electronAPI.invoke = (channel: string, ...args: unknown[]) => {
      if (channel !== 'runpane:panels:open') return invoke(channel, ...args);
      // SAFETY: openInPaneTab sends this request shape.
      const request = args[0] as { paneId: string; url: string };
      window.qaOpened.push(`runpane:panels:open ${request.paneId} ${request.url}`);
      return Promise.resolve();
    };
    window.electronAPI.openExternal = (url: string) => {
      window.qaOpened.push(`external ${url}`);
      return Promise.resolve({ success: true });
    };
  });
  await page.getByRole('button', { name: 'Expand project Link fixture', exact: true }).click();
  await page.getByRole('button', { name: session.name, exact: true }).click();
  const terminal = page.getByRole('tabpanel').locator('.xterm-screen').first();
  await expect(terminal).toBeVisible();
  await expect(page.getByRole('status', { name: 'Loading terminal' })).toHaveCount(0);
  const box = await terminal.boundingBox();
  if (!box) throw new Error('Missing terminal');
  const popover = page.getByTestId('link-popover');

  // The URL starts after "See ", on the first row.
  await page.mouse.move(box.x + 120, box.y + 10);
  await expect(popover).toContainText(PR);
  await page.mouse.move(box.x + 400, box.y + 300);
  await expect(popover).toHaveCount(0);

  // xterm re-reads a link only when the pointer reaches a new cell.
  await page.mouse.move(box.x + 140, box.y + 10, { steps: 3 });
  await page.mouse.click(box.x + 140, box.y + 10, { button: 'right' });
  await expect(popover).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(popover).toHaveCount(0);

  await page.mouse.click(box.x + 140, box.y + 10);
  await page.keyboard.down('Meta');
  await page.mouse.click(box.x + 140, box.y + 10);
  await page.keyboard.up('Meta');
  await expect.poll(() => opened(page)).toEqual([`runpane:panels:open ${session.id} ${PR}`, `external ${PR}`]);
});
