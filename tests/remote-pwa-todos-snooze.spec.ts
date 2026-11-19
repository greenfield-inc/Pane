import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import type { NotifyItem, NotifySharedState } from '../shared/types/notify';
import type { TodoAction, TodoDetail, TodoListRow, TodoRecord, TodoSnooze, TodosSnapshot } from '../shared/types/todos';
import type { JsonValue } from '../shared/validation/boundaryDecoder';
import { emitRemoteHostEvent, openConnectedRemotePwa } from './remotePwaMock';

// To-dos round 9 in the web app (P5, S16 and S23): the Snoozed group and folding headers, the ⋯ menu's snooze sheet
// with the phone's own date and time input, and a reminder card full screen with back. Stills in PANE_PWA_TODO_STILLS.

test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, timezoneId: 'America/Los_Angeles' });

const ZONE = 'America/Los_Angeles';
const NOW = Date.parse('2026-11-17T15:11:30-08:00');
const WED_9 = Date.parse('2026-11-18T09:00:00-08:00');
const MIN = 60_000;
const STILLS = process.env.PANE_PWA_TODO_STILLS;

function record(number: number, title: string, overrides: Partial<TodoRecord> = {}): TodoRecord {
  return {
    number, ref: `T-${number}`, sessionId: `s-${number}`, parentNumber: null, title, summary: '', doneWhen: [], state: 'in_progress',
    requester: { kind: 'person', name: 'you' }, projectId: 1, agent: 'claude', assignee: null, createdBy: 'you', createdAt: NOW - 180 * MIN,
    startedAt: NOW - 180 * MIN, updatedAt: NOW - 2 * MIN, acceptedAt: null, closedAt: null, lastProgressAt: null, stuckSince: null,
    episodeReminders: 0, episodeRestarts: 0, stallsToday: 0, stallsDay: null, attachRemindedAt: null, workMs: 0, loadHold: null,
    loadHoldSince: null, loadOverride: null, stuckCardId: null, ...overrides,
  };
}

const snooze19: TodoSnooze = { until: WED_9, zone: ZONE, note: 'Check Sentry for PDF errors and the download rate.', action: 'agents', by: 'orchestrator', from: 'in_progress', reminderCardId: null };
const snooze21: TodoSnooze = { until: Date.parse('2026-11-20T10:00:00-08:00'), zone: ZONE, note: 'Did Northwind reply?', action: 'remind', by: 'you', from: 'todo', reminderCardId: null };

/** The fake host's to-dos and its reminder card. */
class SnoozeHost {
  acts: TodoAction[] = [];
  rows: TodoListRow[] = [
    { todo: record(14, 'Ship receipt PDFs'), status: { status: 'working', reason: '' }, machine: 'devbox', pr: { number: 7, label: '#7' } },
    { todo: record(18, 'Tidy the receipt template', { state: 'todo', sessionId: null, startedAt: null }), status: { status: 'idle', reason: 'not started' }, machine: 'devbox' },
    { todo: record(19, 'Check how the receipt PDF launch went', { state: 'stopped', snooze: snooze19 }), status: { status: 'snoozed', reason: 'until Wed 9:00 AM' }, machine: 'devbox' },
    { todo: record(21, 'Check whether Northwind replied', { state: 'todo', sessionId: null, startedAt: null, snooze: snooze21 }), status: { status: 'snoozed', reason: 'until Fri 10:00 AM' }, machine: 'devbox' },
    { todo: record(23, 'Renew the Northwind contract', { state: 'todo', sessionId: null, startedAt: null }), status: { status: 'waiting', reason: 'Reminder', waitingApprovalId: 'r23', waitingCount: 1 }, machine: 'devbox' },
  ];
  items: NotifyItem[] = [{
    id: 'r23', ui: 'options', title: 'Reminder: T-23 Renew the Northwind contract', state: 'waiting', createdAt: NOW - MIN,
    context: 'Due Fri 10:00 AM, overdue by 22h: Pane was closed.\n\nCheck the inbox for a reply from Northwind.',
    choices: [{ label: 'Done' }, { label: 'Hand to an agent' }, { label: 'Snooze 1 hour' }, { label: 'Snooze to the next morning' }],
    source: { name: 'Pane', agent: 'Pane' }, todo: { number: 23, title: 'Renew the Northwind contract', kind: 'reminder' },
  }];

