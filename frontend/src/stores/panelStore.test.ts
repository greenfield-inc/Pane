import { beforeEach, describe, expect, it } from 'vitest';
import { usePanelStore } from './panelStore';
import type { ToolPanel } from '../../../shared/types/panels';

const panel = (id: string, sessionId: string): ToolPanel => ({
  id,
  sessionId,
  type: 'terminal',
  title: 'Terminal',
  state: { isActive: false, customState: {} },
  metadata: { createdAt: '', lastActiveAt: '', position: 0 },
});

const reset = () =>
  usePanelStore.setState({
    panels: {}, activePanels: {}, activityStatus: {}, agentStatus: {},
    agentStatusSession: {}, lastActivityAt: {}, unviewedCompletedActivity: {},
  });

describe('panelStore agent status', () => {
  beforeEach(reset);

  it('stores and reads a panel agent state', () => {
    const store = usePanelStore.getState();
    store.setAgentStatus('p1', 's1', 'working');
    expect(usePanelStore.getState().getPanelAgentState('p1')).toBe('working');
  });

  it('rolls session state up by event sessionId, without panels loaded', () => {
    const store = usePanelStore.getState();
    // Note: no setPanels — rollup must work purely from status events.
    store.setAgentStatus('a', 's1', 'idle');
    store.setAgentStatus('b', 's1', 'working');
    expect(usePanelStore.getState().getSessionAgentState('s1')).toBe('working');
    usePanelStore.getState().setAgentStatus('c', 's1', 'blocked');
    expect(usePanelStore.getState().getSessionAgentState('s1')).toBe('blocked');
  });

  it('does not mix status across sessions', () => {
    const store = usePanelStore.getState();
    store.setAgentStatus('a', 's1', 'blocked');
    store.setAgentStatus('b', 's2', 'idle');
    expect(usePanelStore.getState().getSessionAgentState('s1')).toBe('blocked');
    expect(usePanelStore.getState().getSessionAgentState('s2')).toBe('idle');
  });

  it('returns unknown for a session with no tracked agent panels', () => {
    expect(usePanelStore.getState().getSessionAgentState('s2')).toBe('unknown');
  });

  it('prunes stale background status when panel lists are reloaded', () => {
    const store = usePanelStore.getState();
    store.setAgentStatus('deleted', 'background', 'working');
    store.setAgentStatus('retained', 'background', 'idle');
    store.setPanels('background', [panel('retained', 'background')]);
    expect(usePanelStore.getState().getPanelAgentState('deleted')).toBeUndefined();
    expect(usePanelStore.getState().getSessionAgentState('background')).toBe('idle');
  });

  it('clears agent status when a panel is removed', () => {
    const store = usePanelStore.getState();
    store.setPanels('s1', [panel('a', 's1')]);
    store.setAgentStatus('a', 's1', 'blocked');
    store.removePanel('s1', 'a');
    expect(usePanelStore.getState().getPanelAgentState('a')).toBeUndefined();
    expect(usePanelStore.getState().getSessionAgentState('s1')).toBe('unknown');
  });
});

describe('panelStore external deletion', () => {
  beforeEach(reset);

  it('forgets a pane deleted in a session whose panels were never loaded', () => {
    const store = usePanelStore.getState();
    // A background session: `panel:deleted` arrives for a pane the store only
    // ever saw a status event for. Without the session id, `removePanel` cannot
    // reach it and a stale `blocked` entry keeps the sidebar badge lit.
    store.setAgentStatus('a', 's1', 'blocked');
    store.setActivityStatus('a', 'active', '2026-01-01T00:00:00.000Z');

    usePanelStore.getState().forgetPanel('a');

    const next = usePanelStore.getState();
    expect(next.getPanelAgentState('a')).toBeUndefined();
    expect(next.activityStatus.a).toBeUndefined();
    expect(next.lastActivityAt.a).toBeUndefined();
    expect(next.getSessionAgentState('s1')).toBe('unknown');
  });

  it('forgets every pane of an archived session, loaded or not', () => {
    const store = usePanelStore.getState();
    store.setPanels('s1', [panel('a', 's1')]);
    store.setAgentStatus('a', 's1', 'working');
    // A second pane of the same session that only ever produced status events.
    store.setAgentStatus('b', 's1', 'blocked');
    store.setAgentStatus('c', 's2', 'blocked');
    store.markUnviewedCompletedActivity('s1', '2026-01-01T00:00:00.000Z');

    usePanelStore.getState().forgetSession('s1');

    const next = usePanelStore.getState();
    expect(next.getSessionAgentState('s1')).toBe('unknown');
    expect(next.getPanelAgentState('a')).toBeUndefined();
    expect(next.getPanelAgentState('b')).toBeUndefined();
    expect(next.hasUnviewedCompletedActivity('s1')).toBe(false);
    // Another session's agent is none of its business.
    expect(next.getPanelAgentState('c')).toBe('blocked');
  });
});
