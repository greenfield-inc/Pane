import { expect, test, type Page } from '@playwright/test';
import { installElectronApiMock } from './electronApiMock';
import { DEFAULT_NOTIFY_SETTINGS, type NotifyItem, type NotifySnapshot } from '../shared/types/notify';
import type { TodoListRow, TodoRecord, TodosSnapshot } from '../shared/types/todos';

// T-24, renderer only: a Session's to-dos' approvals dock above its chat with its own, each naming its to-do,
// in one pager with Dismiss; one answered anywhere leaves the dock.

const now = new Date(0).toISOString();
const project = { id: 81, name: 'Approvals fixture', path: '/tmp/approvals-fixture', active: true, created_at: now, updated_at: now };
const session = { id: 's1', name: 'Billing rewrite', paneId: 'session-pane' };
const HIDDEN = 'todo-session-3';
const pane = {
  id: 'session-pane', name: 'billing-orchestrator', worktreePath: '/tmp/approvals-fixture/session-pane', prompt: '', status: 'stopped', createdAt: now, lastActivity: now,
  output: [], jsonMessages: [], isRunning: false, permissionMode: 'ignore', projectId: project.id, displayOrder: 0,
  isFavorite: false, toolType: 'none', archived: false,
  gitStatus: { state: 'clean', ahead: 0, behind: 0, hasUncommittedChanges: false, hasUntrackedFiles: false, filesChanged: 0 },
};
const panels = [{
  id: 'chat', sessionId: 'session-pane', type: 'chat', title: 'Claude',
  state: { isActive: true, hasBeenViewed: true, customState: { agent: 'claude', launch: { kind: 'new' }, cwd: pane.worktreePath, status: 'idle', orchestrationSessionId: session.id } },
  metadata: { createdAt: now, lastActiveAt: now, position: 0 },
}];

function todo(number: number, title: string, sessionId: string): TodoRecord {
  return {
    number, ref: `T-${number}`, sessionId, parentNumber: null, title, summary: '', doneWhen: [], state: 'in_review',
    requester: { kind: 'orchestrator', name: 'Billing rewrite orchestrator', sessionId: session.id, panelId: 'chat' }, projectId: project.id, agent: 'claude',
    assignee: null, createdBy: 'Billing rewrite orchestrator', createdAt: 0, startedAt: 0, updatedAt: 0, acceptedAt: null, closedAt: null, lastProgressAt: 0,
    stuckSince: null, episodeReminders: 0, episodeRestarts: 0, stallsToday: 0, stallsDay: null, attachRemindedAt: null, workMs: 0, loadHold: null,
    loadHoldSince: null, loadOverride: null, stuckCardId: null,
  };
}

const rows: TodoListRow[] = [{ todo: todo(3, 'Pane Selection', HIDDEN), status: { status: 'waiting', reason: 'Review T-3' }, machine: 'This Mac' }];
const todos: TodosSnapshot = { rows, gate: { state: 'normal', enabled: true, since: 0 }, machine: 'This Mac', ownSessionIds: [HIDDEN] };

const review: NotifyItem = {
  id: 'review-3', ui: 'options', title: 'Review T-3: Pane Selection', state: 'waiting', createdAt: Date.now() - 3 * 60_000, originKind: 'pane',
  context: 'Root cause found; findings attached.', choices: [{ label: 'Accept' }, { label: 'Ask for changes' }],
  source: { name: 'T-3', agent: 'Pane', session: { id: HIDDEN, name: 'T-3 · Pane Selection', paneId: 'hidden-pane' } }, todo: { number: 3, title: 'Pane Selection', kind: 'review' },
};
const prompt: NotifyItem = {
  id: 'perm-3', ui: 'options', title: 'Allow pkill -f vite?', state: 'waiting', createdAt: Date.now() - 2 * 60_000, originKind: 'claude-prompt',
  choices: [{ label: 'Allow' }, { label: 'Deny' }],
  source: { paneId: 'hidden-pane', panelId: 'hidden-chat', name: 'T-3 · Pane Selection', agent: 'Claude', session: { id: HIDDEN, name: 'T-3 · Pane Selection', paneId: 'hidden-pane', orchestrator: true } },
};
const own: NotifyItem = {
  id: 'q45', ui: 'options', title: 'Q-45: Show the version badge in the web footer too?', state: 'waiting', createdAt: Date.now() - 60_000, originKind: 'worker',
  choices: [{ label: 'Yes' }, { label: 'No' }], source: { paneId: 'worker-pane', panelId: 'worker-panel', name: 'p2-review', agent: 'Claude', session },
};

