import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { installElectronApiMock, type ElectronApiMockOptions } from './electronApiMock';

const now = new Date(0).toISOString();
const project = { id: 514, name: 'acme-web', path: '/tmp/acme-web', active: true, created_at: now, updated_at: now };
const session = {
  id: 'new-tab-session', name: 'fix-login-redirect', worktreePath: '/tmp/acme-web/worktrees/fix-login-redirect', prompt: '',
  status: 'stopped', createdAt: now, lastActivity: now, output: [], jsonMessages: [], isRunning: false,
  permissionMode: 'ignore', projectId: project.id, displayOrder: 0, isFavorite: false, toolType: 'none', archived: false,
  gitStatus: { state: 'clean', ahead: 0, behind: 0, hasUncommittedChanges: false, hasUntrackedFiles: false, filesChanged: 0 },
};
const dock = {
  id: 'new-tab-dock', sessionId: session.id, type: 'terminal', title: 'Terminal',
  state: { isActive: false, hasBeenViewed: true, customState: { isInitialized: false, shellType: 'zsh' } },
  metadata: { createdAt: now, lastActiveAt: now, position: 0, permanent: true },
};
const agentTab = {
  id: 'new-tab-agent', sessionId: session.id, type: 'terminal', title: 'Codex',
  state: { isActive: true, hasBeenViewed: true, customState: { isInitialized: false, initialCommand: 'codex --yolo', agentType: 'codex' } },
  metadata: { createdAt: now, lastActiveAt: now, position: 1, permanent: false },
};

// The approved mockup's states: Claude Code ready, Codex signed out, Cursor and OpenCode missing.
const mixedReadiness: ElectronApiMockOptions['agentDoctor'] = {
  claude: { available: true, signIn: 'signed-in' },
  codex: { available: true, signIn: 'signed-out' },
  cursor: { available: false },
  opencode: { available: false },
};

