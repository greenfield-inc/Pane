import { describe, expect, it } from 'vitest';
import type { NotifyItem } from '../../../../shared/types/notify';
import { approvalRowLines, besideOf, connectedOf, groupApprovals, offlineRows, offlineRowText, parseApprovalsSort, readApprovalsSort, relayReadOnlyLine, saveApprovalsSort } from './approvalGroups';

const launch = { id: 'session-1', name: 'Pane Fixes', paneId: 'session-pane' };
const infra = { id: 'session-2', name: 'Infra', paneId: 'infra-pane' };

function item(id: string, createdAt: number, extra: Partial<NotifyItem> = {}): NotifyItem {
  return { id, ui: 'approve', title: id, source: { name: 'pane', agent: 'Claude' }, state: 'waiting', createdAt, ...extra };
}

describe('Most recent', () => {
  const ids = (list: NotifyItem[]) => list.map(entry => entry.id);

  it('lists Waiting flat, newest asked on top, with no groups', () => {
    const items = [
      item('fifteen-days', 1),
      item('nine-minutes', 3, { source: { name: 'x', agent: 'Claude', session: launch } }),
      item('one-hour', 2, { source: { name: 'y', agent: 'Claude', session: infra }, machine: 'studio', machineId: 'studio' }),
      item('held', 4, { state: 'sent' }),
      item('done', 9, { state: 'answered', resolvedAt: 10 }),
    ];
    const queue = groupApprovals(items, 'waiting', 'recent');
    expect(queue.groups).toEqual([]);
    expect(ids(queue.list)).toEqual(['held', 'nine-minutes', 'one-hour', 'fifteen-days']);
  });

  it('lists Answered flat, by when it was answered, or asked when it never was', () => {
    const items = [
      item('asked-last-answered-first', 9, { state: 'answered', resolvedAt: 10 }),
      item('asked-first-answered-last', 1, { state: 'answered', resolvedAt: 30 }),
      item('update', 20, { ui: 'info', state: 'info' }),
      item('open', 50),
    ];
    const queue = groupApprovals(items, 'answered', 'recent');
    expect(queue.groups).toEqual([]);
    expect(ids(queue.list)).toEqual(['asked-first-answered-last', 'update', 'asked-last-answered-first']);
  });

  it('keeps items asked in the same millisecond in one order, whatever order they arrive in', () => {
    const [a, b] = [item('a', 5), item('b', 5)];
    expect(ids(groupApprovals([a, b], 'waiting', 'recent').list)).toEqual(ids(groupApprovals([b, a], 'waiting', 'recent').list));
  });

  it('still shows each row its Session and machine', () => {
    const [row] = groupApprovals([item('a', 1, { source: { name: 'workos-sso', agent: 'Claude', session: launch }, machine: 'Mac mini' })], 'waiting', 'recent').list;
    expect(approvalRowLines(row).origin).toBe('workos-sso in Pane Fixes · Mac mini');
  });
});

