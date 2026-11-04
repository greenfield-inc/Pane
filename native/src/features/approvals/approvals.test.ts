import { describe, expect, it, vi } from 'vitest';

import { RemoteRequestError, RemoteUnconfirmedResultError } from '@shared/remoteClient';
import type { NotifyItem, NotifySharedState } from '@shared/types/notify';

import {
  approvalItems,
  approvalOrder,
  approvalParams,
  approvalPosition,
  approvalWorkspace,
  groupBySession,
  itemEntry,
  nextApproval,
  NOT_IN_A_SESSION,
  openApprovalLink,
  openLinkCommand,
  questionDetail,
  relayLine,
  resolveSelection,
  sessionKey,
  sessionsByPane,
  waitingCounts,
} from './approvals';

const launch = { id: 'sess-launch', name: 'Spring launch', paneId: 'ws-launch' };
const fixes = { id: 'sess-fixes', name: 'Pane Fixes', paneId: 'ws-fixes' };

const item = (id: string, createdAt: number, extra: Partial<NotifyItem> = {}): NotifyItem => ({
  id, ui: 'approve', title: `Question ${id}`, state: 'waiting', createdAt, source: { name: 'worker', agent: 'Claude', paneId: `pane-${id}` }, ...extra,
});

const at = (...items: NotifyItem[]): NotifySharedState => ({ machine: 'macbook', epoch: 'e1', revision: 1, enabled: true, queue: [], hidden: [], items });

// An older host's item (no Session), a worker's and an orchestrator's in two Sessions, a fallback, and some that aren't waiting.
const loose = item('loose', 1_000);
const worker = item('worker', 2_000, { source: { name: 'api-fix', agent: 'Codex', paneId: 'pane-api', session: launch } });
const orchestrator = item('orch', 3_000, { source: { name: 'Pane Fixes', agent: 'Claude', paneId: 'ws-fixes', session: { ...fixes, orchestrator: true } } });
const later = item('later', 4_000, { source: { name: 'docs', agent: 'Claude', paneId: 'pane-docs', session: launch } });
const relay = item('relay', 5_000, {
  ui: 'info',
  source: { name: 'Pane Fixes', agent: 'Pane', paneId: 'ws-fixes', session: fixes },
  relay: { inboxItemId: 'inbox-1', worker: 'api-fix', question: 'Which retry limit?' },
});
const held = item('held', 6_000, { state: 'sent', answerSummary: 'Approved' });
const state = at(later, relay, held, loose, orchestrator, worker, item('done', 500, { state: 'answered' }), item('fyi', 700, { ui: 'info', state: 'info' }));

describe('Approvals grouping', () => {
  it('groups by Session in order of each group\'s oldest item, with "Not in a Session" last', () => {
    const groups = groupBySession(approvalItems(state).map(entry => itemEntry(entry, 'mac')));
    expect(groups.map(group => [group.label, group.entries.map(entry => entry.item.id)])).toEqual([
      ['Spring launch', ['worker', 'later']],
      ['Pane Fixes', ['orch', 'relay']],
      [NOT_IN_A_SESSION, ['loose', 'held']],
    ]);
    expect(groups.map(group => group.machineKey)).toEqual(['mac', 'mac', undefined]);
  });

  it('keeps the same Session on two machines apart, and puts both machines\' loose items in one last group', () => {
    const groups = groupBySession([
      itemEntry(worker, 'studio'),
      itemEntry({ ...worker, id: 'w2', createdAt: 2_500 }, 'build'),
      itemEntry(loose, 'build'),
      itemEntry({ ...loose, id: 'l2', createdAt: 9_000 }, 'studio'),
    ]);
    expect(groups.map(group => group.key)).toEqual(['studio:sess-launch', 'build:sess-launch', 'none']);
    expect(groups[2]?.entries.map(entry => entry.machineKey)).toEqual(['build', 'studio']);
  });

  it('lists open questions, fallbacks and answers held for Undo, never answered, expired or updates', () => {
    expect(approvalItems(state).map(entry => entry.id)).toEqual(['loose', 'worker', 'orch', 'later', 'relay', 'held']);
    expect(approvalItems(undefined)).toEqual([]);
  });

  it('files permission requests under the Session their Pane works in', () => {
    const lookup = sessionsByPane([
      { id: 's1', name: 'Launch', associations: [{ paneId: 'p1' }] },
      { id: 's2', name: 'Old', archived: true, associations: [{ paneId: 'p2' }] },
    ]);
    expect(lookup.get('p1')).toEqual({ id: 's1', name: 'Launch' });
    expect(lookup.has('p2')).toBe(false);
  });
});

