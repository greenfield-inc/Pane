import { expect, test, type Page } from '@playwright/test';
import { installElectronApiMock, type ElectronApiMockOptions } from './electronApiMock';
import type { JsonObject } from '../shared/validation/boundaryDecoder';

const SHOTS = process.env.PANE_SEARCH_SHOTS;
const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();

const PROJECTS: JsonObject[] = [
  { id: 1, name: 'Pane', path: '/code/Pane', active: true },
  { id: 2, name: 'experiments', path: '/code/experiments', active: false },
  { id: 3, name: 'bloom-mono', path: '/code/bloom-mono', active: false },
  { id: 4, name: 'pane-agent-orchestration-benchmark', path: '/code/benchmark', active: false },
];

function pane(id: string, name: string, projectId: number, extra: JsonObject = {}): JsonObject {
  return {
    id, name, projectId,
    worktreePath: `/code/worktrees/${name}`,
    prompt: '', status: 'ready', createdAt: ago(9000), output: [], jsonMessages: [],
    isRunning: false, archived: false, isHidden: false, worktreeOwnership: 'pane',
    ...extra,
  };
}

const PANES: JsonObject[] = [
  pane('p-posthog', 'pane posthog', 1, { isFavorite: true, favoritePinnedAt: ago(9000), lastViewedAt: ago(2880) }),
  pane('p-film', 'pane-workspaces-film', 2, { lastViewedAt: ago(3000) }),
  pane('p-wsl', 'wsl-runpane', 1, {
    lastViewedAt: ago(60),
    gitStatus: { state: 'ahead', prNumber: 1105, prTitle: 'Make runpane work in Pane’s WSL terminals', prUrl: 'https://github.com/greenfield-inc/Pane/pull/1105' },
  }),
  pane('p-update', 'runpane-update-fix', 1, { lastViewedAt: ago(1) }),
  pane('p-polish', 'ui-polish-app', 3, { lastViewedAt: ago(5), worktreePath: '/code/worktrees/polish-branch' }),
  pane('p-dictate', 'dictate-in-pane', 2, { lastViewedAt: ago(300) }),
  pane('p-spotlight', 'spotlight-search', 1, { lastViewedAt: ago(0) }),
  ...['loops', 'mission-control', 'pane-chat-skills', 'pane-mobile', 'pane-tunnels'].map((name, index) =>
    pane(`p-extra-${index}`, name, 1, { lastViewedAt: ago(4000 + index) })),
];

function orchestrationSession(id: string, name: string, minutesAgo: number, paneIds: string[]) {
  const at = ago(minutesAgo);
  return {
    id, name, agent: 'claude', archived: false, isPinned: false,
    internalSessionId: `${id}-terminal`,
    panelIds: { claude: `${id}-claude`, codex: `${id}-codex`, cursor: `${id}-cursor` },
    goal: '', context: '', decisions: [], blockers: [], nextAction: '', evidence: [], outputs: [],
    associations: paneIds.map(paneId => ({ paneId, panelIds: [], attachedAt: at })),
    activity: [], revision: 1, createdAt: ago(9000), updatedAt: at,
  };
}

const SESSIONS = [
  orchestrationSession('s-contrib', 'pane contributors', 0, ['p-spotlight']),
  orchestrationSession('s-ui', 'Pane UI', 120, ['p-film', 'p-wsl', 'p-update']),
  orchestrationSession('s-posthog', 'pane posthog', 2880, ['p-posthog']),
];

