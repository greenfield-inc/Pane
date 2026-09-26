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
  usePanelStore.setState({ panels: {}, activePanels: {}, activityStatus: {}, agentStatus: {}, agentStatusSession: {} });

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
