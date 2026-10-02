import { expect, test } from '@playwright/test';
import { installElectronApiMock } from './electronApiMock';

const project = {
  id: 381,
  name: 'Terminal upload fixture',
  path: '/tmp/terminal-upload-fixture',
  active: true,
  created_at: new Date(0).toISOString(),
  updated_at: new Date(0).toISOString(),
};

const session = {
  id: 'terminal-upload-session',
  name: 'Terminal upload pane',
  worktreePath: project.path,
  prompt: 'Verify the terminal upload button',
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

const panels = ['Bottom Terminal', 'Upload Terminal'].map((title, index) => ({
  id: `terminal-upload-${index}`,
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

test('upload button sends picked files through the drop upload path', async ({ page }) => {
  await installElectronApiMock(page, {
    initialProjects: [project],
    initialSessions: [session],
    initialPanels: panels,
    initialTerminalStates: Object.fromEntries(panels.map((panel) => [panel.id, { scrollbackBuffer: 'ready\r\n' }])),
    activeProjectId: project.id,
  });
  await page.goto('/', { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await page.getByRole('button', { name: /^Expand project Terminal upload fixture$/ }).click();
  await page.getByRole('button', { name: session.name, exact: true }).click();

  const terminal = page.getByRole('tabpanel').locator('.xterm-screen').first();
  await expect(terminal).toBeVisible();
  await terminal.hover();
  const fileChooserPromise = page.waitForEvent('filechooser');
  await page.getByRole('tabpanel').getByRole('button', { name: 'Upload files' }).click();
  const fileChooser = await fileChooserPromise;
  expect(fileChooser.isMultiple()).toBe(true);
  await fileChooser.setFiles([
    { name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('notes') },
    { name: 'shot.png', mimeType: 'image/png', buffer: Buffer.from('png') },
  ]);

  const invokeCalls = (channel: string) => page.evaluate((name) => {
    // SAFETY: installElectronApiMock defines __paneTestElectronMock with getInvokeCalls.
    const mock = (window as typeof window & { __paneTestElectronMock: {
      getInvokeCalls: (channel: string) => Array<{ args: unknown[] }>;
    } }).__paneTestElectronMock;
    return mock.getInvokeCalls(name).map((call) => call.args);
  }, channel);

  await expect.poll(async () => (await invokeCalls('terminal:paste-file')).map((args) => args[2])).toEqual(['notes.txt']);
  await expect.poll(async () => (await invokeCalls('terminal:paste-image')).map((args) => [args[0], args[3]])).toEqual([[panels[1].id, 'image/png']]);
});
