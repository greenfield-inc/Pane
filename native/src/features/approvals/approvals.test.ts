import { describe, expect, it, vi } from 'vitest';

import { RemoteRequestError, RemoteUnconfirmedResultError } from '@shared/remoteClient';
import type { NotifyItem, NotifySharedState } from '@shared/types/notify';

import {
  answeredItems,
  approvalItems,
  approvalKindLabel,
  approvalListOrder,
  approvalOrder,
  approvalParams,
  approvalPosition,
  approvalWorkspace,
  askerLine,
  connectedLink,
  groupApprovals,
  isStale,
  itemEntry,
  machineOfflineLine,
  nextApproval,
  NO_PROJECT,
  NOT_IN_A_SESSION,
  openApprovalLink,
  openLinkCommand,
  parseApprovalList,
  parseApprovalSort,
  questionDetail,
  receiptLines,
  resolveSelection,
  sessionKey,
  sessionsByPane,
  staleItems,
  waitingCounts,
  type ApprovalSort,
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
  it('Most recent: one flat group with no header, newest on top', () => {
    const groups = groupApprovals(approvalItems(state).map(entry => itemEntry(entry, 'mac')), 'recent');
    expect(groups.map(group => [group.label, group.entries.map(entry => entry.item.id)])).toEqual([['', ['held', 'relay', 'later', 'orch', 'worker', 'loose']]]);
    expect(groupApprovals([], 'recent')).toEqual([]);
  });

  it('By Session: groups in order of each group\'s newest item, newest first inside, with no fixed place for any group', () => {
    const groups = groupApprovals(approvalItems(state).map(entry => itemEntry(entry, 'mac')), 'session');
    expect(groups.map(group => [group.label, group.entries.map(entry => entry.item.id)])).toEqual([
      [NOT_IN_A_SESSION, ['held', 'loose']],
      ['Pane Fixes', ['relay', 'orch']],
      ['Spring launch', ['later', 'worker']],
    ]);
    expect(groups.map(group => group.machineKey)).toEqual([undefined, 'mac', 'mac']);
  });

  it('keeps the same Session on two machines apart, and puts both machines\' loose items in one group', () => {
    const groups = groupApprovals([
      itemEntry(worker, 'studio'),
      itemEntry({ ...worker, id: 'w2', createdAt: 2_500 }, 'build'),
      itemEntry(loose, 'build'),
      itemEntry({ ...loose, id: 'l2', createdAt: 9_000 }, 'studio'),
    ], 'session');
    expect(groups.map(group => group.key)).toEqual(['none', 'build:sess-launch', 'studio:sess-launch']);
    expect(groups[0]?.entries.map(entry => entry.machineKey)).toEqual(['studio', 'build']);
  });

  it('By project: groups in order of each group\'s newest item, one per project and machine, and "No project" for the rest', () => {
    const inProject = (id: string, createdAt: number, project: string) => item(id, createdAt, { source: { name: 'x', agent: 'Claude', project } });
    const groups = groupApprovals([
      itemEntry(inProject('pane-old', 1, 'Pane'), 'mac'),
      itemEntry(inProject('doozy', 2, 'Doozy'), 'mac'),
      itemEntry(inProject('pane-new', 3, 'Pane'), 'mac'),
      itemEntry(inProject('pane-there', 4, 'Pane'), 'studio'),
      itemEntry(item('none', 5), 'studio'),
      itemEntry(inProject('blank', 0, ''), 'mac'),
    ], 'project');
    expect(groups.map(group => [group.label, group.machineKey, group.entries.map(entry => entry.item.id)])).toEqual([
      [NO_PROJECT, undefined, ['none', 'blank']],
      ['Pane', 'studio', ['pane-there']],
      ['Pane', 'mac', ['pane-new', 'pane-old']],
      ['Doozy', 'mac', ['doozy']],
    ]);
  });

  it('files a permission request by the project it was given, like a question', () => {
    const request = { key: 'p1', machineKey: 'mac', at: 9, waiting: true, project: 'Pane' };
    expect(groupApprovals([request, itemEntry(item('q', 1), 'mac')], 'project').map(group => group.label)).toEqual(['Pane', NO_PROJECT]);
  });

  it('reads a saved sort, and Most recent from anything else', () => {
    expect(parseApprovalSort('session')).toBe('session');
    expect(parseApprovalSort('project')).toBe('project');
    expect(parseApprovalSort('recent')).toBe('recent');
    expect(parseApprovalSort('nonsense')).toBe('recent');
    expect(parseApprovalSort('toString')).toBe('recent');
    expect(parseApprovalSort(null)).toBe('recent');
  });

  it('names who asked and its Session, for a row with no group header above it', () => {
    expect(askerLine('api-fix', launch)).toBe('api-fix in Spring launch');
    expect(askerLine('api-fix')).toBe('api-fix');
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
  const order = approvalOrder(state, 'recent');

  it('steps through items in home\'s order and says "1 of N"', () => {
    expect(order).toEqual(['held', 'relay', 'later', 'orch', 'worker', 'loose']);
    expect(approvalPosition(order, 'held')).toBe('1 of 6');
    expect(approvalPosition(order, 'loose')).toBe('6 of 6');
    expect(approvalPosition(order, 'gone')).toBeNull();
    expect(nextApproval(order, 'held')).toBe('relay');
    expect(nextApproval(order, 'loose')).toBe('held');
    expect(nextApproval(['only'], 'only')).toBeNull();
  });

  it('follows the sort home shows, group by group', () => {
    const shown = (sort: ApprovalSort) => groupApprovals(approvalItems(state).map(entry => itemEntry(entry, 'mac')), sort).flatMap(group => group.entries.map(entry => entry.item.id));
    for (const sort of ['recent', 'session', 'project'] as const) {
      expect(approvalOrder(state, sort)).toEqual(shown(sort));
      expect(approvalListOrder(state, 'waiting', 0, sort)).toEqual(shown(sort));
    }
    expect(approvalOrder(state, 'session')).toEqual(['held', 'loose', 'relay', 'orch', 'later', 'worker']);
  });

  it('moves to the next item when its item is answered elsewhere, then back home when none is left', () => {
    expect(resolveSelection(order, 'orch', order)).toEqual({ kind: 'show', id: 'orch' });
    const answeredOnDesktop = order.filter(id => id !== 'orch');
    expect(resolveSelection(answeredOnDesktop, 'orch', order)).toEqual({ kind: 'move', id: 'worker' });
    // The last one goes: step back to the one before it.
    expect(resolveSelection(['worker'], 'held', ['worker', 'held'])).toEqual({ kind: 'move', id: 'worker' });
    expect(resolveSelection([], 'held', ['held'])).toEqual({ kind: 'home' });
  });

  it('opens an old alert\'s item on the first one waiting, or says nothing is', () => {
    expect(resolveSelection(order, 'stale', [])).toEqual({ kind: 'move', id: 'held' });
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

  it('says what a row is: a sent answer, or the question, with no orchestrator line', () => {
    expect(questionDetail(relay)).toBe('Question relay');
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

describe('stale items (D-147)', () => {
  const stale = item('stale', 100, { staleSince: 5_000 });
  const withStale = at(stale, item('fresh', 200), item('stale-2', 50, { staleSince: 6_000 }));

  it('leaves Waiting for its own group, oldest first, and leaves the counts', () => {
    expect(isStale(stale)).toBe(true);
    expect(isStale(item('fresh', 1))).toBe(false);
    // Stale and then answered: it isn't waiting any more.
    expect(isStale({ ...stale, state: 'answered' })).toBe(false);
    expect(approvalItems(withStale).map(entry => entry.id)).toEqual(['fresh']);
    expect(staleItems(withStale).map(entry => entry.id)).toEqual(['stale-2', 'stale']);
    expect(staleItems(undefined)).toEqual([]);
    expect(waitingCounts(approvalItems(withStale).map(entry => itemEntry(entry, 'mac'))).total).toBe(1);
  });

  it('steps through its own group on the approval screen, so "1 of N" never mixes the two', () => {
    expect(approvalListOrder(withStale, 'waiting', 0, 'recent')).toEqual(['fresh']);
    // Every sort leaves Stale oldest first.
    expect(approvalListOrder(withStale, 'stale', 0, 'project')).toEqual(['stale-2', 'stale']);
  });
});

describe('the Answered group', () => {
  const now = 100 * 60 * 60 * 1000;
  const hoursAgo = (hours: number) => now - hours * 60 * 60 * 1000;
  const answered = item('answered', 1, { state: 'answered', resolvedAt: hoursAgo(2) });
  const closed = item('closed', 2, { state: 'expired', resolvedAt: hoursAgo(1), closed: { by: 'autopilot', reason: 'stale', at: hoursAgo(1) } });
  const old = item('old', 3, { state: 'answered', resolvedAt: hoursAgo(25) });
  const state = at(answered, closed, old, item('open', 4), item('fyi', 5, { state: 'info' }));

  it('lists the last 24 hours\' answered and closed items, newest first', () => {
    expect(answeredItems(state, now).map(entry => entry.id)).toEqual(['closed', 'answered']);
    expect(approvalListOrder(state, 'answered', now, 'recent')).toEqual(['closed', 'answered']);
    expect(answeredItems(undefined, now)).toEqual([]);
  });

  it('sorts by when each was answered, asked earlier or not, and groups the same way', () => {
    const inProject = (project: string) => ({ source: { name: 'x', agent: 'Claude', project } });
    const late = item('asked-first', 1, { ...inProject('Pane'), state: 'answered', resolvedAt: hoursAgo(1) });
    const early = item('asked-last', 9, { ...inProject('Doozy'), state: 'answered', resolvedAt: hoursAgo(3) });
    const middle = item('asked-middle', 5, { ...inProject('Pane'), state: 'answered', resolvedAt: hoursAgo(2) });
    const answeredState = at(early, late, middle);
    expect(groupApprovals(answeredItems(answeredState, now).map(entry => itemEntry(entry, 'mac')), 'project').map(group => [group.label, group.entries.map(entry => entry.item.id)]))
      .toEqual([['Pane', ['asked-first', 'asked-middle']], ['Doozy', ['asked-last']]]);
    expect(approvalListOrder(answeredState, 'answered', now, 'recent')).toEqual(['asked-first', 'asked-middle', 'asked-last']);
    expect(approvalListOrder(answeredState, 'answered', now, 'project')).toEqual(['asked-first', 'asked-middle', 'asked-last']);
    expect(approvalListOrder(answeredState, 'answered', now, 'session')).toEqual(['asked-first', 'asked-middle', 'asked-last']);
  });

  it('reads a route\'s list, and anything else as Waiting', () => {
    expect(parseApprovalList('stale')).toBe('stale');
    expect(parseApprovalList('answered')).toBe('answered');
    expect(parseApprovalList(undefined)).toBe('waiting');
    expect(parseApprovalList('nonsense')).toBe('waiting');
  });

  it('shows its receipt before its question on the row', () => {
    expect(questionDetail(closed)).toBe('Closed by Autopilot: stale · Question closed');
    expect(questionDetail(item('byYou', 1, { state: 'answered', answerSummary: 'Approved' }))).toBe('Approved · Question byYou');
  });

  it('labels a card by what happened to it', () => {
    expect(approvalKindLabel(item('open', 1))).toBe('Needs approval');
    expect(approvalKindLabel(item('open', 1, { ui: 'ask' }))).toBe('Needs an answer');
    expect(approvalKindLabel(answered)).toBe('Answered');
    expect(approvalKindLabel(closed)).toBe('Closed');
    expect(approvalKindLabel(item('ended', 1, { state: 'expired' }))).toBe('Ended');
  });
});

describe('a card\'s receipts (J12, J14)', () => {
  it('lists who acted, the recorded decision and any correction', () => {
    const byAutopilot = item('a', 1, {
      state: 'answered',
      answeredBy: { by: 'autopilot', because: 'D-22' },
      decision: 'D-147',
      corrections: [{ summary: 'First', by: 'you', at: 1 }, { summary: 'Use 5', by: 'you', at: 2 }],
    });
    expect(receiptLines(byAutopilot)).toEqual(['Answered by Autopilot · because D-22', 'Recorded as D-147', 'Corrected by you: Use 5']);
  });

  it('shows a rewrite on its open card, and nothing on an ordinary one', () => {
    expect(receiptLines(item('r', 1, { rewrittenFrom: { id: 'old', title: 'Q-9: unclear', qn: 'Q-9' } }))).toEqual(['Rewritten by Autopilot from Q-9']);
    expect(receiptLines(item('plain', 1))).toEqual([]);
  });
});

describe('an offline machine (J20)', () => {
  it('says how many wait and when they come back', () => {
    expect(machineOfflineLine('Mac mini', 4)).toBe('Mac mini offline · 4 waiting · they come back when Mac mini is online');
  });
});

describe('what an opened item is connected to (J32)', () => {
  const source = { name: 'api-fix', agent: 'Claude' };

  it('shows the Session, with its machine, and opens it', () => {
    const inSession = item('s', 1, { source, connected: { kind: 'session', id: 's1', name: 'Sales Skill', paneId: 'ws' } });
    expect(connectedLink(inSession, 'Mac mini')).toEqual({ kind: 'session', text: 'Session · Sales Skill · Mac mini', target: { kind: 'session', sessionId: 's1' } });
  });

  it('shows a Pane outside a Session', () => {
    const inPane = item('p', 1, { source, connected: { kind: 'pane', id: 'p1', name: 'api-fix' } });
    expect(connectedLink(inPane, 'Mac mini')).toEqual({ kind: 'pane', text: 'Pane · api-fix · Mac mini', target: { kind: 'pane', paneId: 'p1' } });
  });

  it('shows Autopilot for its own item about no Session, and the Session for one about a Session', () => {
    const own = item('a', 1, { source: { ...source, autopilot: true }, connected: { kind: 'autopilot', id: 'autopilot', name: 'Autopilot' } });
    expect(connectedLink(own, 'Mac mini')).toEqual({ kind: 'autopilot', text: 'Autopilot · Mac mini', target: { kind: 'autopilot' } });
    const about = item('b', 1, { source: { ...source, autopilot: true }, connected: { kind: 'session', id: 's2', name: 'Infra', paneId: 'ws2' } });
    expect(connectedLink(about, 'Mac mini').target).toEqual({ kind: 'session', sessionId: 's2' });
  });

  it('names the machine by its saved name, never what the host calls itself, and opens nothing', () => {
    const outside = item('m', 1, { source, connected: { kind: 'machine', id: 'local', name: 'tylers-mbp.lan' } });
    expect(connectedLink(outside, 'MacBook')).toEqual({ kind: 'machine', text: 'MacBook', target: null });
  });

  it('works from the source on an older machine\'s item', () => {
    expect(connectedLink(item('o', 1, { source: { ...source, session: { id: 's3', name: 'Launch', paneId: 'ws3' } } }), 'Mac mini').target).toEqual({ kind: 'session', sessionId: 's3' });
    expect(connectedLink(item('o', 1, { source: { ...source, paneId: 'p3' } }), 'Mac mini')).toMatchObject({ kind: 'pane', text: 'Pane · api-fix · Mac mini', target: { kind: 'pane', paneId: 'p3' } });
    expect(connectedLink(item('o', 1, { source: { ...source, autopilot: true } }), 'Mac mini').kind).toBe('autopilot');
    expect(connectedLink(item('o', 1, { source }), 'Mac mini')).toEqual({ kind: 'machine', text: 'Mac mini', target: null });
  });
});
