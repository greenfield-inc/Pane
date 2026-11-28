import { EventEmitter } from 'events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AppConfig } from '../types/config';
import type { AgentState } from '../../../shared/types/agentStatus';
import { DockBadgeManager } from './dockBadgeManager';

class ConfigManagerStub extends EventEmitter {
  private config: AppConfig = {};

  getConfig(): AppConfig {
    return { ...this.config };
  }

  update(changes: Partial<AppConfig>): void {
    this.config = { ...this.config, ...changes };
    this.emit('config-updated', this.getConfig());
  }
}

class PanelActivityStub extends EventEmitter {
  setState(panelId: string, state: AgentState, sessionId = 'pane-1'): void {
    this.emit('agent-status', { panelId, sessionId, state, reason: null });
  }
}

function createHarness() {
  const config = new ConfigManagerStub();
  const sessions = new EventEmitter();
  const panels = new PanelActivityStub();
  const setBadgeCount = vi.fn((_count: number) => true);
  const logger = { warn: vi.fn() };
  const manager = new DockBadgeManager(config, sessions, panels, { target: { setBadgeCount }, logger });
  return { config, sessions, panels, setBadgeCount, logger, manager };
}

describe('DockBadgeManager', () => {
  let harness: ReturnType<typeof createHarness> | null = null;

  afterEach(() => {
    harness?.manager.dispose();
    harness = null;
  });

  it('counts each blocked agent and goes back down when it is answered', () => {
    harness = createHarness();
    const { panels, setBadgeCount } = harness;

    panels.setState('panel-a', 'blocked');
    panels.setState('panel-b', 'blocked', 'pane-2');
    expect(setBadgeCount.mock.calls.map(([count]) => count)).toEqual([1, 2]);

    panels.setState('panel-a', 'working');
    expect(setBadgeCount).toHaveBeenLastCalledWith(1);
    expect(harness.manager.desiredCount()).toBe(1);
  });

  it('clears the badge with 0 once nothing waits on the person', () => {
    harness = createHarness();
    const { panels, setBadgeCount } = harness;

    panels.setState('panel-a', 'blocked');
    panels.setState('panel-a', 'idle');

    expect(setBadgeCount.mock.calls.map(([count]) => count)).toEqual([1, 0]);
  });

  it('does not set the badge again when the count is unchanged', () => {
    harness = createHarness();
    const { panels, setBadgeCount } = harness;

    panels.setState('panel-a', 'blocked');
    panels.setState('panel-a', 'blocked');
    panels.setState('panel-b', 'working');

    expect(setBadgeCount).toHaveBeenCalledTimes(1);
  });

  it('drops the blocked agents of an archived Pane', () => {
    harness = createHarness();
    const { panels, sessions, setBadgeCount } = harness;

    panels.setState('panel-a', 'blocked', 'pane-1');
    panels.setState('panel-b', 'blocked', 'pane-1');
    panels.setState('panel-c', 'blocked', 'pane-2');
    sessions.emit('session-deleted', { id: 'pane-1' });

    expect(setBadgeCount).toHaveBeenLastCalledWith(1);
  });

  it('shows nothing while the setting is off and the count again once it is back on', () => {
    harness = createHarness();
    const { config, panels, setBadgeCount } = harness;

    panels.setState('panel-a', 'blocked');
    config.update({ dockBadge: false });
    expect(setBadgeCount).toHaveBeenLastCalledWith(0);

    panels.setState('panel-b', 'blocked');
    expect(setBadgeCount).toHaveBeenLastCalledWith(0);

    config.update({ dockBadge: true });
    expect(setBadgeCount).toHaveBeenLastCalledWith(2);
  });

  it('logs and keeps going when the platform refuses the badge', () => {
    harness = createHarness();
    const { panels, setBadgeCount, logger } = harness;
    setBadgeCount.mockImplementationOnce(() => {
      throw new Error('badge unsupported');
    });

    expect(() => panels.setState('panel-a', 'blocked')).not.toThrow();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('badge unsupported'));

    panels.setState('panel-b', 'blocked');
    expect(setBadgeCount).toHaveBeenLastCalledWith(2);
  });

  it('clears the badge and stops listening on dispose', () => {
    harness = createHarness();
    const { manager, panels, setBadgeCount } = harness;

    panels.setState('panel-a', 'blocked');
    manager.dispose();
    panels.setState('panel-b', 'blocked');

    expect(setBadgeCount.mock.calls.map(([count]) => count)).toEqual([1, 0]);
  });
});