  detail(number: number): TodoDetail | undefined {
    const row = this.rows.find((candidate) => candidate.todo.number === number);
    if (!row) return undefined;
    return {
      ...row, subTodos: [], attachments: [{ attachments: [] }], activity: [], approvalIds: number === 23 ? ['r23'] : [],
      chatTarget: { panelId: 'orch', name: 'orchestrator', kind: 'orchestrator' }, orchestrator: { panelId: 'orch', name: 'orchestrator', agentId: 'claude' },
      load: { gate: 'normal', canPause: true }, keepMoving: '',
    };
  }

  snapshot(): TodosSnapshot {
    return { rows: this.rows, gate: { state: 'normal', enabled: true, since: NOW }, machine: 'devbox', ownSessionIds: [] };
  }

  shared(): NotifySharedState {
    return { machine: 'devbox', epoch: 'e1', revision: 1, enabled: true, items: this.items, queue: ['r23'], hidden: [] };
  }
}

async function routeHost(page: Page, host: SnoozeHost): Promise<void> {
  await page.route('http://anim-pane.test/**', async (route) => {
    const request = route.request();
    if (request.method() !== 'POST') return route.fallback();
    const raw = request.postData() ?? '{}';
    // SAFETY: the PWA posts the daemon's invoke envelope.
    const body = JSON.parse(raw) as { channel?: string; args?: JsonValue[] };
    const args = body.args ?? [];
    let result: JsonValue | object | null;
    switch (body.channel) {
      case 'todos:snapshot': result = { success: true, data: host.snapshot() }; break;
      case 'todos:detail': result = { success: true, data: host.detail(Number(args[0])) ?? null }; break;
      case 'todos:act':
        // SAFETY: the PWA sends one TodoAction.
        host.acts.push((JSON.parse(raw) as { args: [TodoAction] }).args[0]);
        result = { success: true, data: { todo: host.rows[0].todo } };
        break;
      case 'notify:remote-snapshot': result = host.shared(); break;
      default: return route.fallback();
    }
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, result }) });
  });
}

async function showTodos(page: Page): Promise<void> {
  await emitRemoteHostEvent(page, 'todos:changed');
  await emitRemoteHostEvent(page, 'notify:shared-changed', {});
  await page.getByRole('button', { name: 'Open remote panes' }).click();
  await page.getByRole('button', { name: /^To-dos/ }).click();
  await expect(page.getByTestId('phone-todos-list')).toBeVisible();
  await expect(page.getByTestId('phone-todo-row').first()).toBeVisible();
}

async function openTodos(page: Page): Promise<SnoozeHost> {
  const host = new SnoozeHost();
  await page.clock.setFixedTime(NOW);
  await openConnectedRemotePwa(page);
  await routeHost(page, host);
  await showTodos(page);
  return host;
}

async function noSidewaysScroll(page: Page): Promise<void> {
  const overflow = await page.evaluate(() => {
    const root = document.scrollingElement ?? document.documentElement;
    const wide = [...document.querySelectorAll<HTMLElement>('body *')]
      .filter(element => element.getBoundingClientRect().right > window.innerWidth + 1 && getComputedStyle(element).position !== 'fixed')
      .filter(element => !element.closest('[role="tablist"]'))
      .map(element => element.dataset.testid ?? element.tagName);
    return { page: root.scrollWidth - root.clientWidth, wide: wide.slice(0, 5) };
  });
  expect(overflow).toEqual({ page: 0, wide: [] });
}

async function still(page: Page, name: string): Promise<void> {
  if (!STILLS) return;
  mkdirSync(STILLS, { recursive: true });
  for (const theme of ['light', 'dark'] as const) {
    await page.evaluate((dark) => {
      for (const element of [document.documentElement, document.body]) {
        element.classList.remove('light', 'light-rounded', 'dark');
        element.classList.add(...(dark ? ['dark'] : ['light', 'light-rounded']));
      }
    }, theme === 'dark');
    await page.waitForTimeout(150);
    await page.screenshot({ path: path.join(STILLS, `${name}-${theme}.png`) });
  }
}

const group = (page: Page, key: string) => page.locator(`[data-testid="phone-todos-group"][data-group="${key}"]`);
const phoneRow = (page: Page, number: number) => page.locator(`[data-testid="phone-todo-row"][data-todo="${number}"]`);

