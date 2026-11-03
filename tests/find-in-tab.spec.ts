import { expect, test, type Page } from '@playwright/test';
import { installElectronApiMock } from './electronApiMock';

// Cmd+F (Ctrl+F off macOS) opens Pane's find bar in the focused tab: J1
// (terminal) and J7 (markdown preview) from the cmd-f-find plan.

const project = {
  id: 912, name: 'Find fixture', path: '/tmp/find-fixture',
  active: true, created_at: new Date(0).toISOString(), updated_at: new Date(0).toISOString(),
};
const session = {
  id: 'find-session', name: 'Find pane', worktreePath: project.path,
  prompt: '', status: 'stopped', createdAt: new Date(0).toISOString(),
  lastActivity: new Date(0).toISOString(), output: [], jsonMessages: [], isRunning: false,
  permissionMode: 'ignore', projectId: project.id, displayOrder: 0, isFavorite: false,
  toolType: 'none', archived: false,
};

interface PanelCustomState {
  isInitialized?: boolean;
  filePath?: string;
}

function panel(id: string, type: string, title: string, position: number, active: boolean, customState: PanelCustomState, permanent = false) {
  return {
    id, sessionId: session.id, type, title,
    state: { isActive: active, hasBeenViewed: true, customState },
    metadata: { createdAt: new Date(position).toISOString(), lastActiveAt: new Date(position).toISOString(), position, permanent },
  };
}

// 40 lines, 12 of which contain "needle".
const scrollback = Array.from({ length: 40 }, (_, index) => (index % 10 < 3 ? `line ${index} has a needle` : `line ${index} is hay`)).join('\r\n');

const markdown = '# Install\n\nRun the install step first.\n\n```sh\npnpm install\n```\n';

async function openPane(page: Page) {
  await page.goto('/');
  await page.getByRole('button', { name: `Expand project ${project.name}`, exact: true }).click();
  await page.getByRole('button', { name: session.name, exact: true }).click();
}

const findBar = (page: Page) => page.getByRole('search', { name: 'Find in tab' });

test('terminal: Cmd+F finds every match in scrollback and Esc gives the keys back to the shell', async ({ page }) => {
  // The mock workspace needs its permanent bottom terminal to render tabs.
  const bottom = panel('find-bottom-terminal', 'terminal', 'Bottom Terminal', 0, false, { isInitialized: true }, true);
  const terminal = panel('find-terminal', 'terminal', 'Terminal', 1, true, { isInitialized: true });
  await installElectronApiMock(page, {
    initialProjects: [project], initialSessions: [session], initialPanels: [bottom, terminal],
    initialTerminalStates: { [terminal.id]: { scrollbackBuffer: scrollback } },
    activeProjectId: project.id,
  });
  await openPane(page);
  const tab = page.getByRole('tabpanel');
  await expect(tab.getByRole('status', { name: 'Loading terminal' })).toHaveCount(0);
  await tab.locator('.xterm-helper-textarea').first().focus();

  // The terminal's find adapter attaches once xterm and its search addon load.
  await expect(async () => {
    await page.keyboard.press('ControlOrMeta+f');
    await expect(findBar(page)).toBeVisible({ timeout: 500 });
  }).toPass();
  const input = findBar(page).getByRole('textbox', { name: 'Find' });
  await expect(input).toBeFocused();
  await input.fill('needle');
  await expect(findBar(page)).toContainText('of 12');
  // The search addon re-runs 200 ms after output is parsed; let the restored
  // scrollback's re-search land before stepping.
  await page.waitForTimeout(400);

  const counter = findBar(page).locator('[aria-live="polite"]');
  const before = await counter.textContent();
  await page.keyboard.press('Enter');
  await expect(counter).not.toHaveText(before ?? '');
  await page.keyboard.press('ControlOrMeta+g');
  await page.keyboard.press('Shift+Enter');
  await page.keyboard.press('ControlOrMeta+Shift+g');
  await expect(counter).toHaveText(before ?? '');

  await page.keyboard.press('Escape');
  await expect(findBar(page)).toHaveCount(0);
  await expect(tab.locator('.xterm-helper-textarea').first()).toBeFocused();
});

test('markdown preview: Cmd+F highlights a heading, a paragraph and a code block', async ({ page }) => {
  const filePath = `${project.path}/README.md`;
  const editor = panel('find-readme', 'editor', 'README.md', 0, true, { filePath });
  await installElectronApiMock(page, {
    initialProjects: [project], initialSessions: [session], initialPanels: [editor],
    activeProjectId: project.id,
  });
  // Same origin as the app, so the Range fetch needs no CORS preflight.
  await page.route('**/__find-preview/**', route => route.fulfill({
    status: 206,
    body: markdown,
    contentType: 'text/markdown',
    headers: { 'Content-Range': `bytes 0-${markdown.length - 1}/${markdown.length}` },
  }));
  await page.addInitScript(() => {
    const wrap = () => {
      const api = window.electronAPI;
      if (!api) return false;
      const invoke = api.invoke;
      api.invoke = (channel: string, ...args: unknown[]) => {
        if (channel === 'file:preview-url') return Promise.resolve(`${location.origin}/__find-preview/README.md`);
        if (channel === 'file:release-preview') return Promise.resolve();
        return invoke(channel, ...args);
      };
      return true;
    };
    if (!wrap()) document.addEventListener('DOMContentLoaded', wrap, { once: true });
  });
  await openPane(page);
  const tab = page.getByRole('tabpanel');
  await expect(tab.getByRole('heading', { name: 'Install' })).toBeVisible();
  await tab.getByText('Run the install step first.').click();

  await page.keyboard.press('ControlOrMeta+f');
  const input = findBar(page).getByRole('textbox', { name: 'Find' });
  await expect(input).toBeFocused();
  await input.fill('install');
  await expect(findBar(page)).toContainText('1 of 3');
  await expect.poll(() => page.evaluate(() => CSS.highlights.get('pane-find-match')?.size ?? 0)).toBe(3);
  await expect.poll(() => page.evaluate(() => CSS.highlights.get('pane-find-current')?.size ?? 0)).toBe(1);

  await page.keyboard.press('Enter');
  await expect(findBar(page)).toContainText('2 of 3');
  await page.keyboard.press('ControlOrMeta+g');
  await expect(findBar(page)).toContainText('3 of 3');
  await page.keyboard.press('ControlOrMeta+g');
  await expect(findBar(page)).toContainText('1 of 3');

  await page.keyboard.press('Escape');
  await expect(findBar(page)).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => CSS.highlights.has('pane-find-match'))).toBe(false);
});