describe('By Session', () => {
  it('orders groups by their newest item, newest first inside, with no fixed place for any group', () => {
    const items = [
      item('plan', 2, { source: { name: 'Pane Fixes', agent: 'Claude', session: { ...launch, orchestrator: true } } }),
      item('terraform', 3, { source: { name: 'infra-queue', agent: 'Claude', session: infra }, machine: 'studio', machineId: 'studio' }),
      item('sidebar', 4, { source: { name: 'session-order', agent: 'Claude', session: launch } }),
      item('held', 5, { state: 'sent', source: { name: 'Pane Fixes', agent: 'Claude', session: launch } }),
      item('loose', 6, { source: { name: 'docs', agent: 'Cursor' } }),
      item('fyi', 7, { ui: 'info', state: 'info' }),
      item('done', 8, { state: 'answered', resolvedAt: 9 }),
    ];
    const { waiting, groups, list } = groupApprovals(items, 'waiting', 'session');

    expect(waiting).toBe(4);
    expect(groups.map(group => [group.label, group.machineId, group.items.map(entry => entry.id)])).toEqual([
      ['Not in a Session', undefined, ['loose']],
      ['Pane Fixes', undefined, ['held', 'sidebar', 'plan']],
      ['Infra', 'studio', ['terraform']],
    ]);
    // The order the list shows, for whatever steps through it.
    expect(list.map(entry => entry.id)).toEqual(['loose', 'held', 'sidebar', 'plan', 'terraform']);
    // The orchestrator's own item says the most about the Session, even when it isn't the newest.
    expect(groups[1].session).toEqual({ ...launch, orchestrator: true });
  });

  it('files Autopilot\'s own items under "Autopilot", in order of its newest item like any group', () => {
    const items = [
      item('plan', 1, { source: { name: 'Pane Fixes', agent: 'Claude', session: launch } }),
      item('close-out', 3, { source: { name: 'Autopilot', agent: 'Claude', paneId: '__autopilot_owner_r1', autopilot: true } }),
      item('loose', 2, { source: { name: 'docs', agent: 'Cursor' } }),
    ];
    const { groups } = groupApprovals(items, 'waiting', 'session');
    expect(groups.map(group => [group.label, group.autopilot ?? false, group.items.map(entry => entry.id)])).toEqual([
      ['Autopilot', true, ['close-out']],
      ['Not in a Session', false, ['loose']],
      ['Pane Fixes', false, ['plan']],
    ]);
  });

  it('keeps one Session on two machines as two groups', () => {
    const items = [
      item('a', 1, { source: { name: 'x', agent: 'Claude', session: launch }, machineId: 'local', machine: 'macbook' }),
      item('b', 2, { source: { name: 'y', agent: 'Claude', session: launch }, machineId: 'studio', machine: 'studio' }),
    ];
    expect(groupApprovals(items, 'waiting', 'session').groups.map(group => group.machineId)).toEqual(['studio', 'local']);
  });

  it('groups Answered the same way, by when each was answered', () => {
    const items = [
      item('old', 1, { state: 'answered', resolvedAt: 10, source: { name: 'x', agent: 'Claude', session: launch } }),
      item('gone', 2, { state: 'expired', resolvedAt: 30 }),
      item('new', 3, { state: 'answered', resolvedAt: 20, source: { name: 'x', agent: 'Claude', session: launch } }),
      item('open', 4),
      item('update', 5, { ui: 'info', state: 'info' }),
    ];
    const answered = groupApprovals(items, 'answered', 'session');
    expect(answered.answered).toBe(4);
    expect(answered.groups.map(group => group.items.map(entry => entry.id))).toEqual([['gone', 'update'], ['new', 'old']]);
  });
});

describe('By project', () => {
  const inProject = (project: string) => ({ source: { name: 'x', agent: 'Claude', project } });

  it('orders groups by their newest item, newest first inside', () => {
    const items = [item('pane-old', 1, inProject('Pane')), item('doozy', 2, inProject('Doozy')), item('pane-new', 3, inProject('Pane'))];
    const { groups } = groupApprovals(items, 'waiting', 'project');
    expect(groups.map(group => [group.label, group.items.map(entry => entry.id)])).toEqual([['Pane', ['pane-new', 'pane-old']], ['Doozy', ['doozy']]]);
  });

  it('keeps one project on two machines as two groups', () => {
    const items = [item('here', 1, inProject('Pane')), item('there', 2, { ...inProject('Pane'), machineId: 'studio', machine: 'studio' })];
    const { groups } = groupApprovals(items, 'waiting', 'project');
    expect(groups.map(group => [group.label, group.machineId])).toEqual([['Pane', 'studio'], ['Pane', undefined]]);
  });

  it('puts an item with no project under "No project", in order of its newest item', () => {
    const items = [
      item('old-mac', 3, { machineId: 'studio', machine: 'studio' }),
      item('pane', 2, inProject('Pane')),
      item('loose', 1),
      item('blank', 1, { source: { name: 'x', agent: 'Claude', project: '' } }),
    ];
    const { groups } = groupApprovals(items, 'waiting', 'project');
    expect(groups.map(group => [group.label, group.items.map(entry => entry.id)])).toEqual([['No project', ['old-mac', 'blank', 'loose']], ['Pane', ['pane']]]);
  });

  it('sorts Answered by when each was answered', () => {
    const items = [
      item('a', 9, { ...inProject('Pane'), state: 'answered', resolvedAt: 10 }),
      item('b', 1, { ...inProject('Doozy'), state: 'answered', resolvedAt: 30 }),
      item('c', 2, { ...inProject('Pane'), state: 'answered', resolvedAt: 20 }),
    ];
    const { groups } = groupApprovals(items, 'answered', 'project');
    expect(groups.map(group => [group.label, group.items.map(entry => entry.id)])).toEqual([['Doozy', ['b']], ['Pane', ['c', 'a']]]);
  });
});

