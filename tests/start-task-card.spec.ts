import { expect, test, type Locator, type Page, type TestInfo } from '@playwright/test';
import type { JsonObject } from '../shared/validation/boundaryDecoder';
import { installElectronApiMock, type ElectronApiMockOptions } from './electronApiMock';

const now = new Date(0).toISOString();
const project = { id: 7, name: 'acme-web', path: '/home/dev/code/acme-web', active: true, created_at: now, updated_at: now };
const session = (id: string, extra: JsonObject = {}): JsonObject => ({
  id, name: id, projectId: project.id, worktreePath: `/home/dev/code/acme-web/worktrees/${id}`, prompt: '', status: 'stopped',
  createdAt: now, lastActivity: now, output: [], jsonMessages: [], permissionMode: 'ignore', toolType: 'none',
  archived: false, isFavorite: false, ...extra,
});
// Main never lists a project's own checkout among its Panes; hidden keeps it out of the mock's sidebar too.
const mainRepo = session('acme-web-main', { name: 'acme-web (Main)', worktreePath: project.path, isMainRepo: true, isHidden: true });
const mainTerminal = {
  id: 'main-terminal', sessionId: mainRepo.id, type: 'terminal', title: 'Terminal',
  state: { isActive: true, hasBeenViewed: true, customState: { isInitialized: false } },
  metadata: { createdAt: now, lastActiveAt: now, position: 0 },
};

// The approved mockup's states: Claude Code ready, Codex signed out, Cursor and OpenCode missing.
const mixedReadiness: ElectronApiMockOptions['agentDoctor'] = {
  claude: { available: true, signIn: 'signed-in' },
  codex: { available: true, signIn: 'signed-out' },
  cursor: { available: false },
  opencode: { available: false },
};
const FIRST_STEPS_ACTIVE = { onboarding_repo_setup: 'true', onboarding_open_project_screen: 'seen' };

type MockBridgeWindow = Window & {
  __paneTestElectronMock: {
    getInvokeCalls(channel: string): Array<{ args: unknown[] }>;
    emitPanelAgentStatus(panelId: string, sessionId: string, state: string): void;
  };
};

