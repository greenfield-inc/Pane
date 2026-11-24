import { expect, test, type Page } from '@playwright/test';
import { gotoApp } from './electronApiMock';
import { installSessionsFixture, sessionFixture } from './orchestrationSessionsFixture';
import { DEFAULT_NOTIFY_SETTINGS, type NotifyItem, type NotifySnapshot } from '../shared/types/notify';
import type { MachineState } from '../shared/types/machineConnections';
import type { TodoListRow, TodoRecord, TodosSnapshot } from '../shared/types/todos';

// T-51, renderer only: two machines each have a T-28, and they are different to-dos. The MacBook's Q-84 is linked to
// the MacBook's T-28; this computer's Session "Firecracker Grain" owns T-27, whose sub-to-do is this computer's T-28.
// Before the fix, Q-84 docked in Firecracker Grain's chat, counted on its row and opened with ⌥⌘A.

const now = new Date(0).toISOString();
const FIRECRACKER = 'firecracker';
const HIDDEN = '__orchestration_session_todo27__';
const MACBOOK = 'macbook';
const MACBOOK_LABEL = 'tylers-macbook-pro';
const SHOTS = process.env.T51_SHOTS_DIR;

// The Session's chat, where the dock sits above the composer.
const chat = {
  id: `__orchestration_panel_${FIRECRACKER}_claude`, sessionId: `__orchestration_session_${FIRECRACKER}terminal__`, type: 'chat', title: 'Firecracker Grain · Claude Code',
  state: { isActive: true, hasBeenViewed: true, customState: { agent: 'claude', launch: { kind: 'new' }, cwd: '/tmp/pane-fixtures', status: 'idle', orchestrationSessionId: FIRECRACKER } },
  metadata: { createdAt: now, lastActiveAt: now, position: 0 },
};

function todo(number: number, title: string, opts: { sessionId?: string; parent?: number; requestedBy?: string }): TodoRecord {
  return {
    number, ref: `T-${number}`, sessionId: opts.sessionId ?? null, parentNumber: opts.parent ?? null, title, summary: '', doneWhen: [], state: 'in_progress',
    requester: opts.requestedBy ? { kind: 'orchestrator', name: 'Firecracker Grain orchestrator', sessionId: opts.requestedBy, panelId: chat.id } : { kind: 'person', name: 'you' },
    projectId: 1, agent: 'claude', assignee: null, createdBy: 'you', createdAt: 0, startedAt: 0, updatedAt: number, acceptedAt: null, closedAt: null,
    lastProgressAt: 0, stuckSince: null, episodeReminders: 0, episodeRestarts: 0, stallsToday: 0, stallsDay: null, attachRemindedAt: null, workMs: 0,
    loadHold: null, loadHoldSince: null, loadOverride: null, stuckCardId: null,
  };
}

const working = { status: 'working' as const, reason: '' };
const localRows: TodoListRow[] = [
  { todo: todo(27, 'Firecracker Grain', { sessionId: HIDDEN, requestedBy: FIRECRACKER }), status: working, machine: 'This Mac' },
  { todo: todo(28, 'Accept Google Cloud’s HIPAA BAA', { parent: 27, requestedBy: FIRECRACKER }), status: working, machine: 'This Mac' },
];
const local: TodosSnapshot = { rows: localRows, gate: { state: 'normal', enabled: true, since: 0 }, machine: 'This Mac', ownSessionIds: [HIDDEN] };
const macbook: TodosSnapshot = {
  rows: [{ todo: todo(28, 'Phone-number sign-up, sign-in and invites', {}), status: { status: 'waiting', reason: 'Q-84' }, machine: 'Tylers-MacBook-Pro' }],
  gate: { state: 'normal', enabled: true, since: 0 }, machine: 'Tylers-MacBook-Pro', ownSessionIds: [],
};

const q84: NotifyItem = {
  id: `${MACBOOK}:q-84`, ui: 'options', title: 'Q-84: Phone-number accounts: which sign-up flow?', state: 'waiting', createdAt: Date.now() - 86_400_000, originKind: 'orchestrator',
  choices: [{ label: 'One flow' }, { label: 'Two flows' }], machineId: MACBOOK, machine: 'Tylers-MacBook-Pro',
  source: { name: 'Workspaces, Signup orchestrator', agent: 'Claude', session: { id: 'workspaces-signup', name: 'Workspaces, Signup', paneId: 'mbp-pane', orchestrator: true } },
  todo: { number: 28, title: 'Phone-number sign-up, sign-in and invites' },
};
const reminder: NotifyItem = {
  id: `${MACBOOK}:remind-28`, ui: 'options', title: 'Reminder: Phone-number sign-up', state: 'waiting', createdAt: Date.now() - 60_000, originKind: 'pane',
  choices: [{ label: 'Done' }, { label: 'Hand to an agent' }], machineId: MACBOOK, machine: 'Tylers-MacBook-Pro',
  source: { name: 'To-dos', agent: 'Pane' }, todo: { number: 28, title: 'Phone-number sign-up, sign-in and invites', kind: 'reminder' },
};