async function boot(page: Page, options: ElectronApiMockOptions & { activePaneId?: string; panes?: JsonObject[] } = {}) {
  const { activePaneId = 'p-spotlight', panes = PANES, ...mockOptions } = options;
  await installElectronApiMock(page, {
    initialProjects: PROJECTS,
    initialSessions: panes,
    initialUiState: { expandedProjects: [1, 2, 3, 4] },
    ...mockOptions,
  });
  await page.addInitScript(({ sessions }) => {
    const archived = new Set<string>();
    const view = () => sessions.map(session => ({ ...session, archived: archived.has(session.id) }));
    Object.assign(window.electronAPI, {
      orchestrationSessions: {
        ...window.electronAPI.orchestrationSessions,
        list: async () => ({ success: true, data: { sessions: view(), selectedSessionId: undefined } }),
        select: async ({ sessionId }: { sessionId: string }) => ({ success: true, data: { sessions: view(), selectedSessionId: sessionId } }),
        update: async ({ sessionId }: { sessionId: string }, update: { archived?: boolean }) => {
          if (update.archived) archived.add(sessionId);
          return { success: true, data: view().find(session => session.id === sessionId) };
        },
      },
    });
  }, { sessions: SESSIONS });
  await page.goto('/', { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await expect(page.locator('[data-testid="sidebar"]').first()).toBeVisible({ timeout: 20_000 });
  if (activePaneId) {
    await page.getByRole('button', { name: 'spotlight-search', exact: true }).first().click();
    await expect(page.locator('[aria-current="page"][aria-label="spotlight-search"]').first()).toBeVisible();
  }
}

async function openSearch(page: Page) {
  await page.keyboard.press('ControlOrMeta+Shift+P');
  const input = page.getByRole('combobox', { name: 'Search', exact: true });
  await expect(input).toBeFocused();
  return input;
}

const results = (page: Page) => page.getByRole('listbox', { name: 'Results' });
const selectedOption = (page: Page) => page.locator('[role="option"][aria-selected="true"]');

async function shoot(page: Page, name: string) {
  if (!SHOTS) return;
  await page.screenshot({ path: `${SHOTS}/${name}.png` });
}

for (const theme of ['light', 'dark', 'teletype'] as const) {
  test(`finds real Panes, Sessions, projects and commands (${theme})`, async ({ page }) => {
    await page.setViewportSize({ width: 1400, height: 900 });
    await boot(page, { initialConfig: { theme, appearanceMode: 'fixed' } });
    const input = await openSearch(page);
    await shoot(page, `06-empty-${theme}`);
    await input.pressSequentially('pane', { delay: 40 });
    const list = results(page);
    for (const header of ['Top hit', 'Panes', 'Sessions', 'Projects', 'Commands']) {
      await expect(list.getByText(header, { exact: true })).toBeVisible();
    }
    await expect(list.getByRole('option', { name: /, Pane$/ }).first()).toBeVisible();
    await expect(list.getByRole('option', { name: /more Panes/ })).toBeVisible();
    await expect(list.getByRole('option', { name: /^Switch to/ })).toHaveCount(0);
    await shoot(page, `01-pane-${theme}`);
  });
}

test('matches a Pane by branch, project, PR number, PR title and initials', async ({ page }) => {
  await boot(page);
  const input = await openSearch(page);
  for (const [query, want] of [['polish-branch', 'ui-polish-app'], ['1105', 'wsl-runpane'], ['terminals', 'wsl-runpane'], ['rpuf', 'runpane-update-fix']]) {
    await input.fill(query);
    await expect(selectedOption(page)).toContainText(want);
  }
  await input.fill('bloom-mono');
  await expect(results(page).getByRole('option', { name: /ui-polish-app/ })).toBeVisible();
  await input.fill('arch pane');
  await expect(selectedOption(page)).toContainText('Archive Pane');
});

test('Enter opens a Pane, a Session, a project or runs a command, and closes Search', async ({ page }) => {
  await boot(page, { mainRepoSessionDelayByProjectId: { 3: 60_000 } });
  let input = await openSearch(page);
  await input.fill('runpane-update-fix');
  await page.keyboard.press('Enter');
  await expect(input).toBeHidden();
  await expect(page.locator('[aria-current="page"][aria-label="runpane-update-fix"]').first()).toBeVisible();

  input = await openSearch(page);
  await input.fill('Pane UI');
  await expect(selectedOption(page)).toHaveAttribute('aria-label', /^Pane UI, .*Session$/);
  await page.keyboard.press('Enter');
  await expect(input).toBeHidden();
  await expect(page.locator('[aria-current="page"][aria-label="runpane-update-fix"]')).toHaveCount(0);

  input = await openSearch(page);
  await input.fill('bloom-mono');
  await page.keyboard.press('Tab');
  await page.keyboard.press('Tab');
  await page.keyboard.press('Tab');
  await expect(page.getByRole('button', { name: 'Projects', pressed: true })).toBeVisible();
  await page.keyboard.press('Enter');
  await expect(input).toBeHidden();
  // Only the project view loads a project's main repository session.
  await expect(page.getByLabel('Loading main repository session').first()).toBeVisible();

  input = await openSearch(page);
  await input.fill('> open settings');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { name: 'General' })).toBeVisible();
});

test('choosing a Pane from Search leaves Settings', async ({ page }) => {
  await boot(page);
  await page.keyboard.press('ControlOrMeta+,');
  await expect(page.getByRole('heading', { name: 'General' })).toBeVisible();
  const input = await openSearch(page);
  await input.fill('runpane-update-fix');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { name: 'General' })).toBeHidden();
  await expect(page.locator('[aria-current="page"][aria-label="runpane-update-fix"]').first()).toBeVisible();
});

test('Tab cycles the filters, N more opens one, and > selects Commands', async ({ page }) => {
  await boot(page);
  const input = await openSearch(page);
  await input.fill('pane');
  await page.keyboard.press('Tab');
  await expect(page.getByRole('button', { name: 'Panes', pressed: true })).toBeVisible();
  await page.keyboard.press('Shift+Tab');
  await expect(page.getByRole('button', { name: 'All', pressed: true })).toBeVisible();
  await page.keyboard.press('Shift+Tab');
  await expect(page.getByRole('button', { name: 'Commands', pressed: true })).toBeVisible();
  await page.keyboard.press('Tab');

  const more = results(page).getByRole('option', { name: /more Panes/ });
  await more.click();
  await expect(page.getByRole('button', { name: 'Panes', pressed: true })).toBeVisible();
  await expect(results(page).getByRole('option', { name: /more/ })).toHaveCount(0);
  // Every Pane whose name or project matches "pane" is listed.
  expect(await results(page).getByRole('option').count()).toBeGreaterThan(8);

  await input.fill('>');
  await expect(page.getByRole('button', { name: 'Commands', pressed: true })).toBeVisible();
  await expect(results(page).getByRole('option', { name: /^New Pane, Command$/ })).toBeVisible();
});

