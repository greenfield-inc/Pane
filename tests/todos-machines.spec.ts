import { expect, test, type Page } from '@playwright/test';
import { installElectronApiMock } from './electronApiMock';
import type { MachineState } from '../shared/types/machineConnections';
import type { TodoListRow, TodoRecord, TodosSnapshot } from '../shared/types/todos';

// T-8 (round 8): a to-do is listed once, even when a saved machine is this computer read over a connection.
const NOW = Date.now();

function row(number: number, title: string): TodoListRow {
  const todo: TodoRecord = {
    number, ref: `T-${number}`, sessionId: null, parentNumber: null, title, summary: '', doneWhen: [], state: 'todo',
    requester: { kind: 'person', name: 'you' }, projectId: 1, agent: 'claude', assignee: null, createdBy: 'you', createdAt: NOW, startedAt: null,
    updatedAt: NOW, acceptedAt: null, closedAt: null, lastProgressAt: NOW, stuckSince: null, episodeReminders: 0, episodeRestarts: 0, stallsToday: 0,
    stallsDay: null, attachRemindedAt: null, workMs: 0, loadHold: null, loadHoldSince: null, loadOverride: null, stuckCardId: null,
  };
  return { todo, status: { status: 'idle', reason: 'not started' }, sessionName: null, projectName: 'Pane', machine: 'tylers-mac-mini' };
}

const snapshot: TodosSnapshot = { rows: [row(6, 'To-dos text and rows are too small'), row(7, 'Sessions made for a to-do briefly appear')], machine: 'tylers-mac-mini', ownSessionIds: [], gate: { state: 'normal', enabled: true, since: NOW } };
const devbox: TodosSnapshot = { ...snapshot, rows: [row(1, 'Rotate the deploy keys')], machine: 'devbox' };
const machine = (id: string, label: string, installId: string): MachineState => ({ id, label, kind: 'remote', status: 'online', offlineSince: null, installId });

async function open(page: Page) {
  await installElectronApiMock(page, {
    computers: [{ id: 'devbox', label: 'devbox', routes: [{ id: 'public:http://devbox.test:7777', kind: 'public', source: 'manual', baseUrl: 'http://devbox.test:7777', token: 'token' }] }],
    initialProjects: [], initialSessions: [], initialConfig: { theme: 'light-rounded', appearanceMode: 'fixed' },
    todos: { snapshot },
    machineConnections: {
      machines: [{ id: 'local', label: 'This computer', kind: 'local', status: 'online', offlineSince: null, installId: 'mini-1' }, machine('self', 'tylers-mac-mini', 'mini-1'), machine('devbox', 'devbox', 'box-9')],
      reads: { self: { 'todos:snapshot': { success: true, data: snapshot } }, devbox: { 'todos:snapshot': { success: true, data: devbox } } },
    },
  });
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await page.getByTestId('todos-nav').first().click();
}

test('T-8: this computer saved as a machine lists its to-dos once; another machine\'s still show', async ({ page }) => {
  await open(page);
  // The other machine's to-do arrives, so every read has landed.
  await expect(page.locator('[data-testid="todo-row"][data-machine="devbox"]')).toHaveCount(1);
  await expect(page.locator('[data-testid="todo-row"][data-todo="6"]')).toHaveCount(1);
  await expect(page.locator('[data-testid="todo-row"][data-todo="7"]')).toHaveCount(1);
  await expect(page.locator('[data-testid="todo-row"]')).toHaveCount(3);
  await expect(page.locator('[data-testid="todo-row"][data-machine="self"]')).toHaveCount(0);
});

test('T-18: another machine\'s to-do opens there: the window switches to it with the to-do remembered', async ({ page }) => {
  await open(page);
  const row = page.locator('[data-testid="todo-row"][data-machine="devbox"]');
  await expect(row).toHaveCount(1);
  await row.hover();
  await expect(row.getByTestId('todo-row-open')).toHaveText(/Open on devbox/);
  await row.click();
  await expect.poll(() => page.evaluate(() => window.__paneTestElectronMock.getNavigationMemory('devbox'))).toMatchObject({ view: 'todos', todoNumber: 1 });
});