test('S23: tapping headers folds them; Snoozed starts folded with its next wake; folds outlast a reload', async ({ page }) => {
  await openTodos(page);
  await expect(group(page, 'status:snoozed')).toHaveAttribute('aria-expanded', 'false');
  await expect(page.getByTestId('phone-todos-next-wake')).toHaveText('next Wed 9:00 AM');
  await expect(phoneRow(page, 19)).toHaveCount(0);
  await noSidewaysScroll(page);
  await still(page, 'r9-c-phonelist');
  await group(page, 'status:snoozed').tap();
  await expect(phoneRow(page, 19)).toBeVisible();
  await expect(phoneRow(page, 19).getByTestId('phone-todo-row-meta')).toHaveText('T-19 · until Wed 9:00 AM · Check Sentry for PDF errors and the download rate.');
  await group(page, 'status:idle').tap();
  await expect(group(page, 'status:idle')).toHaveAttribute('aria-expanded', 'false');
  await expect(phoneRow(page, 18)).toHaveCount(0);
  // The Snoozed pill shows it open, alone.
  await page.getByTestId('phone-todos-tab-snoozed').tap();
  await expect(group(page, 'status:snoozed')).toHaveAttribute('aria-expanded', 'true');
  await page.getByTestId('phone-todos-tab-open').tap();
  // Kept on this device.
  const saved = await page.evaluate(() => window.localStorage.getItem('pane-todos-folds'));
  expect(JSON.parse(saved ?? '{}')).toMatchObject({ 'open|status|status:snoozed': false, 'open|status|status:idle': true });
  await page.reload();
  await showTodos(page);
  await expect(group(page, 'status:snoozed')).toHaveAttribute('aria-expanded', 'true');
  await expect(group(page, 'status:idle')).toHaveAttribute('aria-expanded', 'false');
});

test('S16: ⋯ → Snooze… opens the sheet with presets and the native date and time input, and snoozes', async ({ page }) => {
  const host = await openTodos(page);
  await phoneRow(page, 14).tap();
  await expect(page.getByTestId('phone-todo-page')).toBeVisible();
  await page.getByTestId('phone-todo-more').tap();
  await page.getByRole('menuitem', { name: 'Snooze…' }).tap();
  const sheet = page.getByTestId('phone-snooze-sheet');
  await expect(sheet).toBeVisible();
  await expect(sheet.getByTestId('phone-snooze-pick-hour')).toContainText('Today 4:12 PM');
  await expect(sheet.getByTestId('phone-snooze-pick-tomorrow')).toContainText('Wed 18 Nov, 9:00 AM');
  await expect(sheet.getByTestId('phone-snooze-submit')).toContainText('Snooze until Wed 9:00 AM');
  await sheet.getByTestId('phone-snooze-note').fill('Check Sentry for PDF errors.');
  await noSidewaysScroll(page);
  await still(page, 'r9-c-phone');
  await sheet.getByTestId('phone-snooze-pick-custom').tap();
  await expect(sheet.getByTestId('phone-snooze-datetime')).toHaveAttribute('type', 'datetime-local');
  await sheet.getByTestId('phone-snooze-datetime').fill('2026-11-20T10:00');
  await expect(sheet.getByTestId('phone-snooze-submit')).toContainText('Snooze until Fri 10:00 AM');
  // The sheet clears the home indicator.
  const bottom = await sheet.getByTestId('phone-snooze-submit').evaluate((element) => window.innerHeight - element.getBoundingClientRect().bottom);
  expect(bottom).toBeGreaterThanOrEqual(16);
  await sheet.getByTestId('phone-snooze-submit').tap();
  await expect(sheet).toHaveCount(0);
  await expect.poll(() => host.acts.at(-1)).toEqual({ kind: 'snooze', number: 14, until: Date.parse('2026-11-20T10:00:00-08:00'), zone: ZONE, note: 'Check Sentry for PDF errors.', action: 'agents' });
});

test('S16: a reminder card opens full screen with back; "Snooze to another time…" returns to the to-do with the sheet', async ({ page }) => {
  await openTodos(page);
  await phoneRow(page, 23).tap();
  await page.getByTestId('todo-chip-status').tap();
  const approval = page.getByTestId('phone-todo-approval');
  await expect(approval).toBeVisible();
  await expect(approval.getByTestId('phone-back')).toHaveText('T-23');
  await expect(approval.getByTestId('approval-choice')).toHaveCount(4);
  await noSidewaysScroll(page);
  await still(page, 'r9-c-phonecard');
  await approval.getByTestId('approval-reminder-snooze').tap();
  await expect(page.getByTestId('phone-todo-page')).toBeVisible();
  await expect(page.getByTestId('phone-snooze-sheet')).toBeVisible();
  await expect(page.getByTestId('phone-snooze-action-remind').or(page.getByTestId('snooze-action-remind'))).toHaveAttribute('aria-checked', 'true');
});