function snapshot(items: NotifyItem[]): NotifySnapshot {
  return {
    settings: { ...DEFAULT_NOTIFY_SETTINGS }, items, queue: items.filter(item => item.state === 'waiting').map(item => item.id), hidden: [], strip: null, stripSurface: null,
    pausedUntil: null, shortcutRegistered: true, showOutsideSupported: true, firstRun: false, instructionFiles: [],
  };
}

type MockWindow = typeof window & { __paneTestElectronMock: { emitNotifySnapshot(snapshot: NotifySnapshot): void } };

async function openChat(page: Page, items: NotifyItem[]): Promise<void> {
  await installElectronApiMock(page, { initialProjects: [project], initialSessions: [pane], initialPanels: panels, activeProjectId: project.id, notifySnapshot: snapshot(items), todos: { snapshot: todos, details: {} } });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');
  await page.getByRole('button', { name: 'Expand project Approvals fixture', exact: true }).click();
  await page.getByRole('button', { name: 'billing-orchestrator', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Message Claude' })).toBeVisible();
}

const card = (page: Page) => page.getByTestId('session-approval-card');
const meta = (page: Page) => card(page).getByTestId('session-approval-card-meta');

test('T-24: a Session\'s to-dos\' approvals dock above its chat with its own, each naming its to-do', async ({ page }) => {
  await openChat(page, [review, prompt, own]);
  await expect(card(page)).toHaveCount(1);
  await expect(card(page).getByTestId('session-approval-card-pager')).toHaveText('1 of 3');
  // Newest first (T-88): Q-45, then the prompt from T-3's hidden Session (it names T-3 and its
  // orchestrator), then the review (it names T-3 once).
  await expect(card(page).getByTestId('session-approval-card-title')).toHaveText('Q-45: Show the version badge in the web footer too?');
  await expect(meta(page)).not.toContainText('T-3');
  await card(page).getByTestId('session-approval-card-next').click();
  await expect(card(page).getByTestId('session-approval-card-title')).toHaveText('Allow pkill -f vite?');
  await expect(meta(page)).toContainText('T-3 · orchestrator');
  await expect(meta(page)).not.toContainText('Pane Selection orchestrator');
  await card(page).getByTestId('session-approval-card-next').click();
  await expect(card(page).getByTestId('session-approval-card-title')).toHaveText('Review T-3: Pane Selection');
  await expect(meta(page)).toContainText('T-3');
  await expect(meta(page)).not.toContainText('T-3 · T-3');
  // Dismiss leaves it waiting in Approvals; the pager drops it.
  await card(page).getByRole('button', { name: 'Dismiss' }).click();
  await expect(card(page).getByTestId('session-approval-card-pager')).toHaveText(/of 2$/);
  // Answered anywhere: it leaves the dock.
  // SAFETY: installElectronApiMock installs these test-only IPC controls on the page.
  await page.evaluate((next) => (window as MockWindow).__paneTestElectronMock.emitNotifySnapshot(next), snapshot([review, prompt, { ...own, state: 'answered' }]));
  await expect(card(page).getByTestId('session-approval-card-pager')).toHaveText('1 of 1');
  await expect(card(page).getByTestId('session-approval-card-title')).toHaveText('Allow pkill -f vite?');
});