describe('the sort, remembered on this computer', () => {
  it('reads each sort back, and Most recent from anything else', () => {
    expect(parseApprovalsSort('session')).toBe('session');
    expect(parseApprovalsSort('project')).toBe('project');
    expect(parseApprovalsSort('recent')).toBe('recent');
    expect(parseApprovalsSort('nonsense')).toBe('recent');
    expect(parseApprovalsSort('toString')).toBe('recent');
    expect(parseApprovalsSort(null)).toBe('recent');
  });

  it('reads a bad value, or a store that throws, as Most recent', () => {
    expect(readApprovalsSort(() => 'project')).toBe('project');
    expect(readApprovalsSort(() => '{"bad":1}')).toBe('recent');
    expect(readApprovalsSort(() => { throw new Error('storage is blocked'); })).toBe('recent');
  });

  it('saves the choice, and carries on when the store throws', () => {
    const saved: string[] = [];
    saveApprovalsSort('session', value => { saved.push(value); });
    expect(saved).toEqual(['session']);
    expect(() => saveApprovalsSort('session', () => { throw new Error('storage is full'); })).not.toThrow();
  });
});

describe('besideOf', () => {
  const worker = item('q', 1, { source: { paneId: 'pane-1', panelId: 'tab-a', name: 'api-fix', agent: 'Claude', session: launch } });

  it("shows this machine's item beside its Pane, on the asking tab", () => {
    expect(besideOf(worker, 'local')).toEqual({ kind: 'pane', paneId: 'pane-1', panelId: 'tab-a', name: 'api-fix' });
    expect(besideOf({ ...worker, machineId: 'local', machine: 'macbook' }, 'local')).toMatchObject({ kind: 'pane' });
  });

  it('offers to switch for an item from any other machine, this computer included while another is active', () => {
    const connected = { kind: 'session', id: 'session-1', name: 'Pane Fixes', paneId: 'session-pane' };
    expect(besideOf({ ...worker, machineId: 'local', machine: 'macbook' }, 'studio')).toEqual({ kind: 'machine', machineId: 'local', machine: 'macbook', connected });
    expect(besideOf({ ...worker, machineId: 'studio', machine: 'studio' }, 'local')).toEqual({ kind: 'machine', machineId: 'studio', machine: 'studio', connected });
    expect(besideOf({ ...worker, machineId: 'studio', machine: 'studio' }, 'studio')).toMatchObject({ kind: 'pane' });
  });

  it("shows the Session for an orchestrator's item and for a fallback item", () => {
    expect(besideOf(item('o', 1, { source: { name: 'Launch', agent: 'Claude', session: { ...launch, orchestrator: true } } }), 'local')).toMatchObject({ kind: 'session', sessionId: 'session-1' });
    expect(besideOf({ ...worker, relay: { inboxItemId: 'in-1', worker: 'api-fix', question: 'q' } }, 'local')).toMatchObject({ kind: 'session', paneId: 'session-pane' });
  });

  it("shows the Session Autopilot's item is about, or Autopilot", () => {
    const own = { name: 'Autopilot', agent: 'Claude', paneId: '__autopilot_owner', panelId: 'owner-tab', autopilot: true };
    expect(besideOf(item('a', 1, { source: own }), 'local')).toEqual({ kind: 'autopilot' });
    expect(besideOf(item('a', 1, { source: own, connected: { kind: 'autopilot', id: 'autopilot', name: 'Autopilot' } }), 'local')).toEqual({ kind: 'autopilot' });
    expect(besideOf(item('a', 1, { source: own, connected: { kind: 'session', id: 's9', name: 'Sales', paneId: 'p9' } }), 'local'))
      .toEqual({ kind: 'session', sessionId: 's9', paneId: 'p9', name: 'Sales' });
  });

  it('shows a connected Session when the asking Pane is unknown, a connected Pane, and only the name for a machine', () => {
    const session = { kind: 'session', id: 's9', name: 'Sales', paneId: 'p9' } as const;
    expect(besideOf(item('s', 1, { connected: session }), 'local')).toMatchObject({ kind: 'session', sessionId: 's9' });
    expect(besideOf(item('p', 1, { connected: { kind: 'pane', id: 'p3', name: 'docs' } }), 'local')).toEqual({ kind: 'pane', paneId: 'p3', name: 'docs' });
    expect(besideOf(item('m', 1, { connected: { kind: 'machine', id: 'm', name: 'my-folder' } }), 'local')).toEqual({ kind: 'none', name: 'my-folder' });
  });

  it('mounts nothing for an item Pane closed because its asker is gone', () => {
    expect(besideOf({ ...worker, state: 'expired', closed: { by: 'pane', reason: 'Session archived', at: 1 } }, 'local')).toEqual({ kind: 'none', name: 'Pane Fixes' });
    expect(besideOf({ ...worker, state: 'expired', closed: { by: 'you', reason: '', at: 1 } }, 'local')).toMatchObject({ kind: 'pane' });
  });

  it("names the Session on another machine's item, and never the local kinds that mount a terminal", () => {
    const away = besideOf({ ...worker, machineId: 'studio', machine: 'Mac mini' }, 'local');
    expect(away.kind).toBe('machine');
    expect(away).toMatchObject({ machine: 'Mac mini', connected: { kind: 'session', name: 'Pane Fixes' } });
  });
});

