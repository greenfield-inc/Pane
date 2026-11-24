import { expect, test, type Page } from '@playwright/test';
import { gotoApp } from './electronApiMock';
import { installSessionsFixture, sessionFixture } from './orchestrationSessionsFixture';
import type { TodoAttachment, TodoDetail, TodoListRow, TodoRecord, TodosSnapshot } from '../shared/types/todos';

// T-51 PR 3 (W8 to W10), renderer only: this computer and the saved machine "mini" each have a T-5, and they are
// different to-dos. The open to-do page, its remembered layout and its "Open its Session" belong to the machine the
// page was read from, never to whichever machine has the same number.

const now = new Date(0).toISOString();
const MINI = 'mini';
const MINI_SESSION = 'mini-receipts';
const SHOTS = process.env.T51_SHOTS_DIR;
const SPLIT_HIDDEN_KEY = 'pane-todo-split-hidden:v1';

function todo(number: number, title: string, sessionId: string | null): TodoRecord {
  return {
    number, ref: `T-${number}`, sessionId, parentNumber: null, title, summary: '', doneWhen: [], state: 'in_progress',
    requester: { kind: 'person', name: 'you' }, projectId: 1, agent: 'claude', assignee: null, createdBy: 'you', createdAt: 0, startedAt: 0,
    updatedAt: number, acceptedAt: null, closedAt: null, lastProgressAt: 0, stuckSince: null, episodeReminders: 0, episodeRestarts: 0,
    stallsToday: 0, stallsDay: null, attachRemindedAt: null, workMs: 0, loadHold: null, loadHoldSince: null, loadOverride: null, stuckCardId: null,
  };
}

const working = { status: 'working' as const, reason: '' };
const localFive: TodoListRow = { todo: todo(5, 'Invoice PDFs', null), status: working, machine: 'This Mac' };
const miniFive: TodoListRow = { todo: todo(5, 'Receipts export', MINI_SESSION), status: working, machine: 'tylers-mac-mini' };
const snapshotOf = (machine: string, rows: TodoListRow[]): TodosSnapshot => ({ rows, gate: { state: 'normal', enabled: true, since: 0 }, machine, ownSessionIds: [] });
const local = snapshotOf('This Mac', [localFive]);
const mini = snapshotOf('tylers-mac-mini', [miniFive]);

function plan(path: string): TodoAttachment {
  return { id: 1, todoNumber: 5, kind: 'plan', label: 'Plan', target: path, addedBy: 'planner', source: 'attached', addedAt: 0 };
}

/** A to-do's page as main sends it, with one plan so it has a split. */
function detail(row: TodoListRow, planPath: string): TodoDetail {
  return {
    ...row, subTodos: [], attachments: [{ attachments: [plan(planPath)] }], activity: [], approvalIds: [],
    chatTarget: { panelId: null, name: 'orchestrator', kind: 'orchestrator' }, load: { gate: 'normal', canPause: true }, keepMoving: '',
  };
}
const localDetails = { 5: detail(localFive, '/tmp/local/plan.md') };
const miniDetails = { 5: detail(miniFive, '/tmp/mini/plan.md') };

async function open(page: Page): Promise<void> {
  await installSessionsFixture(page, [sessionFixture(MINI_SESSION, 'Receipts export', '', '', now)], [], {
    computers: [{ id: MINI, label: 'tylers-mac-mini', routes: [{ id: 'public:http://mini.test:7777', kind: 'public', source: 'manual', baseUrl: 'http://mini.test:7777', token: 'token' }] }],
    initialConfig: { theme: 'light-rounded', appearanceMode: 'fixed' },
    todos: { snapshot: local, details: localDetails },
    machineConnections: {
      machines: [{ id: 'local', label: 'This computer', kind: 'local', status: 'online', offlineSince: null, installId: 'here-install' }],
      reads: {},
    },
  });
  await page.setViewportSize({ width: 1440, height: 900 });
  await gotoApp(page);
}

async function openTodos(page: Page): Promise<void> {
  if (!(await page.getByTestId('todos-list').isVisible())) await page.getByTestId('todos-nav').first().click();
  await expect(page.getByTestId('todos-view')).toBeVisible();
}

async function openFive(page: Page, title: string): Promise<void> {
  await openTodos(page);
  await page.locator('[data-testid="todo-row"][data-todo="5"]').filter({ hasText: title }).first().click();
  await expect(page.getByTestId('todo-page-title')).toHaveText(title);
}

/** Main switches this window to the mini (the mock stands in for it): its to-dos are the list now. */
async function switchToMini(page: Page): Promise<void> {
  await page.evaluate((todos) => window.__paneTestElectronMock.switchTodosHost('mini', todos), { snapshot: mini, details: miniDetails });
}

const splitMemory = (page: Page) => page.evaluate((key) => Object.keys(JSON.parse(window.localStorage.getItem(key) ?? '{}')).sort(), SPLIT_HIDDEN_KEY);

test('T-51 test 7: switching computers with T-5 open closes this computer\'s T-5, and never reloads it as the mini\'s', async ({ page }) => {
  await open(page);
  await openFive(page, 'Invoice PDFs');
  await switchToMini(page);
  // The list is the mini's now; this computer's T-5 page closed rather than turning into the mini's T-5.
  await expect(page.locator('[data-testid="todo-row"][data-todo="5"]').filter({ hasText: 'Receipts export' })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId('todo-page')).toHaveCount(0);
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/t55-switched-list.png` });
  // Opening the mini's T-5 shows the mini's.
  await openFive(page, 'Receipts export');
});

test('T-51 W9: the mini\'s T-5 keeps its own layout, not this computer\'s T-5\'s', async ({ page }) => {
  await open(page);
  await openFive(page, 'Invoice PDFs');
  await page.getByTestId('todo-split-toggle').click();
  await expect(page.getByTestId('todo-page-split')).toHaveCount(0);
  expect(await splitMemory(page)).toEqual(['local:5']);
  await page.getByTestId('todo-page-back').click();

  await switchToMini(page);
  await openFive(page, 'Receipts export');
  // This computer's T-5 hid its split; the mini's T-5 never did.
  await expect(page.getByTestId('todo-page-split')).toBeVisible();
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/t55-mini-five-layout.png` });
  await page.getByTestId('todo-split-toggle').click();
  await expect(page.getByTestId('todo-page-split')).toHaveCount(0);
  expect(await splitMemory(page)).toEqual(['local:5', 'mini:5']);
});

test('T-51 W10: "Open its Session" on the mini\'s T-5, while switched to the mini, opens the mini\'s Session there', async ({ page }) => {
  await open(page);
  await switchToMini(page);
  await openFive(page, 'Receipts export');
  await page.getByTestId('todo-chip-agents').click();
  await expect(page.locator(`[data-session-content-id="${MINI_SESSION}"]`)).toBeVisible({ timeout: 15_000 });
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/t55-open-its-session.png` });
  // Nothing was left for this computer to open: the window stays on the mini.
  expect(await page.evaluate(() => window.__paneTestElectronMock.getNavigationMemory(null))).toBeNull();
});