function snapshot(items: NotifyItem[]): NotifySnapshot {
  return {
    settings: { ...DEFAULT_NOTIFY_SETTINGS }, items, queue: items.map(item => item.id), hidden: [], strip: null, stripSurface: null,
    pausedUntil: null, shortcutRegistered: true, showOutsideSupported: true, firstRun: false, instructionFiles: [],
  };
}

const saved: MachineState = { id: MACBOOK, label: MACBOOK_LABEL, kind: 'remote', status: 'online', offlineSince: null, installId: 'mbp-install' };

async function open(page: Page, items: NotifyItem[]): Promise<void> {
  await installSessionsFixture(page, [sessionFixture(FIRECRACKER, 'Firecracker Grain', '', '', now)], [], {
    computers: [{ id: MACBOOK, label: MACBOOK_LABEL, routes: [{ id: 'public:http://mbp.test:7777', kind: 'public', source: 'manual', baseUrl: 'http://mbp.test:7777', token: 'token' }] }],
    initialConfig: { theme: 'light-rounded', appearanceMode: 'fixed' },
    notifySnapshot: snapshot(items),
    initialPanels: [chat],
    todos: { snapshot: local, details: {} },
    machineConnections: {
      machines: [{ id: 'local', label: 'This computer', kind: 'local', status: 'online', offlineSince: null, installId: 'mini-install' }, saved],
      reads: { [MACBOOK]: { 'todos:snapshot': { success: true, data: macbook } } },
    },
  });
  await page.setViewportSize({ width: 1440, height: 900 });
  await gotoApp(page);
}

/** ⌥⌘A on macOS; Ctrl+K, then Ctrl+A elsewhere. */
async function openSessionApprovalKey(page: Page): Promise<void> {
  if (await page.evaluate(() => navigator.platform.toUpperCase().includes('MAC'))) {
    await page.keyboard.press('Meta+Alt+KeyA');
    return;
  }
  await page.keyboard.press('Control+KeyK');
  await page.keyboard.press('Control+KeyA');
}

const row = (page: Page) => page.getByTestId(`orchestration-session-${FIRECRACKER}`);

test('T-51: the MacBook\'s Q-84 for its T-28 stays out of this computer\'s Session that owns another T-28, and shows in Approvals under the MacBook', async ({ page }) => {
  await open(page, [q84]);
  await row(page).click();
  await expect(page.locator(`[data-session-content-id="${FIRECRACKER}"]`)).toBeVisible({ timeout: 15_000 });
  // The card is listed (Approvals counts it), so its absence here is the fix, not a late snapshot.
  await expect(page.getByTestId('approvals-nav')).toContainText('1');
  await expect(page.getByTestId('session-approval-card')).toHaveCount(0);
  await expect(row(page).getByTestId('session-approvals-count')).toHaveCount(0);
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/t51-session-dock.png` });

  // ⌥⌘A from the Session's chat opens its approvals: here there are none.
  await openSessionApprovalKey(page);
  await expect(page.getByText('Nothing in this Session is waiting on you.')).toBeVisible();
  await expect(page.getByTestId('approval-column')).toHaveCount(0);

  await page.getByTestId('approvals-nav').click();
  const group = page.getByTestId('approvals-group').filter({ hasText: 'T-28' });
  await expect(group).toHaveCount(1);
  await expect(group).toContainText(`T-28 · ${MACBOOK_LABEL} · Phone-number sign-up`);
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/t51-approvals.png` });
});

test('T-51: a MacBook reminder\'s "Snooze to another time…" opens the MacBook\'s T-28, never this computer\'s', async ({ page }) => {
  await open(page, [reminder]);
  await page.getByTestId('approvals-nav').click();
  await page.getByTestId('approvals-row').filter({ hasText: 'Reminder: Phone-number sign-up' }).click();
  await page.getByTestId('approval-reminder-snooze').click();
  await expect.poll(() => page.evaluate((id) => window.__paneTestElectronMock.getNavigationMemory(id), MACBOOK)).toMatchObject({ view: 'todos', todoNumber: 28 });
  await expect(page.getByTestId('snooze-menu')).toHaveCount(0);
});
