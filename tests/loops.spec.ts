import { expect, test, type Page } from '@playwright/test';
import type { Loop } from '../shared/types/loop';
import { installElectronApiMock, type ElectronApiMockOptions } from './electronApiMock';

const projects = [
  { id: 1, name: 'Pane', path: '/tmp/pane', active: true, created_at: '2026-10-01T00:00:00.000Z', updated_at: '2026-10-01T00:00:00.000Z' },
  { id: 2, name: 'bloom-mono', path: '/tmp/bloom-mono', active: false, created_at: '2026-10-01T00:00:00.000Z', updated_at: '2026-10-01T00:00:00.000Z' },
];

/** Set to a folder to save a screenshot of each screen there. */
const screenshotDir = process.env.LOOPS_SCREENSHOT_DIR;
async function shoot(page: Page, name: string) {
  if (screenshotDir) await page.screenshot({ path: `${screenshotDir}/${name}.png` });
}

async function chooseRepeat(page: Page, option: string) {
  await page.getByRole('dialog').getByRole('combobox', { name: 'Repeat' }).click();
  await page.getByRole('option', { name: option, exact: true }).click();
}

/** `addElectronApi` runs after the mock is installed, to add APIs it lacks. */
async function open(page: Page, options: ElectronApiMockOptions = {}, addElectronApi?: () => void) {
  await page.setViewportSize({ width: 1_440, height: 900 });
  await installElectronApiMock(page, {
    initialProjects: projects,
    initialSessions: [],
    initialConfig: { theme: 'light-rounded', appearanceMode: 'fixed' },
    ...options,
  });
  if (addElectronApi) await page.addInitScript(addElectronApi);
  await page.goto('/', { waitUntil: 'domcontentloaded' });
}

test('creates, runs, pauses, edits and deletes a loop', async ({ page }) => {
  await open(page, { initialUiState: { expandedProjects: [1], repositoriesSectionExpanded: true } });

  await page.getByTestId('loops-nav').click();
  await expect(page.getByText('No loops yet')).toBeVisible();
  await page.getByRole('button', { name: 'New loop' }).first().click();

  const drawer = page.getByRole('dialog');
  await drawer.getByLabel('Name').fill('Nightly bug sweep');
  await drawer.getByRole('radio', { name: 'Command' }).click();
  await drawer.getByLabel('Command').fill('agent-farm run greenfield/bug-sweep --since 24h');
  const schedule = drawer.getByTestId('loop-schedule-preview');
  await expect(drawer.getByRole('combobox', { name: 'Repeat' })).toHaveText('Daily');
  await expect(schedule).toContainText('Daily at 3:00 AM');

  // Custom cron starts from the picker's cron.
  await chooseRepeat(page, 'Custom cron');
  await expect(drawer.getByLabel('Cron', { exact: true })).toHaveValue('0 3 * * *');
  await drawer.getByLabel('Cron', { exact: true }).fill('*/15 * * * *');
  // The mock rejects sub-hourly crons like main does; the drawer must not let it be saved.
  await expect(drawer.getByRole('button', { name: 'Save' })).toBeDisabled();

  await chooseRepeat(page, 'Weekly on Monday');
  await drawer.getByRole('button', { name: 'Wednesday' }).click();
  await drawer.getByRole('button', { name: 'Friday' }).click();
  await drawer.getByLabel('At', { exact: true }).fill('09:30');
  await expect(drawer.getByRole('combobox', { name: 'Repeat' })).toHaveText('Weekly on Mon, Wed, Fri');
  await expect(schedule).toContainText('Weekly on Mon, Wed, Fri at 9:30 AM');
  await expect(schedule).toContainText('cron: 30 9 * * 1,3,5');

  await chooseRepeat(page, 'Daily');
  await expect(schedule).toContainText('cron: 30 9 * * *');
  await drawer.getByRole('button', { name: 'Save' }).click();
  await expect(drawer).toBeHidden();

  const detail = page.getByTestId('loop-detail');
  await expect(page.getByTestId('loop-list-item')).toContainText('Daily at 9:30 AM · no runs yet');
  await expect(detail.getByRole('heading', { name: 'Nightly bug sweep' })).toBeVisible();
  await expect(detail.getByText('agent-farm run greenfield/bug-sweep --since 24h')).toBeVisible();
  await expect(page.getByTestId('loops-nav')).toContainText('1');

  await detail.getByRole('button', { name: 'Run now' }).click();
  await expect(detail.getByRole('row')).toHaveCount(1);
  await expect(detail.getByRole('row')).toContainText('running');
  // The run is a normal Pane under its project, marked as a loop run.
  await expect(page.getByRole('button', { name: /^nightly-bug-sweep · / })).toBeVisible();

  await detail.getByRole('button', { name: /^Open run / }).click();
  const header = page.getByTestId('loop-run-header');
  await expect(header.getByRole('navigation', { name: 'Breadcrumb' })).toContainText(/Loops.*Nightly bug sweep.*Run /);
  await expect(page.getByTestId('loop-runs-rail').getByRole('button')).toHaveCount(1);
  // A run Pane starts with the inspector closed.
  await expect(page.getByRole('button', { name: 'Show details' })).toBeVisible();

  await header.getByRole('button', { name: 'Loops' }).click();
  await detail.getByRole('button', { name: 'Pause' }).click();
  await expect(detail.getByText('paused', { exact: true })).toBeVisible();
  await expect(detail.getByRole('button', { name: 'Resume' })).toBeVisible();

  await detail.getByRole('button', { name: 'Edit' }).click();
  await expect(drawer.getByLabel('Name')).toHaveValue('Nightly bug sweep');
  await drawer.getByLabel('Name').fill('Morning bug sweep');
  await drawer.getByRole('button', { name: 'Save' }).click();
  await expect(detail.getByRole('heading', { name: 'Morning bug sweep' })).toBeVisible();

  await detail.getByRole('button', { name: 'Edit' }).click();
  await drawer.getByRole('button', { name: 'Delete loop' }).click();
  await drawer.getByRole('button', { name: 'Delete', exact: true }).click();
  await expect(page.getByText('No loops yet')).toBeVisible();
});

