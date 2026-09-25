import { expect, test, type Locator, type Page } from '@playwright/test';
import { installElectronApiMock } from './electronApiMock';

declare global {
  interface Window {
    __terminalClipboardWrites?: string[];
  }
}

const project = {
  id: 380,
  name: 'Terminal selection fixture',
  path: '/tmp/terminal-selection-fixture',
  active: true,
  created_at: new Date(0).toISOString(),
  updated_at: new Date(0).toISOString(),
};

const session = {
  id: 'terminal-selection-session',
  name: 'Terminal selection pane',
  worktreePath: project.path,
  prompt: 'Verify terminal selection popovers',
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

const panels = ['Bottom Terminal', 'First Terminal', 'Second Terminal'].map((title, index) => ({
  id: `terminal-${index}`,
  sessionId: session.id,
  type: 'terminal',
  title,
  state: { isActive: index === 1, hasBeenViewed: true, customState: { isInitialized: true } },
  metadata: {
    createdAt: new Date(index).toISOString(),
    lastActiveAt: new Date(index).toISOString(),
    position: index,
    permanent: index === 0,
  },
}));

async function installClipboardMock(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const copiedText: string[] = [];
    Object.defineProperty(navigator, 'platform', { configurable: true, value: 'Linux x86_64' });
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: async (text: string) => {
          copiedText.push(text);
        },
      },
    });
    window.__terminalClipboardWrites = copiedText;
  });
}

async function clipboardWrites(page: Page): Promise<string[]> {
  return page.evaluate(() => window.__terminalClipboardWrites ?? []);
}

async function selectFirstLine(page: Page, terminal: Locator): Promise<void> {
  const viewport = terminal.locator('.xterm-screen');
  await expect(viewport).toBeVisible();
  const box = await viewport.boundingBox();
  if (!box) throw new Error('Terminal viewport has no bounding box');

  await page.mouse.move(box.x + 100, box.y + 8);
  await expect.poll(() => terminal.evaluate((element) => {
    interface HookNode {
      memoizedState?: unknown;
      next?: HookNode | null;
    }
    interface FiberNode {
      memoizedState?: HookNode | null;
      return?: FiberNode | null;
    }

    // xterm renders outside React, so walk to TerminalPanel's fiber and use its
    // existing terminal ref to drive the public selection API deterministically.
    let reactElement: HTMLElement | null = element.parentElement;
    while (reactElement) {
      const fiberKey = Object.keys(reactElement).find((key) => key.startsWith('__reactFiber$'));
      if (fiberKey) {
        // SAFETY: React's private fiber key points to the linked fiber contract traversed below.
        let fiber = Object.getOwnPropertyDescriptor(reactElement, fiberKey)?.value as FiberNode | null;
        while (fiber) {
          let hook = fiber.memoizedState;
          while (hook) {
            const ref = hook.memoizedState;
            if (ref instanceof Object && 'current' in ref) {
              const candidate = ref.current;
              if (candidate instanceof Object && 'select' in candidate) {
                const select = candidate.select;
                if (select instanceof Function) {
                  select.call(candidate, 0, 0, 11);
                  return true;
                }
              }
            }
            hook = hook.next;
          }
          fiber = fiber.return ?? null;
        }
      }
      reactElement = reactElement.parentElement;
    }
    return false;
  })).toBe(true);
}

test('selection popover works in restored bottom and tab terminals', async ({ page }, testInfo) => {
  await installClipboardMock(page);
  await installElectronApiMock(page, {
    initialProjects: [project],
    initialSessions: [session],
    initialPanels: panels,
    initialTerminalStates: Object.fromEntries(panels.map((panel, index) => [
      panel.id,
      { scrollbackBuffer: `selection-${index}\r\n` },
    ])),
    activeProjectId: project.id,
  });
  await page.goto('/', { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await page.getByRole('button', { name: /^Expand project Terminal selection fixture$/ }).click();
  await page.getByRole('button', { name: session.name, exact: true }).click();

  await page.getByRole('button', { name: 'Expand terminal', exact: true }).click();
  await expect(page.locator('.xterm-screen')).toHaveCount(3, { timeout: 15_000 });
  await expect(page.getByRole('status', { name: 'Loading terminal' })).toHaveCount(0);

  const assertions = [
    page.locator('.pane-terminal-shell-body .xterm').first(),
    page.getByRole('tabpanel').locator('.xterm').first(),
  ];

  for (const terminal of assertions) {
    await selectFirstLine(page, terminal);
    await expect(page.getByRole('button', { name: 'Copy', exact: true }).first()).toBeVisible();
    await page.mouse.click(20, 20);
    await expect(page.getByRole('button', { name: 'Copy', exact: true })).toHaveCount(0);
  }

  await page.getByRole('tab', { name: panels[2].title, exact: true }).click();
  await expect(page.getByRole('tabpanel').getByRole('status', { name: 'Loading terminal' })).toHaveCount(0);
  await selectFirstLine(page, page.getByRole('tabpanel').locator('.xterm').first());
  await expect(page.getByRole('button', { name: 'Copy', exact: true }).first()).toBeVisible();
  await expect.poll(() => clipboardWrites(page)).toEqual([]);

  const screenshotPath = testInfo.outputPath('terminal-selection-popover.png');
  await page.screenshot({ path: screenshotPath, fullPage: true });
  await testInfo.attach('terminal-selection-popover', { path: screenshotPath, contentType: 'image/png' });

  await page.getByRole('button', { name: 'Copy', exact: true }).click();
  await expect.poll(() => clipboardWrites(page)).toEqual(['selection-2']);
});

test('keeps keyboard copy available when Pane shortcuts are disabled', async ({ page }) => {
  await installClipboardMock(page);
  await installElectronApiMock(page, {
    initialConfig: { keyboardShortcutsEnabled: false },
    initialProjects: [project],
    initialSessions: [session],
    initialPanels: panels,
    initialTerminalStates: Object.fromEntries(panels.map((panel, index) => [
      panel.id,
      { scrollbackBuffer: `selection-${index}\r\n` },
    ])),
    activeProjectId: project.id,
  });
  await page.goto('/', { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await page.getByRole('button', { name: /^Expand project Terminal selection fixture$/ }).click();
  await page.getByRole('button', { name: session.name, exact: true }).click();

  const terminal = page.getByRole('tabpanel').locator('.xterm').first();
  await selectFirstLine(page, terminal);
  await terminal.locator('.xterm-helper-textarea').focus();
  await page.keyboard.press('Control+Shift+C');
  await expect.poll(() => clipboardWrites(page)).toEqual(['selection-1']);
});
