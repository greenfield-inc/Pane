import { describe, expect, it } from 'vitest';
import { CloudDaemonHealthState, countAgentPanels, type ReadinessAgentPanel } from './readiness';

function stateWith(panels: ReadinessAgentPanel[]): CloudDaemonHealthState {
  const state = new CloudDaemonHealthState(() => 0);
  state.setVersion('2.4.141', 'abc1234');
  state.setAgentPanelSource(() => panels);
  return state;
}

describe('CloudDaemonHealthState', () => {
  it('is starting until bootstrap finishes, and reports version and start time', () => {
    const state = stateWith([]);

    expect(state.fields()).toEqual({
      version: '2.4.141',
      gitCommit: 'abc1234',
      startedAt: new Date(0).toISOString(),
      readiness: {
        state: 'starting',
        daemon: 'starting',
        agentRestore: 'none',
        agents: { expected: 0, ready: 0, starting: 0, blocked: 0, notRunning: 0 },
      },
    });

    state.markDaemonReady();
    expect(state.readiness().state).toBe('ready');
  });

  it('stays starting while agents restore or have not shown their composer yet', () => {
    const panels: ReadinessAgentPanel[] = [{ running: true, agentState: 'unknown' }];
    const state = stateWith(panels);
    state.markDaemonReady();
    state.setAgentRestorePhase('pending');
    expect(state.readiness().state).toBe('starting');

    state.setAgentRestorePhase('done');
    expect(state.readiness().state).toBe('starting');

    panels[0] = { running: true, agentState: 'idle' };
    expect(state.readiness()).toMatchObject({ state: 'ready', agents: { expected: 1, ready: 1 } });
  });

  it('is degraded when restore finished but an agent did not come back', () => {
    const state = stateWith([{ running: true, agentState: 'idle' }, { running: false }]);
    state.markDaemonReady();

    expect(state.readiness().state).toBe('ready');
    state.setAgentRestorePhase('done');
    expect(state.readiness().state).toBe('degraded');
    state.setAgentRestorePhase('done', { lazy: true });
    expect(state.readiness().state).toBe('ready');
  });

  it('still answers when reading panels fails', () => {
    const state = new CloudDaemonHealthState();
    state.setAgentPanelSource(() => {
      throw new Error('db closed');
    });
    state.markDaemonReady();

    expect(state.readiness().agents.expected).toBe(0);
  });
});

describe('countAgentPanels', () => {
  it('buckets each panel once', () => {
    expect(countAgentPanels([
      { running: true, agentState: 'idle' },
      { running: true, agentState: 'working' },
      { running: true, agentState: 'blocked' },
      { running: true },
      { running: false },
    ])).toEqual({ expected: 5, ready: 2, starting: 1, blocked: 1, notRunning: 1 });
  });
});