async function openProject(page: Page, options: ElectronApiMockOptions & { theme?: string } = {}) {
  const { theme, ...mockOptions } = options;
  if (theme) await page.addInitScript(value => window.localStorage.setItem('theme', value), theme);
  await installElectronApiMock(page, {
    platform: 'darwin',
    initialConfig: theme ? { theme, appearanceMode: 'fixed' } : undefined,
    initialProjects: [project], initialSessions: [mainRepo], activeProjectId: project.id,
    initialUiState: { expandedProjects: [project.id] },
    agentDoctor: mixedReadiness,
    ...mockOptions,
  });
  await page.goto('/', { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await page.getByRole('button', { name: `Project actions for ${project.name}`, exact: true }).click();
  await page.getByText('Open session on main', { exact: true }).click();
}

const card = (page: Page) => page.getByRole('region', { name: /^(Start a task|Run another task in parallel)$/ });
const chip = (page: Page, name: string): Locator => card(page).getByRole('button').filter({ hasText: name });

async function paneCreates(page: Page) {
  // SAFETY: installElectronApiMock installs this test bridge before navigation.
  return page.evaluate(() => (window as MockBridgeWindow).__paneTestElectronMock.getInvokeCalls('runpane:panes:create').map(call => call.args[0]));
}

async function attach(page: Page, testInfo: TestInfo, name: string) {
  const path = testInfo.outputPath(`${name}.png`);
  await page.screenshot({ path });
  await testInfo.attach(name, { path, contentType: 'image/png' });
}

for (const theme of ['light', 'dark']) {
  test(`a project with no tabs opens on Start a task, and Start creates one Pane with the agent, task and name (${theme})`, async ({ page }, testInfo) => {
    await openProject(page, { theme });

    await expect(card(page)).toContainText('Pick an agent and describe the work. It runs in its own Pane and worktree, so your branch stays untouched.');
    await expect(page.getByRole('radio', { name: 'Claude Code' })).toHaveAttribute('aria-checked', 'true');
    await expect(chip(page, 'Codex')).toHaveText('Codex · Sign in');
    await expect(chip(page, 'Cursor')).toHaveText('Cursor · Install');
    await expect(chip(page, 'OpenCode')).toHaveText('OpenCode · Install');
    await expect(card(page).getByRole('button', { name: 'Start in a new Pane' })).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Open a terminal' })).toBeVisible();
    await attach(page, testInfo, `start-task-first-${theme}`);

    await card(page).getByRole('textbox', { name: 'Task' }).fill('Add a dark mode toggle');
    await expect(card(page)).toContainText('Branch from origin/main · new Pane "add-dark-mode"');
    await attach(page, testInfo, `start-task-typed-${theme}`);
    await card(page).getByRole('button', { name: 'Start in a new Pane' }).click();

    await expect.poll(() => paneCreates(page)).toEqual([{
      repo: { id: project.id },
      focus: true,
      panes: [{ name: 'add-dark-mode', baseBranch: 'origin/main', pinned: false, tool: { agent: 'claude', initialInput: 'Add a dark mode toggle' } }],
    }]);
    await expect(page.getByRole('button', { name: 'add-dark-mode', exact: true })).toHaveAttribute('aria-current', 'page');
  });
}

test('while readiness is checked, chips show names only and nothing can start', async ({ page }) => {
  await openProject(page, { agentDoctorDelayMs: 'hold' });
  await card(page).getByRole('textbox', { name: 'Task' }).fill('Fix the login redirect');
  for (const name of ['Claude Code', 'Codex', 'Cursor', 'OpenCode']) {
    await expect(card(page).getByRole('radio', { name })).toHaveAttribute('aria-checked', 'false');
    await expect(card(page).getByRole('radio', { name })).toBeDisabled();
  }
  await expect(card(page).getByRole('button', { name: 'Start in a new Pane' })).toBeDisabled();
});

test('an agent stays selected while the card stays open past the readiness cache', async ({ page }) => {
  await page.clock.install();
  await openProject(page);
  await expect(page.getByRole('radio', { name: 'Claude Code' })).toHaveAttribute('aria-checked', 'true');

  await page.clock.fastForward(61_000);
  await card(page).getByRole('textbox', { name: 'Task' }).fill('Add a dark mode toggle');
  await expect(page.getByRole('radio', { name: 'Claude Code' })).toHaveAttribute('aria-checked', 'true');
  await expect(card(page).getByRole('button', { name: 'Start in a new Pane' })).toBeEnabled();
});

test('with a Pane in the project the card invites a parallel task and counts working agents', async ({ page }, testInfo) => {
  await openProject(page, { initialSessions: [mainRepo, session('fix-login-redirect')] });
  await expect(card(page).getByRole('heading')).toHaveText('Run another task in parallel');
  await expect(card(page)).toContainText('Each task gets its own Pane and worktree, so agents never edit the same files.');
  await expect(card(page)).not.toContainText('agent working');

  // SAFETY: installElectronApiMock installs this test bridge before navigation.
  await page.evaluate(() => (window as MockBridgeWindow).__paneTestElectronMock.emitPanelAgentStatus('agent-tab', 'fix-login-redirect', 'working'));
  await expect(card(page)).toContainText('1 agent working');
  await card(page).getByRole('textbox', { name: 'Task' }).fill('Add a dark mode toggle to the settings page and persist it per user');
  await attach(page, testInfo, 'start-task-parallel-light');
});

test('a failed start says why and Try again retries it', async ({ page }, testInfo) => {
  await openProject(page, { paneCreateError: 'The worktree folder is not writable' });
  await card(page).getByRole('textbox', { name: 'Task' }).fill('Add a dark mode toggle');
  await card(page).getByRole('button', { name: 'Start in a new Pane' }).click();

  await expect(card(page).getByRole('alert')).toHaveText(/^Couldn't start the Pane: The worktree folder is not writable\.\s*Try again$/);
  await attach(page, testInfo, 'start-task-error-light');
  await card(page).getByRole('button', { name: 'Try again' }).click();
  await expect.poll(async () => (await paneCreates(page)).length).toBe(2);
});

test('a Sign in chip opens the checkout terminal with the command typed, and closing it brings the card back', async ({ page }) => {
  await openProject(page);
  await chip(page, 'Codex').click();

  const tab = page.getByRole('tab', { name: /Sign in to Codex/ });
  await expect(tab).toBeVisible();
  await expect(card(page)).toHaveCount(0);
  const panels = await page.evaluate(async sessionId => (await window.electronAPI.panels.getSessionPanels(sessionId)).data ?? [], mainRepo.id);
  expect(panels.map(panel => panel.state.customState)).toContainEqual({ stagedCommand: 'codex login' });
  await page.getByRole('button', { name: 'Close Sign in to Codex', exact: true }).click();
  await expect(card(page)).toBeVisible();
});

test('"New task…" shows the card over the checkout\'s tabs only while first steps are active, and step 2 opens it', async ({ page }) => {
  await openProject(page, { initialPanels: [mainTerminal], initialPreferences: FIRST_STEPS_ACTIVE });
  await expect(card(page)).toHaveCount(0);

  await page.getByRole('button', { name: 'New task…' }).click();
  await expect(card(page)).toBeVisible();
  await expect(page.getByRole('button', { name: 'New task…' })).toHaveAttribute('aria-current', 'page');
  await page.getByRole('tab', { name: /Terminal/ }).click();
  await expect(card(page)).toHaveCount(0);

  await page.getByRole('button', { name: 'Home', exact: true }).click();
  const steps = page.getByRole('region', { name: 'Your first steps' });
  await steps.getByRole('button', { name: 'Start' }).click();
  await expect(card(page)).toHaveText(/Start a task/);

  await page.getByRole('button', { name: 'Home', exact: true }).click();
  await steps.getByRole('button', { name: 'Hide' }).click();
  await expect(page.getByRole('button', { name: 'New task…' })).toHaveCount(0);
});

test('without first steps the sidebar has no "New task…" row', async ({ page }) => {
  await openProject(page, { initialPreferences: { onboarding_repo_setup: 'true', onboarding_open_project_screen: 'seen', onboarding_first_steps: 'done' } });
  await expect(card(page)).toBeVisible();
  await expect(page.getByRole('button', { name: 'New task…' })).toHaveCount(0);
});