describe('connectedOf', () => {
  it('uses the item\'s connection when it has one', () => {
    const connected = { kind: 'pane', id: 'p1', name: 'docs' } as const;
    expect(connectedOf(item('a', 1, { connected, source: { name: 'x', agent: 'Claude', session: launch } }))).toEqual(connected);
  });

  it('falls back on the source for an older machine', () => {
    expect(connectedOf(item('a', 1, { source: { name: 'x', agent: 'Claude', session: launch } }))).toEqual({ kind: 'session', id: 'session-1', name: 'Pane Fixes', paneId: 'session-pane' });
    expect(connectedOf(item('b', 1, { source: { name: 'Autopilot', agent: 'Claude', autopilot: true } }))).toMatchObject({ kind: 'autopilot' });
    expect(connectedOf(item('c', 1, { source: { name: 'api-fix', agent: 'Claude', paneId: 'p1' } }))).toEqual({ kind: 'pane', id: 'p1', name: 'api-fix' });
    expect(connectedOf(item('d', 1, { source: { name: 'my-folder', agent: 'Claude' } }))).toMatchObject({ kind: 'machine', name: 'my-folder' });
  });
});

describe('the Waiting list', () => {
  const offline = (id: string, machine: string, extra: Partial<NotifyItem> = {}) => item(id, 1, { machine, machineId: machine, unreachable: true, ...extra });

  it('collapses an offline machine\'s items to one row per machine, out of the groups and the count', () => {
    const items = [item('here', 1), offline('a', 'Mac mini'), offline('b', 'Mac mini'), offline('c', 'studio'), offline('old', 'studio', { state: 'answered' })];
    const queue = groupApprovals(items, 'waiting', 'recent');
    expect(queue.waiting).toBe(1);
    expect(queue.list.map(entry => entry.id)).toEqual(['here']);
    expect(queue.offline).toEqual([{ machineId: 'Mac mini', machine: 'Mac mini', count: 2 }, { machineId: 'studio', machine: 'studio', count: 1 }]);
    expect(offlineRowText(queue.offline[0])).toBe('Mac mini offline · 2 waiting · they come back when Mac mini is online');
    expect(groupApprovals(items, 'answered', 'recent').list.map(entry => entry.id)).toEqual(['old']);
  });

  it('files stale items apart, oldest first, out of the count, and an offline machine\'s stale item stays in its row', () => {
    const items = [item('fresh', 5), item('newer', 3, { staleSince: 9 }), item('older', 2, { staleSince: 8 }), offline('gone', 'studio', { staleSince: 8 })];
    const queue = groupApprovals(items, 'waiting', 'recent');
    expect(queue.waiting).toBe(1);
    expect(queue.stale.map(entry => entry.id)).toEqual(['older', 'newer']);
    expect(queue.list.map(entry => entry.id)).toEqual(['fresh']);
    expect(queue.offline).toEqual([{ machineId: 'studio', machine: 'studio', count: 1 }]);
    expect(groupApprovals(items, 'answered', 'recent').stale).toEqual([]);
    // Every sort leaves the two where they are.
    expect(groupApprovals(items, 'waiting', 'project').stale.map(entry => entry.id)).toEqual(['older', 'newer']);
    expect(groupApprovals(items, 'waiting', 'session').offline).toEqual(queue.offline);
  });

  it('shows a mirror from an older machine, but does not count it', () => {
    const relay = { inboxItemId: 'in-1', worker: 'api-fix', question: 'q' };
    const queue = groupApprovals([item('mirror', 1, { relay, machine: 'old-mac', machineId: 'old-mac' }), item('real', 2)], 'waiting', 'recent');
    expect(queue.waiting).toBe(1);
    expect(queue.list.map(entry => entry.id)).toEqual(['real', 'mirror']);
    expect(offlineRows([item('mirror', 1, { relay })])).toEqual([]);
    expect(relayReadOnlyLine(item('mirror', 1, { relay, machine: 'old-mac' }))).toBe('Read-only: old-mac runs an older Pane. Answer there.');
    expect(`${relayReadOnlyLine(item('m', 1, { relay }))}`).not.toMatch(/stuck/i);
  });
});