test('an empty query lists the previous Pane first, so Enter returns to it', async ({ page }) => {
  await boot(page);
  await page.getByRole('button', { name: 'runpane-update-fix', exact: true }).first().click();
  await page.getByRole('button', { name: 'spotlight-search', exact: true }).first().click();
  await openSearch(page);
  const list = results(page);
  await expect(list.getByText('Recent', { exact: true })).toBeVisible();
  await expect(list.getByText('Suggested', { exact: true })).toBeVisible();
  await expect(list.getByRole('option', { name: /spotlight-search/ })).toHaveCount(0);
  await expect(selectedOption(page)).toContainText('runpane-update-fix');
  await page.keyboard.press('Enter');
  await expect(page.locator('[aria-current="page"][aria-label="runpane-update-fix"]').first()).toBeVisible();
});

test('⌘K shows the selected row’s actions, filters them, and Esc goes back', async ({ page }) => {
  await boot(page, { initialConfig: { theme: 'teletype', appearanceMode: 'fixed' } });
  await page.setViewportSize({ width: 1400, height: 900 });
  const input = await openSearch(page);
  await input.fill('wsl-runpane');
  await page.keyboard.press('ControlOrMeta+K');
  const actions = page.getByRole('listbox', { name: 'Actions' });
  for (const label of ['Open Pane', 'Open in IDE', 'Copy worktree path', 'Open pull request', 'Pin', 'Archive']) {
    await expect(actions.getByRole('option', { name: label, exact: true })).toBeVisible();
  }
  await shoot(page, '07-actions-teletype');
  await input.fill('pull');
  await expect(actions.getByRole('option')).toHaveCount(1);
  await page.keyboard.press('Escape');
  await expect(results(page)).toBeVisible();
  await expect(input).toHaveValue('wsl-runpane');
  await page.keyboard.press('Escape');
  await expect(input).toBeHidden();

  // Archive asks the usual confirmation.
  await openSearch(page);
  await page.keyboard.type('wsl-runpane');
  await page.keyboard.press('ControlOrMeta+K');
  await page.keyboard.type('archive');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('dialog', { name: 'Archive Pane' })).toContainText('Archive pane "wsl-runpane"?');
});

test('the sidebar field and the rail icon open Search ready to type', async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  await boot(page, { initialConfig: { theme: 'teletype', appearanceMode: 'fixed' } });
  const sidebar = page.getByTestId('sidebar');
  await shoot(page, '08-sidebar-teletype');
  await sidebar.getByRole('button', { name: /^Search/ }).click();
  await page.keyboard.type('posthog');
  await expect(page.getByRole('combobox', { name: 'Search', exact: true })).toHaveValue('posthog');
  await page.keyboard.press('Escape');

  await page.keyboard.press('ControlOrMeta+B');
  await page.getByTestId('sidebar').getByRole('button', { name: 'Search', exact: true }).click();
  await page.keyboard.type('loops');
  await expect(page.getByRole('combobox', { name: 'Search', exact: true })).toHaveValue('loops');
});

test('matches and ranks 2,500 items within a frame per keystroke', async ({ page }) => {
  const many = Array.from({ length: 2_400 }, (_, index) =>
    pane(`p-bulk-${index}`, `bulk-${['runpane', 'posthog', 'wsl', 'film', 'loops'][index % 5]}-${index}`, 1 + (index % 4), { lastViewedAt: ago(index) }));
  await boot(page, { panes: [...PANES, ...many] });
  const input = await openSearch(page);
  const box = await input.boundingBox();
  await page.evaluate(() => performance.clearMeasures('pane:search'));
  await input.pressSequentially('runpane upd', { delay: 30 });
  const durations = await page.evaluate(() => performance.getEntriesByName('pane:search').map(entry => entry.duration));
  expect(durations.length).toBeGreaterThan(5);
  expect(Math.max(...durations)).toBeLessThan(16);
  expect(await input.boundingBox()).toEqual(box);
});

test('disabled commands are listed last and do not run', async ({ page }) => {
  await boot(page, { activePaneId: '' });
  const input = await openSearch(page);
  // With no Pane open, Archive Pane is unavailable.
  await input.fill('> pane');
  const options = results(page).getByRole('option');
  await expect(options.last()).toHaveAttribute('aria-disabled', 'true');
  await options.last().dispatchEvent('click');
  await expect(input).toBeVisible();
});

test('opens with shortcuts off when its shortcut is kept on', async ({ page }) => {
  await boot(page, { initialConfig: { keyboardShortcutsEnabled: false, commandPaletteShortcutEnabled: true } });
  await openSearch(page);
});

test('shows only the empty state when nothing matches', async ({ page }) => {
  await boot(page);
  const input = await openSearch(page);
  await input.pressSequentially('panezzzznothing', { delay: 20 });
  await expect(results(page).getByText('No results')).toBeVisible();
  await expect(results(page).getByRole('option')).toHaveCount(0);
});