test('creates a loop that messages a Session', async ({ page }) => {
  await open(page, {}, () => {
    const id = '__orchestration_session_standups__';
    const at = new Date().toISOString();
    const sessions = [{
      id, name: 'Standups', agent: 'codex', archived: false, isPinned: false,
      internalSessionId: `${id}terminal__`,
      panelIds: { claude: `${id}claude`, codex: `${id}codex`, cursor: `${id}cursor` },
      goal: '', context: '', decisions: [], blockers: [], nextAction: '', evidence: [], outputs: [], associations: [], activity: [],
      revision: 1, createdAt: at, updatedAt: at,
    }];
    Object.assign(window.electronAPI, {
      orchestrationSessions: {
        list: async () => ({ success: true, data: { sessions, selectedSessionId: undefined } }),
        select: async () => ({ success: true, data: { sessions, selectedSessionId: sessions[0].id } }),
      },
    });
  });
  await page.getByTestId('loops-nav').click();
  await page.getByRole('button', { name: 'New loop' }).first().click();

  const drawer = page.getByRole('dialog');
  await drawer.getByRole('radio', { name: 'Session' }).click();
  await drawer.getByLabel('Name').fill('Morning standup');
  await expect(drawer.getByRole('combobox', { name: 'Session' })).toHaveText('New Session for this loop');
  await expect(drawer.getByRole('note')).toHaveText('The new Session\'s agent will skip permission prompts for every message it gets, not only loop runs.');
  // A Session loop messages the agent: no command, and a message is required.
  await expect(drawer.getByRole('radio', { name: 'Command' })).toHaveCount(0);
  await expect(drawer.getByRole('button', { name: 'Save' })).toBeDisabled();
  await drawer.getByLabel('Message').fill('Summarize what changed across my projects since yesterday.');
  await shoot(page, '10-drawer-session-new');

  await drawer.getByRole('combobox', { name: 'Session' }).click();
  await page.getByRole('option', { name: 'Standups', exact: true }).click();
  await expect(drawer.getByRole('note')).toHaveText('This Session\'s agent will skip permission prompts for every message it gets, not only loop runs. If it is running now, runs wait until you restart it; Pane never restarts it for you.');
  // The existing Session keeps its own agent.
  await expect(drawer.getByRole('radio', { name: 'Codex' })).toHaveAttribute('aria-checked', 'true');
  await shoot(page, '11-drawer-session-existing');
  await drawer.getByRole('button', { name: 'Save' }).click();
  await expect(drawer).toBeHidden();

  await expect(page.getByTestId('loop-list-item')).toContainText('Session · Standups');
  await expect(page.getByTestId('loop-detail').getByRole('button', { name: 'Open Session' })).toBeVisible();
});

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const today3am = new Date();
today3am.setHours(3, 0, 0, 0);

