import { expect, test, type Page } from '@playwright/test';
import { installElectronApiMock } from './electronApiMock';
import { DEFAULT_NOTIFY_SETTINGS, type NotifyItem, type NotifySnapshot } from '../shared/types/notify';
import type { TodoListRow, TodoRecord } from '../shared/types/todos';

// T-19 and T-22, renderer only: a Session that requested to-dos shows their waiting approvals on its sidebar row,
// including one asked inside a to-do's own hidden Session (a permission prompt) with no to-do link, each counted once.

const BILLING = '__orchestration_session_billing__';
const OTHER = '__orchestration_session_other__';
const HIDDEN = '__orchestration_session_todo3__';
const NOW = Date.UTC(2026, 10, 18, 22, 0);

const projects = [
  { id: 1, name: 'billing', path: '/tmp/billing', active: true, created_at: '2026-10-01T00:00:00.000Z', updated_at: '2026-10-01T00:00:00.000Z' },
];

function todo(number: number, sessionId: string, requestedBy: string): TodoRecord {
  return {
    number, ref: `T-${number}`, sessionId, parentNumber: null, title: 'Pane Selection', summary: '', doneWhen: [], state: 'in_review',
    requester: { kind: 'orchestrator', name: 'Billing rewrite orchestrator', sessionId: requestedBy, panelId: `${requestedBy}claude` }, projectId: 1, agent: 'claude',
    assignee: null, createdBy: 'Billing rewrite orchestrator', createdAt: NOW - 3_600_000, startedAt: NOW - 3_600_000, updatedAt: NOW, acceptedAt: null, closedAt: null,
    lastProgressAt: NOW, stuckSince: null, episodeReminders: 0, episodeRestarts: 0, stallsToday: 0, stallsDay: null, attachRemindedAt: null, workMs: 0,
    loadHold: null, loadHoldSince: null, loadOverride: null, stuckCardId: null,
  };
}

const rows: TodoListRow[] = [{ todo: todo(3, HIDDEN, BILLING), status: { status: 'waiting', reason: 'Review T-3' }, machine: 'This Mac', projectName: 'billing' }];

function approvals(): NotifySnapshot {
  const review: NotifyItem = {
    id: 'review-3', ui: 'options', title: 'Review T-3: Pane Selection', state: 'waiting', createdAt: NOW - 60_000,
    choices: [{ label: 'Accept' }, { label: 'Ask for changes' }],
    source: { name: 'T-3', agent: 'Pane', session: { id: HIDDEN, name: 'T-3 · Pane Selection' } }, todo: { number: 3, title: 'Pane Selection', kind: 'review' },
  };
  const prompt: NotifyItem = {
    id: 'perm-3', ui: 'options', title: 'Allow pkill -f vite?', state: 'waiting', createdAt: NOW - 30_000, choices: [{ label: 'Allow' }, { label: 'Deny' }],
    source: { name: 'T-3 · Pane Selection orchestrator', agent: 'Claude', session: { id: HIDDEN, name: 'T-3 · Pane Selection', orchestrator: true } },
  };
  return {
    settings: { ...DEFAULT_NOTIFY_SETTINGS }, items: [review, prompt], queue: ['review-3', 'perm-3'], hidden: [], strip: null, stripSurface: null,
    pausedUntil: null, shortcutRegistered: true, showOutsideSupported: true, firstRun: false, instructionFiles: [],
  };
}

function installSessions({ billing, other, hidden }: { billing: string; other: string; hidden: string }) {
  const at = new Date(0).toISOString();
  const record = (id: string, name: string, todoNumber?: number) => ({
    id, name, agent: 'claude', archived: false, isPinned: false, todoNumber,
    internalSessionId: `${id}terminal__`, panelIds: { claude: `${id}claude`, codex: `${id}codex`, cursor: `${id}cursor` },
    goal: '', context: '', decisions: [], blockers: [], nextAction: '', evidence: [], outputs: [], associations: [], activity: [],
    revision: 1, createdAt: at, updatedAt: at,
  });
  const sessions = [record(billing, 'Billing rewrite'), record(other, 'Onboarding'), record(hidden, 'T-3 · Pane Selection', 3)];
  const list = async () => ({ success: true, data: { sessions, selectedSessionId: billing } });
  Object.assign(window.electronAPI, { orchestrationSessions: { ...window.electronAPI.orchestrationSessions, list, select: list } });
}

async function open(page: Page) {
  await page.setViewportSize({ width: 1_440, height: 900 });
  await installElectronApiMock(page, {
    initialProjects: projects, initialSessions: [], initialConfig: { theme: 'light-rounded', appearanceMode: 'fixed' },
    notifySnapshot: approvals(),
    todos: { snapshot: { rows, gate: { state: 'normal', enabled: true, since: 0 }, machine: 'This Mac', ownSessionIds: [HIDDEN] }, details: {} },
  });
  await page.addInitScript(installSessions, { billing: BILLING, other: OTHER, hidden: HIDDEN });
  await page.goto('/', { waitUntil: 'domcontentloaded' });
}

test('the Session that requested a to-do counts its review and the permission prompt from its hidden Session, once each (T-19, T-22)', async ({ page }) => {
  await open(page);
  const billing = page.getByTestId(`orchestration-session-${BILLING}`);
  await expect(billing).toBeVisible({ timeout: 15_000 });
  await expect(billing.getByTestId('session-approvals-count')).toHaveText('2');
  await expect(page.getByTestId(`orchestration-session-${OTHER}`).getByTestId('session-approvals-count')).toHaveCount(0);
  // The to-do's own Session stays out of the list (T-7).
  await expect(page.getByTestId(`orchestration-session-${HIDDEN}`)).toHaveCount(0);
});
