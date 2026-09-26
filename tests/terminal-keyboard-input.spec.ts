import { expect, test, type Page } from '@playwright/test';
import { installElectronApiMock } from './electronApiMock';

declare global {
  interface Window {
    __terminalInputMessages: string[];
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

// Exact messages passed by TerminalPanel to terminal:input. No byte joining:
// ESC in its own message must fail even if concatenating would look correct.
async function inputMessages(page: Page): Promise<string[]> {
  return page.evaluate(() => window.__terminalInputMessages);
}

const cases = [
  {
    key: 'Alt+ArrowUp', vt: '\x1b[1;3A',
    win32: ['\x1b[18;56;0;1;2;1_', '\x1b[38;72;0;1;258;1_', '\x1b[38;72;0;0;258;1_', '\x1b[18;56;0;0;0;1_'],
  },
  {
    key: 'Shift+ArrowLeft', vt: '\x1b[1;2D',
    win32: ['\x1b[16;42;0;1;16;1_', '\x1b[37;75;0;1;272;1_', '\x1b[37;75;0;0;272;1_', '\x1b[16;42;0;0;0;1_'],
  },
  {
    key: 'Shift+ArrowUp', vt: '\x1b[1;2A',
    win32: ['\x1b[16;42;0;1;16;1_', '\x1b[38;72;0;1;272;1_', '\x1b[38;72;0;0;272;1_', '\x1b[16;42;0;0;0;1_'],
  },
  { key: 'F6', vt: '\x1b[17~', win32: ['\x1b[117;64;0;1;0;1_', '\x1b[117;64;0;0;0;1_'] },
];

for (const fullscreen of [false, true]) {
  for (const win32 of [false, true]) {
    test(`terminal input stays intact: fullscreen=${fullscreen}, win32=${win32}`, async ({ page }) => {
      const modes = (fullscreen ? '\x1b[?1049h' : '') + (win32 ? '\x1b[?9001h' : '');
      await installElectronApiMock(page, {
        initialProjects: [project], initialSessions: [session], initialPanels: panels,
        initialTerminalStates: { [panels[1].id]: { scrollbackBuffer: modes } },
        activeProjectId: project.id,
      });
      await page.goto('/');
      await page.evaluate((isAlternateScreen) => {
        const calls: string[] = [];
        window.__terminalInputMessages = calls;
        const invoke = window.electronAPI.invoke;
        window.electronAPI.invoke = (channel: string, ...args: unknown[]) => {
          if (channel === 'terminal:getAltScreenState') return Promise.resolve({ isAlternateScreen });
          if (channel === 'terminal:input') calls.push(String(args[1]));
          return invoke(channel, ...args);
        };
      }, fullscreen);
      await page.getByRole('button', { name: 'Expand repository Terminal input fixture', exact: true }).click();
      await page.getByRole('button', { name: session.name, exact: true }).click();
      const terminal = page.getByRole('tabpanel');
      const input = terminal.locator('.xterm-helper-textarea').first();
      await expect(input).toBeAttached();
      await expect(terminal.getByRole('status', { name: 'Loading terminal' })).toHaveCount(0);
      await input.focus();
      if (!win32) {
        for (const [key, expected] of [
          ['Control+a', '\x01'], ['Control+d', '\x04'], ['Control+q', '\x11'],
        ]) {
          await page.evaluate(() => window.__terminalInputMessages.length = 0);
          await page.keyboard.press(key);
          expect.soft(await inputMessages(page), key).toEqual([expected]);
        }
      }
      for (const { key, vt, win32: records } of cases) {
        await page.evaluate(() => window.__terminalInputMessages.length = 0);
        await page.keyboard.press(key);
        // Pane owns Shift+Up for scrollback outside a fullscreen TUI. Modifier
        // transitions still pass through; the arrow itself must stay consumed.
        const paneOwnsKey = key === 'Shift+ArrowUp' && !fullscreen;
        const expected = paneOwnsKey
          ? (win32 ? [records[0], records[records.length - 1]] : [])
          : (win32 ? records : [vt]);
        expect(await inputMessages(page), key).toEqual(expected);
      }
    });
  }
}