describe('waiting counts on home', () => {
  const counts = (entries: Parameters<typeof waitingCounts>[0]) => {
    const { bySession, total } = waitingCounts(entries);
    return { bySession: Object.fromEntries(bySession), total };
  };

  it('counts what waits from each Session, a fallback item included, and leaves answers held for Undo out', () => {
    const heldInLaunch = item('held-launch', 7_000, { state: 'sent', source: { name: 'docs', agent: 'Claude', session: launch } });
    expect(counts([...approvalItems(state), heldInLaunch].map(entry => itemEntry(entry, 'mac')))).toEqual({
      // worker + later; orch + relay (the fallback); held and held-launch are in their Undo hold.
      bySession: { 'mac:sess-launch': 2, 'mac:sess-fixes': 2 },
      // Both Sessions' 4, plus the loose question outside any Session.
      total: 5,
    });
  });

  it('counts permission requests as waiting, in their Session or outside one', () => {
    const request = (key: string, session?: { id: string; name: string }) => ({ key, machineKey: 'mac', at: 1, waiting: true, ...(session ? { session } : {}) });
    expect(counts([request('p1', launch), request('p2')])).toEqual({ bySession: { 'mac:sess-launch': 1 }, total: 2 });
  });

  it('keeps the same Session id on two machines apart', () => {
    const result = counts([itemEntry(worker, 'studio'), itemEntry(later, 'studio'), itemEntry({ ...worker, id: 'w2' }, 'build')]);
    expect(result).toEqual({ bySession: { [sessionKey('studio', 'sess-launch')]: 2, [sessionKey('build', 'sess-launch')]: 1 }, total: 3 });
  });

  it('shows no count when nothing waits', () => {
    expect(counts([itemEntry(held, 'mac')])).toEqual({ bySession: {}, total: 0 });
    expect(counts([])).toEqual({ bySession: {}, total: 0 });
  });
});

describe('the approval screen', () => {
  const order = approvalOrder(state);

  it('steps through items in home\'s order and says "1 of N"', () => {
    expect(order).toEqual(['worker', 'later', 'orch', 'relay', 'loose', 'held']);
    expect(approvalPosition(order, 'worker')).toBe('1 of 6');
    expect(approvalPosition(order, 'held')).toBe('6 of 6');
    expect(approvalPosition(order, 'gone')).toBeNull();
    expect(nextApproval(order, 'worker')).toBe('later');
    expect(nextApproval(order, 'held')).toBe('worker');
    expect(nextApproval(['only'], 'only')).toBeNull();
  });

  it('moves to the next item when its item is answered elsewhere, then back home when none is left', () => {
    expect(resolveSelection(order, 'orch', order)).toEqual({ kind: 'show', id: 'orch' });
    const answeredOnDesktop = order.filter(id => id !== 'orch');
    expect(resolveSelection(answeredOnDesktop, 'orch', order)).toEqual({ kind: 'move', id: 'relay' });
    // The last one goes: step back to the one before it.
    expect(resolveSelection(['worker'], 'held', ['worker', 'held'])).toEqual({ kind: 'move', id: 'worker' });
    expect(resolveSelection([], 'held', ['held'])).toEqual({ kind: 'home' });
  });

  it('opens an old alert\'s item on the first one waiting, or says nothing is', () => {
    expect(resolveSelection(order, 'stale', [])).toEqual({ kind: 'move', id: 'worker' });
    expect(resolveSelection([], 'stale', [])).toEqual({ kind: 'gone' });
  });

  it('shows an orchestrator\'s item or a fallback above its Session, and any other above the Pane that asked', () => {
    expect(approvalWorkspace(orchestrator)).toEqual({ kind: 'session', sessionId: 'sess-fixes', paneId: 'ws-fixes' });
    expect(approvalWorkspace(relay)).toEqual({ kind: 'session', sessionId: 'sess-fixes', paneId: 'ws-fixes' });
    expect(approvalWorkspace(worker)).toEqual({ kind: 'pane', paneId: 'pane-api' });
    expect(approvalWorkspace(item('outside', 1, { source: { name: 'scripts', agent: 'Cursor' } }), 'alert-pane')).toEqual({ kind: 'none' });
    expect(approvalWorkspace(undefined, 'alert-pane')).toEqual({ kind: 'pane', paneId: 'alert-pane' });
    expect(approvalWorkspace(undefined)).toEqual({ kind: 'none' });
  });

  it('shows a fallback read-only, naming the orchestrator it waits on', () => {
    expect(relayLine(relay)).toBe('Waiting on the Pane Fixes orchestrator: api-fix asks “Which retry limit?”');
    expect(relayLine(worker)).toBeNull();
    expect(questionDetail(relay)).toBe('Waiting on the orchestrator: Question relay');
    expect(questionDetail(held)).toBe('Sent: Approved');
    expect(questionDetail(worker)).toBe('Question worker');
  });
});

