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
  // Ready: a terminal still restoring its scrollback can move focus, so wait
  // until focus put in it stays there. Find is then pressed once.
  const xterm = tab.locator('.xterm-helper-textarea').first();
  await expect(async () => {
    await xterm.focus();
    await page.waitForTimeout(300);
    await expect(xterm).toBeFocused({ timeout: 100 });
  }).toPass();

  await page.keyboard.press('ControlOrMeta+f');
  const input = findBar(page).getByRole('textbox', { name: 'Find' });
  await expect(input).toBeFocused();
  await page.keyboard.type('needle');
  const counter = findBar(page).locator('[aria-live="polite"]');
  await expect(counter).toHaveText(/^\d+ of 12$/);
  // The search addon re-runs 200 ms after output is parsed; let the restored
  // scrollback's re-search land before stepping.
  await page.waitForTimeout(400);
  const ordinal = async () => Number((await counter.textContent())?.split(' of ')[0]);
  const first = await ordinal();
  const after = (steps: number) => `${((first - 1 + steps + 12 * 4) % 12) + 1} of 12`;

  await page.keyboard.press('Enter');
  await expect(counter).toHaveText(after(1));
  await page.keyboard.press('ControlOrMeta+g');
  await expect(counter).toHaveText(after(2));
  await page.keyboard.press('Shift+Enter');
  await expect(counter).toHaveText(after(1));
  await page.keyboard.press('ControlOrMeta+Shift+g');
  await expect(counter).toHaveText(after(0));
  await page.keyboard.press('ControlOrMeta+Shift+g');
  await expect(counter).toHaveText(after(-1));

  await page.keyboard.press('Escape');
  await expect(findBar(page)).toHaveCount(0);
  await expect(xterm).toBeFocused();
});

async function openMarkdownPreview(page: Page, content: string) {
  const filePath = `${project.path}/README.md`;
  const editor = panel('find-readme', 'editor', 'README.md', 0, true, { filePath });
  await installElectronApiMock(page, {
    initialProjects: [project], initialSessions: [session], initialPanels: [editor],
    activeProjectId: project.id,
  });
  // Same origin as the app, so the Range fetch needs no CORS preflight.
  await page.route('**/__find-preview/**', route => route.fulfill({
    status: 206,
    body: content,
    contentType: 'text/markdown',
    headers: { 'Content-Range': `bytes 0-${Buffer.byteLength(content) - 1}/${Buffer.byteLength(content)}` },
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
  return page.getByRole('tabpanel');
}

test('markdown preview: Cmd+F highlights a heading, a paragraph and a code block', async ({ page }) => {
  const tab = await openMarkdownPreview(page, markdown);
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

  // With the bar closed, Shift+Cmd+G reopens on the last query and moves back
  // from the first match; Cmd+G moves forward.
  await page.keyboard.press('ControlOrMeta+Shift+g');
  await expect(findBar(page)).toContainText('3 of 3');
  await page.keyboard.press('Escape');
  await expect(findBar(page)).toHaveCount(0);
  await page.keyboard.press('ControlOrMeta+g');
  await expect(findBar(page)).toContainText('2 of 3');

  // Esc closes the bar from its buttons too, not only from the input.
  await findBar(page).getByRole('button', { name: 'Next match' }).click();
  await expect(findBar(page)).toContainText('3 of 3');
  await expect(findBar(page).getByRole('button', { name: 'Next match' })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(findBar(page)).toHaveCount(0);
});

test('markdown preview: matches scrolled into view by hand are highlighted', async ({ page }) => {
  // 1,100 matches: more than the 500 painted either side of the current one.
  const many = Array.from({ length: 1100 }, (_, index) => `Paragraph ${index} has a kiwi.`).join('\n\n');
  const tab = await openMarkdownPreview(page, many);
  const last = tab.getByText('Paragraph 1099 has a kiwi.');
  await expect(last).toBeAttached();
  await tab.getByText('Paragraph 0 has a kiwi.').click();

  await page.keyboard.press('ControlOrMeta+f');
  await findBar(page).getByRole('textbox', { name: 'Find' }).fill('kiwi');
  await expect(findBar(page)).toContainText('1 of 1100');

  await last.scrollIntoViewIfNeeded();
  await expect(last).toBeInViewport();
  await expect.poll(() => page.evaluate(() => {
    const target = Array.from(document.querySelectorAll('p')).find(p => p.textContent === 'Paragraph 1099 has a kiwi.');
    const highlight = CSS.highlights.get('pane-find-match');
    if (!target || !highlight) return false;
    return Array.from(highlight.keys()).some(range => range instanceof Range && target.contains(range.startContainer));
  })).toBe(true);
  await expect(findBar(page)).toContainText('1 of 1100');
});