describe('approvalRowLines', () => {
  const source = { name: 'workos-sso', agent: 'Claude', session: { id: 's', name: 'Sales Skill', paneId: 'p' } };

  it('shows where a waiting item came from', () => {
    expect(approvalRowLines(item('a', 1, { source, machine: 'Mac mini' }))).toEqual({ origin: 'workos-sso in Sales Skill · Mac mini' });
  });

  it('shows the answer and its receipt on an answered row', () => {
    expect(approvalRowLines(item('a', 1, { source, state: 'answered', answerSummary: 'Yes', answeredBy: { by: 'autopilot', because: 'D-22' }, decision: 'D-147' })).acted)
      .toBe('→ Yes · Answered by Autopilot · because D-22 · Recorded as D-147');
  });

  it('says so while an answer has yet to reach the tab that asked', () => {
    const owed = item('a', 1, { source: { ...source, paneId: 'p', panelId: 'tab' }, state: 'answered', answerSummary: 'USD', answeredBy: { by: 'you' } });
    expect(approvalRowLines(owed).acted).toBe('→ USD · Answered by you · not delivered to workos-sso yet');
    expect(approvalRowLines({ ...owed, delivered: { via: 'tab', at: 2 } }).acted).toBe('→ USD · Answered by you');
    expect(approvalRowLines({ ...owed, undelivered: { reason: 'its tab closed', at: 2 } }).acted).toBe('→ USD · Answered by you · not delivered to workos-sso: its tab closed');
  });

  it('reads Closed in place of Expired once closed, and Expired only when it just ended', () => {
    expect(approvalRowLines(item('a', 1, { source, state: 'expired', closed: { by: 'pane', reason: 'Session archived', at: 2 } })).acted).toBe('Closed: Session archived');
    expect(approvalRowLines(item('a', 1, { source, state: 'expired' })).acted).toBe('Expired');
    expect(approvalRowLines(item('a', 1, { source, state: 'info' })).acted).toBe('Update');
  });

  it('shows a rewrite on the new item', () => {
    expect(approvalRowLines(item('a', 1, { source, rewrittenFrom: { id: 'o', title: 'x', qn: 'Q-3' } })).acted).toBe('Rewritten by Autopilot from Q-3');
  });

  it('marks a mirror from an older machine read-only', () => {
    const line = approvalRowLines(item('a', 1, { source, relay: { inboxItemId: 'i', worker: 'w', question: 'q' } }));
    expect(line.acted).toBe('Read-only');
  });
});
