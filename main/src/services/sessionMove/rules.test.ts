import { describe, expect, it } from 'vitest';
import type { NotifyItem } from '../../../../shared/types/notify';
import { agentFarmProfileOf, movedLine, heldBackChecks, sessionApprovals } from './rules';
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
  const none = { carried: [], held: [] };

  it('lets open approvals move with the Session, and says so (T-44)', () => {
    expect(heldBackChecks({ carried: [item('1'), item('2')], held: [] }, [], false)).toEqual([expect.objectContaining({ id: 'approvals', level: 'ok', title: '2 open approvals move with the Session' })]);
  });

  it('blocks only an approval that can\'t move yet: an answer in its Undo hold, or a secret request', () => {
    expect(heldBackChecks({ carried: [item('1')], held: [item('2', { state: 'sent' })] }, [], false)).toEqual([
      expect.objectContaining({ id: 'approvals', level: 'block', title: '1 approval in this Session can\'t move yet' }),
    ]);
  });

  it('blocks queued chat messages that would not send before the tab stops (F-5)', () => {
    expect(heldBackChecks(none, [tab(1, true)], false)).toEqual([]);
    expect(heldBackChecks(none, [tab(1, false)], false)).toEqual([expect.objectContaining({ id: 'queue:p1', level: 'block' })]);
    // Once every tab stopped (Stop now), even a running tab's queue stays behind.
    expect(heldBackChecks(none, [tab(3, true)], true)).toEqual([expect.objectContaining({ title: '3 messages waiting in Chat' })]);
    expect(heldBackChecks(none, [tab(0, false)], true)).toEqual([]);
  });
});

function item(id: string, extra: Partial<NotifyItem> = {}): NotifyItem {
  return {
    id, ui: 'approve', title: `Q-${id}: Ship it?`, state: 'waiting', createdAt: 1,
    source: { name: 'worker', agent: 'Claude', paneId: 'member-pane', panelId: 'tab-1', session: { id: 'session-1', name: 'Doozy', paneId: 'orch-pane' } },
    ...extra,
  };
}

describe('sessionApprovals', () => {
  const ids = ['session-1', 'orch-pane', 'member-pane'];

  it('carries waiting approvals, dismissed ones too, and holds none of them (T-3, T-44)', () => {
    const found = sessionApprovals([item('1', { dismissedAt: 5 }), item('2')], ids);
    expect(found.carried.map(approval => approval.id)).toEqual(['1', '2']);
    expect(found.held).toEqual([]);
  });

  it('holds an answer in its Undo hold, and an open card that can\'t move; ignores other Sessions\' and ended ones', () => {
    const elsewhere = item('3', { source: { name: 'w', agent: 'Claude', paneId: 'other-pane', panelId: 't', session: { id: 'session-2', name: 'X', paneId: 'x' } } });
    // SAFETY: sessionApprovals reads only whether these fields are present, never their contents.
    const secret = item('5', { secret: { project: 'p', name: 'TOKEN' } as NotifyItem['secret'] });
    // SAFETY: as above, only its presence counts.
    const prompt = item('6', { agentPrompt: {} as NotifyItem['agentPrompt'] });
    const found = sessionApprovals([item('1', { state: 'sent' }), elsewhere, item('4', { state: 'answered' }), secret, prompt, item('7', { dismissedAt: 1, secret: secret.secret })], ids);
    expect(found.held.map(approval => approval.id)).toEqual(['1', '5', '6']);
    expect(found.carried).toEqual([]);
  });
});
