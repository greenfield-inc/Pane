import { describe, expect, it } from 'vitest';
import type { NotifyItem } from '../../../../shared/types/notify';
import { agentFarmProfileOf, movedLine, heldBackChecks, sessionOpenApprovals } from './rules';
import { buildPathMap } from './pathMap';

describe('agentFarmProfileOf', () => {
  it('reads the profile an Agent Farm tab launches, without its variant', () => {
    expect(agentFarmProfileOf('agent-farm run greenfield/implementer:opus --arg parent=/x')).toBe('greenfield/implementer');
    expect(agentFarmProfileOf('claude --dangerously-skip-permissions')).toBeNull();
  });
});

describe('movedLine', () => {
  it('names both machines and the path map, and asks to restart watches and servers', () => {
    const map = buildPathMap({ sourceHome: '/Users/alice', targetHome: '/Users/robert-b', entries: [] });
    const line = movedLine('studio-a', 'studio-b', map);
    expect(line).toContain('from studio-a to studio-b');
    expect(line).toContain('/Users/alice → /Users/robert-b');
    expect(line).toMatch(/re-arm your runpane watch/);
    expect(line).toMatch(/moved\.json/);
  });
});

describe('heldBackChecks', () => {
  const tab = (queued: number, running: boolean) => ({ panelId: 'p1', title: 'Chat', running, queued });

  it('blocks a Session with open approvals, which the target\'s Notify would not show (F-9)', () => {
    expect(heldBackChecks(2, [], false)).toEqual([expect.objectContaining({ id: 'approvals', level: 'block', title: '2 open approvals in this Session' })]);
  });

  it('blocks queued chat messages that would not send before the tab stops (F-5)', () => {
    expect(heldBackChecks(0, [tab(1, true)], false)).toEqual([]);
    expect(heldBackChecks(0, [tab(1, false)], false)).toEqual([expect.objectContaining({ id: 'queue:p1', level: 'block' })]);
    // Once every tab stopped (Stop now), even a running tab's queue stays behind.
    expect(heldBackChecks(0, [tab(3, true)], true)).toEqual([expect.objectContaining({ title: '3 messages waiting in Chat' })]);
    expect(heldBackChecks(0, [tab(0, false)], true)).toEqual([]);
  });
});

describe('sessionOpenApprovals', () => {
  const item = (id: string, extra: Partial<NotifyItem> = {}): NotifyItem => ({
    id, ui: 'approve', title: `Q-${id}: Ship it?`, state: 'waiting', createdAt: 1,
    source: { name: 'worker', agent: 'Claude', paneId: 'member-pane', panelId: 'tab-1', session: { id: 'session-1', name: 'Doozy', paneId: 'orch-pane' } },
    ...extra,
  });
  const ids = ['session-1', 'orch-pane', 'member-pane'];

  it('lets a Session whose only approvals were dismissed pass the move check', () => {
    const open = sessionOpenApprovals([item('1', { dismissedAt: 5 }), item('2', { dismissedAt: 6 })], ids);
    expect(open).toEqual([]);
    expect(heldBackChecks(open.length, [], false)).toEqual([]);
  });

  it('still blocks a Session with a dismissed and a genuinely open approval', () => {
    const open = sessionOpenApprovals([item('1', { dismissedAt: 5 }), item('2')], ids);
    expect(open.map(approval => approval.id)).toEqual(['2']);
    expect(heldBackChecks(open.length, [], false)).toEqual([expect.objectContaining({ id: 'approvals', level: 'block', title: '1 open approval in this Session' })]);
  });

  it('holds the move for an answer in its Undo hold, and ignores other Sessions\' approvals', () => {
    const elsewhere = item('3', { source: { name: 'w', agent: 'Claude', paneId: 'other-pane', panelId: 't', session: { id: 'session-2', name: 'X', paneId: 'x' } } });
    expect(sessionOpenApprovals([item('1', { state: 'sent' }), elsewhere, item('4', { state: 'answered' })], ids).map(approval => approval.id)).toEqual(['1']);
  });
});
