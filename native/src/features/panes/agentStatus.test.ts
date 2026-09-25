import { describe, expect, it } from 'vitest';

import type { RunpaneWorkspaceStateResult } from '@shared/types/runpaneOrchestration';

import {
  agentStatusFromWorkspace,
  applyAgentStatusEvent,
  emptyAgentStatus,
  markSeen,
  paneAgent,
  paneDisplayStatus,
} from './agentStatus';

function workspace(panes: Array<{ paneId: string; panels: Array<{ panelId: string; agentType?: string; agentState: 'idle' | 'working' | 'blocked' }> }>): RunpaneWorkspaceStateResult {
  return {
    ok: true,
    epoch: 'e1',
    generation: 3,
    entries: panes.map(pane => ({
      gen: 3,
      at: '2026-09-25T08:00:00.000Z',
      kind: 'pane.created',
      source: 'session',
      paneId: pane.paneId,
      paneName: pane.paneId,
      baseline: true,
      panels: pane.panels.map(panel => ({ ...panel, title: panel.agentType ?? 'Terminal' })),
    })),
  };
}

describe('agentStatusFromWorkspace', () => {
  it('reads each pane’s status from its agent panels and ignores plain terminals', () => {
    const snapshot = agentStatusFromWorkspace(workspace([
      { paneId: 'a', panels: [{ panelId: 'shell', agentState: 'idle' }, { panelId: 'claude', agentType: 'claude', agentState: 'working' }] },
      { paneId: 'b', panels: [{ panelId: 'shell-b', agentState: 'idle' }] },
      { paneId: 'c', panels: [{ panelId: 'codex', agentType: 'codex', agentState: 'blocked' }] },
    ]));

    expect(paneDisplayStatus(snapshot, 'a')).toBe('working');
    expect(paneDisplayStatus(snapshot, 'b')).toBe('unknown');
    expect(paneDisplayStatus(snapshot, 'c')).toBe('blocked');
    expect(paneAgent(snapshot, 'a')).toBe('claude');
    expect(paneAgent(snapshot, 'b')).toBeUndefined();
  });

  it('keeps an unseen finish across a refetch while the pane is still idle', () => {
    let snapshot = agentStatusFromWorkspace(workspace([{ paneId: 'a', panels: [{ panelId: 'p', agentType: 'claude', agentState: 'working' }] }]));
    snapshot = applyAgentStatusEvent(snapshot, { panelId: 'p', sessionId: 'a', state: 'idle', reason: null });

    const refetched = agentStatusFromWorkspace(
      workspace([{ paneId: 'a', panels: [{ panelId: 'p', agentType: 'claude', agentState: 'idle' }] }]),
      snapshot,
    );

    expect(paneDisplayStatus(refetched, 'a')).toBe('done');
  });

  it('calls a pane ready when it finished while the phone was disconnected', () => {
    const before = agentStatusFromWorkspace(workspace([{ paneId: 'a', panels: [{ panelId: 'p', agentType: 'claude', agentState: 'working' }] }]));
    const afterReconnect = agentStatusFromWorkspace(
      workspace([{ paneId: 'a', panels: [{ panelId: 'p', agentType: 'claude', agentState: 'idle' }] }]),
      before,
    );
    expect(paneDisplayStatus(afterReconnect, 'a')).toBe('done');
  });

  it('knows the agent from the host’s agent entries when the panel was started by hand', () => {
    const state = workspace([{ paneId: 'a', panels: [{ panelId: 'p', agentState: 'idle' }] }]);
    state.entries.push({ gen: 3, at: '', kind: 'agent.busy', source: 'agent', paneId: 'a', paneName: 'a', panelId: 'p', agentType: 'codex', to: 'working' });
    const snapshot = agentStatusFromWorkspace(state);
    expect(paneDisplayStatus(snapshot, 'a')).toBe('working');
    expect(paneAgent(snapshot, 'a')).toBe('codex');
  });
});

describe('applyAgentStatusEvent', () => {
  it('marks a pane ready when its agent finishes, until the pane is opened', () => {
    let snapshot = applyAgentStatusEvent(emptyAgentStatus, { panelId: 'p', sessionId: 'a', state: 'working', reason: null });
    expect(paneDisplayStatus(snapshot, 'a')).toBe('working');

    snapshot = applyAgentStatusEvent(snapshot, { panelId: 'p', sessionId: 'a', state: 'idle', reason: null });
    expect(paneDisplayStatus(snapshot, 'a')).toBe('done');

    snapshot = markSeen(snapshot, 'a');
    expect(paneDisplayStatus(snapshot, 'a')).toBe('idle');
  });

  it('does not call an agent that was already idle ready', () => {
    const snapshot = applyAgentStatusEvent(emptyAgentStatus, { panelId: 'p', sessionId: 'a', state: 'idle', reason: null });
    expect(paneDisplayStatus(snapshot, 'a')).toBe('idle');
  });

  it('lets a blocked panel win over a working one in the same pane', () => {
    let snapshot = applyAgentStatusEvent(emptyAgentStatus, { panelId: 'p1', sessionId: 'a', state: 'working', reason: null });
    snapshot = applyAgentStatusEvent(snapshot, { panelId: 'p2', sessionId: 'a', state: 'blocked', reason: 'agent-prompt' });
    expect(paneDisplayStatus(snapshot, 'a')).toBe('blocked');
  });
});