describe('the asking tab (F-2)', () => {
  const asking = item('asking', 1, { source: { name: 'api-fix', agent: 'Claude', paneId: 'pane-api', panelId: 'tab-a' } });

  it('opens a worker’s or standalone Pane’s item on the tab that asked', () => {
    expect(approvalWorkspace(asking)).toEqual({ kind: 'pane', paneId: 'pane-api', panelId: 'tab-a' });
    const inSession = item('in-session', 1, { source: { name: 'api-fix', agent: 'Claude', paneId: 'pane-api', panelId: 'tab-a', session: launch } });
    expect(approvalWorkspace(inSession)).toEqual({ kind: 'pane', paneId: 'pane-api', panelId: 'tab-a' });
  });

  it('keeps the orchestrator’s selection for Session and fallback items', () => {
    const orch = item('o', 1, { source: { name: 'Pane Fixes', agent: 'Claude', paneId: 'ws-fixes', panelId: 'orch-tab', session: { ...fixes, orchestrator: true } } });
    expect(approvalWorkspace(orch)).toEqual({ kind: 'session', sessionId: 'sess-fixes', paneId: 'ws-fixes' });
    expect(approvalWorkspace({ ...relay, source: { ...relay.source, panelId: 'orch-tab' } })).toEqual({ kind: 'session', sessionId: 'sess-fixes', paneId: 'ws-fixes' });
  });

  it('drops the last item’s tab on every move to another item (1 of N, Next, answered elsewhere)', () => {
    expect(approvalParams('q2')).toEqual({ notifyId: 'q2', panelId: undefined });
    expect(Object.keys(approvalParams('q2'))).toContain('panelId');
  });
});

describe('opening a related link (F-4, F-6)', () => {
  const links = [{ label: 'plan.md', path: '/work/worker/plan.md' }, { label: 'Docs', url: 'https://example.com' }];
  const orch = item('q1', 1, { links, source: { name: 'Pane Fixes', agent: 'Claude', paneId: 'ws-fixes', session: { ...fixes, orchestrator: true } } });

  it('sends the host one command naming the item as the host knows it, the link and the shown Pane', () => {
    expect(openLinkCommand(orch, 0, 'ws-fixes')).toEqual({ type: 'open-link', id: 'q1', index: 0, paneId: 'ws-fixes' });
    const saved = { ...orch, id: 'studio-1:q1', machineId: 'studio-1' };
    expect(openLinkCommand(saved, 1, 'ws-fixes')).toEqual({ type: 'open-link', id: 'q1', index: 1, paneId: 'ws-fixes' });
    expect(openLinkCommand({ ...orch, machineId: 'local' }, 0, undefined)).toEqual({ type: 'open-link', id: 'q1', index: 0 });
  });

  it('opens an orchestrator’s link to a worker file with one call, and brings the new tab forward', async () => {
    const send = vi.fn(async () => null);
    const readPanels = vi.fn(async () => ['chat', 'plan-page']);
    const outcome = await openApprovalLink(orch, 0, 'ws-fixes', ['chat'], { send, readPanels });
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith({ type: 'open-link', id: 'q1', index: 0, paneId: 'ws-fixes' });
    expect(outcome).toEqual({ kind: 'opened', panelId: 'plan-page' });
  });

  it('opens without moving the tabs when no new tab appeared (an existing tab came forward)', async () => {
    const outcome = await openApprovalLink(orch, 0, 'ws-fixes', ['chat', 'plan-page'], { send: async () => null, readPanels: async () => ['chat', 'plan-page'] });
    expect(outcome).toEqual({ kind: 'opened' });
  });

  it('stops on a lost reply: no second call, the tabs are read again, and the result is unknown', async () => {
    const send = vi.fn(async () => { throw new RemoteUnconfirmedResultError('Delivery unknown'); });
    const readPanels = vi.fn(async () => ['chat']);
    const outcome = await openApprovalLink(orch, 1, 'ws-fixes', ['chat'], { send, readPanels });
    expect(send).toHaveBeenCalledTimes(1);
    expect(readPanels).toHaveBeenCalledTimes(1);
    expect(outcome.kind).toBe('unknown');
    if (outcome.kind !== 'unknown') return;
    expect(outcome.message).toContain('may have opened Docs');
    expect(outcome.message).not.toContain('Nothing was opened');
  });

  it('still says the result is unknown when reading the tabs again fails', async () => {
    const outcome = await openApprovalLink(orch, 1, 'ws-fixes', ['chat'], {
      send: async () => { throw new RemoteUnconfirmedResultError('Delivery unknown'); },
      readPanels: async () => { throw new Error('offline'); },
    });
    expect(outcome.kind).toBe('unknown');
  });

  it('shows the host’s message for a definite rejection, after one call', async () => {
    const send = vi.fn(async () => { throw new RemoteRequestError('Pane couldn\'t open plan.md as a tab (outside the worktree). Nothing was opened. Next: Check the file still exists inside the asking Pane\'s folder.', 500, 'ERR_APPROVALS_LINK_OPEN'); });
    const readPanels = vi.fn(async () => ['chat']);
    const outcome = await openApprovalLink(orch, 0, 'ws-fixes', ['chat'], { send, readPanels });
    expect(send).toHaveBeenCalledTimes(1);
    expect(readPanels).not.toHaveBeenCalled();
    expect(outcome).toEqual({ kind: 'failed', message: expect.stringContaining('Pane couldn\'t open plan.md') });
  });
});