function runSession(id: string, slotAtMs: number, minutes: number, status: string) {
  return {
    id,
    name: `nightly-bug-sweep · ${new Date(slotAtMs).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} ${new Date(slotAtMs).toTimeString().slice(0, 5)}`,
    projectId: 1,
    worktreePath: `/tmp/worktrees/loop-nightly-bug-sweep-${id.slice(-2)}`,
    prompt: '',
    status,
    createdAt: new Date(slotAtMs).toISOString(),
    lastActivity: new Date(slotAtMs + minutes * 60_000).toISOString(),
    output: [],
    jsonMessages: [],
    permissionMode: 'ignore',
    toolType: 'none',
    archived: false,
    isHidden: false,
    isFavorite: false,
  };
}

const sweepSlots = [0, 1, 2, 3, 4, 5].map(days => today3am.getTime() - days * DAY);
// The newest run was started by hand twelve minutes ago and is still working.
const manualRunAtMs = Date.now() - 12 * 60_000;
const seededSessions = [
  runSession('sweep-run-24', manualRunAtMs, 12, 'running'),
  runSession('sweep-run-22', sweepSlots[2], 41, 'stopped'),
  runSession('sweep-run-21', sweepSlots[3], 38, 'stopped'),
  runSession('sweep-run-20', sweepSlots[4], 35, 'stopped'),
];

const TRUST_WARNING = 'When it started, the run was stopped at the agent\'s folder-trust prompt in its new worktree.';

const seededLoops: Loop[] = [
  {
    id: 'loop-sweep',
    name: 'Nightly bug sweep',
    projectId: 1,
    cron: '0 3 * * *',
    toolCommand: 'agent-farm run greenfield/bug-sweep --since 24h',
    enabled: true,
    createdAtMs: sweepSlots[5],
    nextRunAtMs: today3am.getTime() + DAY,
    scheduleText: 'Daily at 3:00 AM',
    runs: [
      { id: 'r24', loopId: 'loop-sweep', slotAtMs: manualRunAtMs, trigger: 'manual', status: 'started', error: null, sessionId: 'sweep-run-24' },
      { id: 'r23', loopId: 'loop-sweep', slotAtMs: sweepSlots[1], trigger: 'schedule', status: 'failed', error: 'git worktree add failed: branch already exists', sessionId: null },
      { id: 'r22', loopId: 'loop-sweep', slotAtMs: sweepSlots[2], trigger: 'schedule', status: 'started', error: null, sessionId: 'sweep-run-22' },
      { id: 'r21', loopId: 'loop-sweep', slotAtMs: sweepSlots[3], trigger: 'schedule', status: 'started', error: TRUST_WARNING, sessionId: 'sweep-run-21' },
      { id: 'r20', loopId: 'loop-sweep', slotAtMs: sweepSlots[4], trigger: 'schedule', status: 'started', error: null, sessionId: 'sweep-run-20' },
      { id: 'r19', loopId: 'loop-sweep', slotAtMs: sweepSlots[5], trigger: 'schedule', status: 'skipped', error: 'Pane was not running, or the computer was asleep, when this run came due.', sessionId: null },
    ],
  },
  {
    id: 'loop-deps',
    name: 'Dependency check',
    projectId: 2,
    cron: '0 9 * * 1',
    agent: 'claude',
    initialInput: 'Check for outdated and vulnerable dependencies and open one PR per fix.',
    enabled: true,
    createdAtMs: sweepSlots[5],
    nextRunAtMs: today3am.getTime() + 3 * DAY + 6 * HOUR,
    scheduleText: 'Weekly on Monday at 9:00 AM',
    runs: [],
  },
  {
    id: 'loop-docs',
    name: 'Weekly docs audit',
    projectId: 1,
    cron: '0 16 * * 5',
    agent: 'codex',
    initialInput: 'Audit docs/ against the current CLI.',
    enabled: false,
    createdAtMs: sweepSlots[5],
    nextRunAtMs: null,
    scheduleText: 'Weekly on Friday at 4:00 PM',
    runs: [],
  },
];

