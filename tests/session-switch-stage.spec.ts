import { expect, test, type Page } from '@playwright/test';
import { installElectronApiMock } from './electronApiMock';
import { selectFirstLine, xtermEvaluate } from './terminalXterm';

// Switching panes inside a repo tears down the outgoing session's terminals and
// mounts the incoming session's, so whatever the stage shows between those two
// states is the switch's visible cost. Two things are pinned here: the switch
// issues one panel read (not the historical two) with the layout read alongside
// it, and the "Open" launcher is never used as a stand-in for a stage whose
// layout is still in flight.

const now = new Date(0).toISOString();
const project = {
  id: 720,
  name: 'Switch fixture',
  path: '/tmp/switch-fixture',
  active: true,
  created_at: now,
  updated_at: now,
};

const makeSession = (id: string, name: string, displayOrder: number) => ({
  id,
  name,
  worktreePath: `${project.path}/${id}`,
  prompt: '',
  status: 'stopped',
  createdAt: now,
  lastActivity: now,
  output: [],
  jsonMessages: [],
  isRunning: false,
  permissionMode: 'ignore',
  projectId: project.id,
  displayOrder,
  isFavorite: false,
  toolType: 'none',
  archived: false,
  gitStatus: { state: 'clean', ahead: 0, behind: 0, hasUncommittedChanges: false, hasUntrackedFiles: false, filesChanged: 0 },
});

const sessionA = makeSession('switch-a', 'Pane A', 0);
const sessionB = makeSession('switch-b', 'Pane B', 1);
const sessionEmpty = makeSession('switch-empty', 'Pane Empty', 2);

const terminalPanel = (id: string, sessionId: string, title: string, position: number, isActive: boolean, permanent = false) => ({
  id,
  sessionId,
  type: 'terminal',
  title,
  state: { isActive, hasBeenViewed: true, customState: { isInitialized: true } },
  metadata: { createdAt: now, lastActiveAt: now, position, permanent },
});

// The first terminal of a session is its pinned dock terminal and stays out of
// the layout tree, so each session's stage tabs are the ones after it.
const dockA = terminalPanel('switch-a-dock', sessionA.id, 'Terminal', 0, false, true);
const alpha = terminalPanel('switch-a-alpha', sessionA.id, 'Alpha', 1, true);
const dockB = terminalPanel('switch-b-dock', sessionB.id, 'Terminal', 0, false, true);
// Beta second carries the persisted active flag: the switch has to honour the
// stored selection rather than falling back to the first working tab.
const betaFirst = terminalPanel('switch-b-first', sessionB.id, 'Beta first', 1, false);
const betaSecond = terminalPanel('switch-b-second', sessionB.id, 'Beta second', 2, true);

const allPanels = [dockA, alpha, dockB, betaFirst, betaSecond];

const scrollback = (prefix: string) => Array.from({ length: 10 }, (_, i) => `${prefix}-${i}`).join('\r\n') + '\r\n';

interface StageMock {
  getInvokeCalls(channel: string): Array<{ channel: string; args: unknown[]; at: number }>;
}

declare global {
  interface Window {
    __emptyStageAppearances?: number[];
  }
}

// A poll can miss a launcher that shows for one frame; an observer cannot.
async function installEmptyStageRecorder(page: Page): Promise<void> {
  await page.addInitScript(() => {
    window.__emptyStageAppearances = [];
    const record = () => window.__emptyStageAppearances?.push(performance.now());
    const scan = (node: Node) => {
      if (!(node instanceof Element)) return;
      if (node.matches('[data-testid="empty-stage"]')) record();
      for (const _ of node.querySelectorAll('[data-testid="empty-stage"]')) record();
    };
    new MutationObserver((records) => {
      for (const record of records) {
        for (const node of record.addedNodes) scan(node);
      }
    }).observe(document, { childList: true, subtree: true });
  });
}

async function callsFor(page: Page, channel: string, sessionId: string): Promise<Array<{ at: number }>> {
  return page.evaluate(({ channel, sessionId }) => {
    // SAFETY: installElectronApiMock defines this test-only bridge before the page loads.
    const mock = (window as typeof window & { __paneTestElectronMock: StageMock }).__paneTestElectronMock;
    return mock.getInvokeCalls(channel)
      .filter((call) => call.args[0] === sessionId)
      .map((call) => ({ at: call.at }));
  }, { channel, sessionId });
}