async function openPane(page: Page, options: ElectronApiMockOptions & { theme?: string } = {}) {
  const { theme, ...mockOptions } = options;
  if (theme) await page.addInitScript(value => window.localStorage.setItem('theme', value), theme);
  await installElectronApiMock(page, {
    platform: 'darwin',
    initialConfig: theme ? { theme, appearanceMode: 'fixed' } : undefined,
    initialProjects: [project], initialSessions: [session], initialPanels: [dock, agentTab], activeProjectId: project.id,
    agentDoctor: mixedReadiness,
    ...mockOptions,
  });
  await page.goto('/', { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await page.getByRole('button', { name: /^Expand project acme-web$/ }).click();
  await page.getByRole('button', { name: 'fix-login-redirect', exact: true }).click();
}

async function sessionPanels(page: Page) {
  return page.evaluate(async sessionId => {
    const result = await window.electronAPI.panels.getSessionPanels(sessionId);
    return (result.data ?? []).map(entry => ({ type: entry.type, title: entry.title, customState: entry.state.customState }));
  }, session.id);
}

async function attach(page: Page, testInfo: TestInfo, name: string) {
  const path = testInfo.outputPath(`${name}.png`);
  await page.screenshot({ path });
  await testInfo.attach(name, { path, contentType: 'image/png' });
}

const picker = (page: Page) => page.getByRole('region', { name: 'Start an agent here' });

test('"+" opens a New tab that lists each agent with its readiness, and Enter launches the ready one in its place', async ({ page }, testInfo) => {
  await openPane(page);
  await page.getByRole('button', { name: 'Add tool', exact: true }).click();

  await expect(page.getByRole('tab', { name: /New tab/ })).toBeVisible();
  const rows = picker(page).getByRole('button');
  await expect(rows.filter({ hasText: 'Claude Code' })).toContainText('Ready');
  await expect(rows.filter({ hasText: 'Codex' })).toContainText('Sign in needed · Sign in');
  await expect(rows.filter({ hasText: 'Cursor' })).toContainText('Not installed · Install');
  await expect(rows.filter({ hasText: 'OpenCode' })).toContainText('Not installed · Install');
  await expect(rows.filter({ hasText: 'Plain terminal' })).toContainText('zsh');
  await expect(picker(page)).toContainText('Other tools: Explorer · Browser · Notes · Add custom command…');
  await expect(rows.filter({ hasText: 'Claude Code' })).toBeFocused();
  await attach(page, testInfo, 'picker-loaded-light');

  await page.keyboard.press('Enter');
  await expect(page.getByRole('tab', { name: /New tab/ })).toHaveCount(0);
  await expect.poll(async () => (await sessionPanels(page)).map(panel => panel.type)).not.toContain('new-tab');
  expect((await sessionPanels(page)).find(panel => panel.title === 'Claude Code')?.customState).toMatchObject({
    initialCommand: 'claude --dangerously-skip-permissions',
  });
});

test('the picker matches the mockup in dark mode', async ({ page }, testInfo) => {
  await openPane(page, { theme: 'dark' });
  await page.getByRole('button', { name: 'Add tool', exact: true }).click();
  await expect(picker(page).getByRole('button').filter({ hasText: 'Claude Code' })).toContainText('Ready');
  await attach(page, testInfo, 'picker-loaded-dark');
});

test('rows stay blank while the check runs', async ({ page }, testInfo) => {
  await openPane(page, { agentDoctorDelayMs: 'hold' });
  await page.getByRole('button', { name: 'Add tool', exact: true }).click();
  const codex = picker(page).getByRole('button').filter({ hasText: 'Codex' });
  await expect(codex).toHaveText('Codex');
  await attach(page, testInfo, 'picker-checking-light');
});

test('an unknown sign-in shows no badge and the row launches the agent', async ({ page }, testInfo) => {
  await openPane(page, { agentDoctor: { ...mixedReadiness, codex: { available: true, signIn: 'unknown' } } });
  await page.getByRole('button', { name: 'Add tool', exact: true }).click();
  const codex = picker(page).getByRole('button').filter({ hasText: 'Codex' });
  await expect(picker(page).getByRole('button').filter({ hasText: 'Claude Code' })).toContainText('Ready');
  await expect(codex).toHaveText('Codex');
  await attach(page, testInfo, 'picker-unknown-light');

  await codex.click();
  await expect.poll(async () => (await sessionPanels(page)).find(panel => panel.title === 'Codex' && panel.customState?.initialCommand === 'codex --yolo')).toBeTruthy();
});

test('Sign in and Install open a terminal with the vendor command typed, not run', async ({ page }) => {
  await openPane(page);
  await page.getByRole('button', { name: 'Add tool', exact: true }).click();
  await picker(page).getByRole('button').filter({ hasText: 'Codex' }).click();
  await expect.poll(async () => (await sessionPanels(page)).find(panel => panel.title === 'Sign in to Codex')?.customState).toMatchObject({ stagedCommand: 'codex login' });

  await page.getByRole('button', { name: 'Add tool', exact: true }).click();
  await picker(page).getByRole('button').filter({ hasText: 'OpenCode' }).click();
  const install = (await sessionPanels(page)).find(panel => panel.title === 'Install OpenCode');
  expect(install?.customState).toMatchObject({ stagedCommand: 'curl -fsSL https://opencode.ai/install | bash' });
  expect(install?.customState).not.toHaveProperty('initialCommand');
});

test('agent shortcuts still open their tool directly, with no picker', async ({ page }) => {
  await openPane(page);
  await page.locator('body').click();
  await page.keyboard.press('Meta+Alt+3');
  await expect.poll(async () => (await sessionPanels(page)).filter(panel => panel.title === 'Claude Code').length).toBe(1);
  expect((await sessionPanels(page)).map(panel => panel.type)).not.toContain('new-tab');
});

test.describe('exit card', () => {
  async function emitExit(page: Page, event: { elapsedMs: number; lastLine?: string }) {
    const payload = { panelId: agentTab.id, sessionId: session.id, agent: 'codex', ...event };
    // The agent tab subscribes once it has mounted.
    await expect.poll(() => page.evaluate(() => {
      // SAFETY: installElectronApiMock installs this test event bridge before navigation.
      const mock = (window as typeof window & { __paneTestElectronMock: { getListenerCount(channel: string): number } }).__paneTestElectronMock;
      return mock.getListenerCount('terminal:launchExited');
    })).toBeGreaterThan(0);
    await page.evaluate(exit => {
      // SAFETY: installElectronApiMock installs this test event bridge before navigation.
      const mock = (window as typeof window & { __paneTestElectronMock: {
        emitTerminalLaunchExited(event: typeof exit): void;
      } }).__paneTestElectronMock;
      mock.emitTerminalLaunchExited(exit);
    }, payload);
  }

  test('a signed-out agent that quits at once says why and offers the sign-in', async ({ page }, testInfo) => {
    await openPane(page);
    await emitExit(page, { elapsedMs: 400, lastLine: 'Not logged in' });

    const card = page.getByTestId('launch-exit-card');
    await expect(card).toContainText('Codex stopped in under a second');
    await expect(card).toContainText("Codex isn't signed in on this computer, so it exited before it could start.");
    await expect(card.getByRole('button')).toHaveText(['Sign in to Codex', 'Try again', 'Open terminal']);
    await attach(page, testInfo, 'exit-card-signed-out-light');

    await card.getByRole('button', { name: 'Try again' }).click();
    await expect(card).toHaveCount(0);
    const resumes = await page.evaluate(() => {
      // SAFETY: installElectronApiMock installs this test event bridge before navigation.
      const mock = (window as typeof window & { __paneTestElectronMock: {
        getInvokeCalls(channel: string): Array<{ args: unknown[] }>;
      } }).__paneTestElectronMock;
      return mock.getInvokeCalls('runpane:panels:resume');
    });
    expect(resumes.map(call => call.args[0])).toEqual([{ panelId: agentTab.id }]);
  });

  test('an unknown cause quotes the agent\'s last line and offers only Try again and Open terminal', async ({ page }, testInfo) => {
    await openPane(page, { theme: 'dark', agentDoctor: { ...mixedReadiness, codex: { available: true, signIn: 'signed-in' } } });
    await emitExit(page, { elapsedMs: 2_300, lastLine: 'Error: model not found' });

    const card = page.getByTestId('launch-exit-card');
    await expect(card).toContainText('Codex stopped after 2 seconds');
    await expect(card).toContainText('It said: "Error: model not found"');
    await expect(card.getByRole('button')).toHaveText(['Try again', 'Open terminal']);
    await attach(page, testInfo, 'exit-card-unknown-dark');

    await card.getByRole('button', { name: 'Open terminal' }).click();
    await expect(card).toHaveCount(0);
  });
});