for (const theme of ['light-rounded', 'dark'] as const) {
  test(`shows loops, their runs and a run Pane (${theme})`, async ({ page }) => {
    await open(page, {
      initialSessions: seededSessions,
      initialLoops: seededLoops,
      initialConfig: { theme, appearanceMode: 'fixed' },
      initialUiState: { expandedProjects: [1], repositoriesSectionExpanded: true },
    });
    const prefix = theme === 'dark' ? 'dark-' : '';

    await page.getByTestId('loops-nav').click();
    const detail = page.getByTestId('loop-detail');
    await expect(detail.getByRole('heading', { name: 'Nightly bug sweep' })).toBeVisible();
    await expect(detail).toContainText('2 ok · 1 with a warning · 1 failed');
    await expect(detail.getByRole('row').filter({ hasText: 'started with a warning' })).toContainText(TRUST_WARNING);
    await expect(page.getByTestId('loops-nav')).toContainText('3');
    await shoot(page, `${prefix}01-loops-page`);

    // Oldest first: skipped, ok, the warning, then the newest ok run in the fourth square.
    await detail.getByRole('group', { name: 'Last 10 runs' }).getByRole('button').nth(3).hover();
    await expect(page.getByText('Finished · loop-nightly-bug-sweep-22')).toBeVisible();
    await shoot(page, `${prefix}02-run-tooltip`);

    await page.getByTestId('loop-list-item').filter({ hasText: 'Weekly docs audit' }).click();
    await expect(detail.getByRole('button', { name: 'Resume' })).toBeVisible();
    await shoot(page, `${prefix}03-paused-loop`);

    await page.getByRole('button', { name: 'New loop' }).click();
    const drawer = page.getByRole('dialog');
    await drawer.getByLabel('Name').fill('Nightly bug sweep');
    await drawer.getByRole('radio', { name: 'Command' }).click();
    await drawer.getByLabel('Command').fill('agent-farm run greenfield/bug-sweep --since 24h');
    await chooseRepeat(page, 'Weekly on Monday');
    await drawer.getByRole('button', { name: 'Wednesday' }).click();
    await drawer.getByRole('button', { name: 'Friday' }).click();
    await expect(drawer.getByTestId('loop-schedule-preview')).toContainText('Weekly on Mon, Wed, Fri at 3:00 AM');
    await shoot(page, `${prefix}04-drawer-weekly`);
    await chooseRepeat(page, 'Monthly on day 1');
    await expect(drawer.getByTestId('loop-schedule-preview')).toContainText('cron: 0 3 1 * *');
    await shoot(page, `${prefix}05-drawer-monthly`);
    await chooseRepeat(page, 'Custom cron');
    await drawer.getByLabel('Cron', { exact: true }).fill('*/15 * * * *');
    await expect(drawer.getByRole('button', { name: 'Save' })).toBeDisabled();
    await shoot(page, `${prefix}06-drawer-custom-cron-error`);
    await drawer.getByRole('button', { name: 'Cancel' }).click();

    // A saved weekly cron opens in the Weekly picker.
    await page.getByTestId('loop-list-item').filter({ hasText: 'Weekly docs audit' }).click();
    await detail.getByRole('button', { name: 'Edit' }).click();
    await expect(drawer.getByRole('combobox', { name: 'Repeat' })).toHaveText('Weekly on Friday');
    await expect(drawer.getByRole('button', { name: 'Friday' })).toHaveAttribute('aria-pressed', 'true');
    await expect(drawer.getByLabel('At', { exact: true })).toHaveValue('16:00');
    await shoot(page, `${prefix}07-drawer-edit-weekly`);
    await drawer.getByRole('button', { name: 'Cancel' }).click();

    await page.getByTestId('loop-list-item').filter({ hasText: 'Nightly bug sweep' }).click();
    await detail.getByRole('button', { name: 'Edit' }).click();
    await expect(drawer.getByLabel('Command')).toHaveValue('agent-farm run greenfield/bug-sweep --since 24h');
    await expect(drawer.getByRole('combobox', { name: 'Repeat' })).toHaveText('Daily');
    await drawer.getByRole('button', { name: 'Delete loop' }).click();
    await expect(drawer.getByText('Delete this loop? Its run Panes stay.')).toBeVisible();
    await shoot(page, `${prefix}08-drawer-edit-delete-confirm`);
    await drawer.getByRole('button', { name: 'Keep' }).click();
    await drawer.getByRole('button', { name: 'Cancel' }).click();

    await detail.getByRole('button', { name: /^Open run / }).first().click();
    const header = page.getByTestId('loop-run-header');
    await expect(page.getByTestId('loop-runs-rail').getByRole('button')).toHaveCount(6);
    await expect(page.getByRole('button', { name: 'Show details' })).toBeVisible();
    await shoot(page, `${prefix}09-run-pane`);

    // The rail switches between runs without leaving the run Pane.
    await page.getByTestId('loop-runs-rail').getByRole('button').nth(2).click();
    await expect(header.getByRole('navigation', { name: 'Breadcrumb' })).toContainText(new Date(sweepSlots[2]).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }));
    await expect(page.getByTestId('loop-runs-rail').getByRole('button').nth(2)).toHaveAttribute('aria-current', 'page');

    // Opening the inspector in one run Pane keeps it open in the next.
    await page.getByRole('button', { name: 'Show details' }).click();
    await page.getByTestId('loop-runs-rail').getByRole('button').nth(3).click();
    await expect(page.getByRole('button', { name: 'Hide details' })).toBeVisible();
  });
}