async function boot(page: Page, panelLoadDelayMs = 0): Promise<void> {
  await installEmptyStageRecorder(page);
  await installElectronApiMock(page, {
    platform: 'darwin',
    initialProjects: [project],
    initialSessions: [sessionA, sessionB, sessionEmpty],
    initialPanels: allPanels,
    initialLayout: null,
    initialTerminalStates: Object.fromEntries(
      allPanels.map((panel) => [panel.id, { scrollbackBuffer: scrollback(panel.id) }]),
    ),
    activeProjectId: project.id,
    panelLoadDelayMs,
  });
  await page.goto('/', { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await page.getByRole('button', { name: /^Expand repository Switch fixture$/ }).click();
}

async function openSession(page: Page, name: string): Promise<void> {
  await page.getByRole('button', { name, exact: true }).click();
}

test('a pane switch reads the panel list once and fetches the layout alongside it', async ({ page }) => {
  await boot(page, 250);
  await openSession(page, sessionA.name);
  await expect(page.getByRole('tabpanel', { name: alpha.title }).locator('.xterm-screen')).toBeVisible({ timeout: 15_000 });

  await openSession(page, sessionB.name);
  await expect(page.getByRole('tabpanel', { name: betaSecond.title }).locator('.xterm-screen')).toBeVisible({ timeout: 15_000 });

  // One read, not the two the old getActivePanel round trip made.
  const panelReads = await callsFor(page, 'panels:getSessionPanels', sessionB.id);
  expect(panelReads).toHaveLength(1);

  // Head-to-tail would put the layout read a full delay after the panel read.
  const layoutReads = await callsFor(page, 'panels:get-layout', sessionB.id);
  expect(layoutReads).toHaveLength(1);
  expect(Math.abs(layoutReads[0].at - panelReads[0].at)).toBeLessThan(250);
});

test('the Open launcher never stands in for a stage that is still loading', async ({ page }) => {
  await boot(page, 600);
  await openSession(page, sessionA.name);
  await expect(page.getByRole('tabpanel', { name: alpha.title }).locator('.xterm-screen')).toBeVisible({ timeout: 15_000 });

  await page.evaluate(() => { window.__emptyStageAppearances = []; });

  await openSession(page, sessionB.name);
  // The whole switch, including the 600 ms the two reads are in flight.
  await expect(page.getByRole('tabpanel', { name: betaSecond.title }).locator('.xterm-screen')).toBeVisible({ timeout: 15_000 });

  const appearances = await page.evaluate(() => window.__emptyStageAppearances ?? []);
  expect(appearances).toHaveLength(0);
});

test('a pane that genuinely has no tools still gets the Open launcher', async ({ page }) => {
  await boot(page, 150);
  await openSession(page, sessionA.name);
  await expect(page.getByRole('tabpanel', { name: alpha.title }).locator('.xterm-screen')).toBeVisible({ timeout: 15_000 });

  await openSession(page, sessionEmpty.name);
  await expect(page.getByTestId('empty-stage')).toBeVisible({ timeout: 15_000 });
  // The launcher rows carry their shortcut in the accessible name.
  await expect(page.getByTestId('empty-stage').getByRole('button', { name: /^Terminal/ })).toBeVisible();
});

test('a switch honours the persisted active tab rather than the first working tab', async ({ page }) => {
  await boot(page);
  await openSession(page, sessionA.name);
  await expect(page.getByRole('tabpanel', { name: alpha.title }).locator('.xterm-screen')).toBeVisible({ timeout: 15_000 });

  await openSession(page, sessionB.name);
  await expect(page.getByRole('tab', { name: betaSecond.title, exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('tab', { name: betaFirst.title, exact: true })).toHaveAttribute('aria-selected', 'false');
  await expect(page.getByRole('tabpanel', { name: betaSecond.title }).locator('.xterm-screen')).toBeVisible();
});

test('switching back to a loaded pane restores its stage without a launcher frame', async ({ page }) => {
  await boot(page, 400);
  await openSession(page, sessionA.name);
  await expect(page.getByRole('tabpanel', { name: alpha.title }).locator('.xterm-screen')).toBeVisible({ timeout: 15_000 });
  await openSession(page, sessionB.name);
  await expect(page.getByRole('tabpanel', { name: betaSecond.title }).locator('.xterm-screen')).toBeVisible({ timeout: 15_000 });

  await page.evaluate(() => { window.__emptyStageAppearances = []; });

  await openSession(page, sessionA.name);
  await expect(page.getByRole('tabpanel', { name: alpha.title }).locator('.xterm-screen')).toBeVisible({ timeout: 15_000 });

  const appearances = await page.evaluate(() => window.__emptyStageAppearances ?? []);
  expect(appearances).toHaveLength(0);
});

test('a failed panel read settles the stage on the launcher instead of leaving it blank', async ({ page }) => {
  await installEmptyStageRecorder(page);
  await installElectronApiMock(page, {
    platform: 'darwin',
    initialProjects: [project],
    initialSessions: [sessionA, sessionB, sessionEmpty],
    initialPanels: allPanels,
    initialLayout: null,
    activeProjectId: project.id,
    panelLoadErrorBySessionId: { [sessionB.id]: 'panel read failed' },
  });
  await page.goto('/', { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await page.getByRole('button', { name: /^Expand repository Switch fixture$/ }).click();

  await openSession(page, sessionB.name);
  await expect(page.getByTestId('empty-stage')).toBeVisible({ timeout: 15_000 });
});

test('a selection made when the activation mask lifts survives the delayed backstop', async ({ page }) => {
  // The mask has to outlast REFOCUS_DELAYED_REFRESH_MS, not just the first
  // paint: that backstop re-runs the full reset+replay, and reset() drops the
  // selection. Lifting the mask on an early settle exposes a terminal the user
  // can select in ~270 ms before it is wiped under them.
  await boot(page);
  await openSession(page, sessionA.name);
  await expect(page.getByRole('tabpanel', { name: alpha.title }).locator('.xterm-screen')).toBeVisible({ timeout: 15_000 });

  await openSession(page, sessionB.name);
  const panel = page.getByRole('tabpanel', { name: betaSecond.title });
  await expect(panel.locator('.xterm-screen')).toBeVisible({ timeout: 15_000 });
  await expect(panel.getByTestId('terminal-activation-mask')).toHaveCount(0, { timeout: 15_000 });

  await selectFirstLine(panel.locator('.xterm').first());
  const selected = await xtermEvaluate(panel.locator('.xterm').first(), (terminal) => terminal.getSelection());
  expect(selected.trim().length).toBeGreaterThan(0);

  // Past the delayed backstop, with margin.
  await page.waitForTimeout(1200);

  const afterBackstop = await xtermEvaluate(panel.locator('.xterm').first(), (terminal) => terminal.getSelection());
  expect(afterBackstop).toEqual(selected);
});
