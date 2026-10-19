import { EventEmitter } from 'events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppConfig } from '../types/config';
import type { Session } from '../types/session';
import type { AgentState } from '../../../shared/types/agentStatus';

const powerSaveBlocker = {
  start: vi.fn(() => 42),
  stop: vi.fn(),
  isStarted: vi.fn(() => true),
};

import { ConfigManager } from './configManager';
import { PowerSaveManager } from './powerSaveManager';

class ConfigManagerStub extends EventEmitter {
  private config: AppConfig = { keepAwakeWhileSessionsActive: true };

  getConfig(): AppConfig {
    return { ...this.config };
  }

  setKeepAwake(enabled: boolean): void {
    this.config = { ...this.config, keepAwakeWhileSessionsActive: enabled };
    this.emit('config-updated', this.getConfig());
  }
}

class SessionManagerStub extends EventEmitter {
  constructor(private readonly snapshotSessions: Session[] = []) {
    super();
  }

  getPowerSaveSnapshotSessions(): Session[] {
    return this.snapshotSessions;
  }
}

class PanelActivityStub extends EventEmitter {
  setState(panelId: string, state: AgentState): void {
    this.emit('agent-status', { panelId, sessionId: 'session-1', state, reason: null });
  }
}

function createSession(
  id: string,
  status: Session['status'],
  overrides: Partial<Session> = {},
): Session {
  return {
    id,
    name: id,
    worktreePath: `/tmp/${id}`,
    prompt: '',
    status,
    createdAt: new Date(),
    output: [],
    jsonMessages: [],
    ...overrides,
  };
}

describe('PowerSaveManager', () => {
  let configManager: ConfigManagerStub;
  let sessionManager: SessionManagerStub;
  let panelActivity: PanelActivityStub;
  let manager: PowerSaveManager;

  beforeEach(() => {
    powerSaveBlocker.start.mockClear();
    powerSaveBlocker.stop.mockClear();
    powerSaveBlocker.isStarted.mockClear();
    configManager = new ConfigManagerStub();
    sessionManager = new SessionManagerStub();
    panelActivity = new PanelActivityStub();
    manager = new PowerSaveManager(configManager, sessionManager, panelActivity, powerSaveBlocker);
  });

  afterEach(() => {
    manager.dispose();
  });

  it.each<Session['status']>(['initializing', 'ready', 'running', 'waiting'])(
    'starts exactly one app-suspension blocker for an active %s session',
    status => {
      sessionManager.emit('session-created', createSession('session-1', status));
      sessionManager.emit('session-updated', createSession('session-1', status));

      expect(powerSaveBlocker.start).toHaveBeenCalledTimes(1);
      expect(powerSaveBlocker.start).toHaveBeenCalledWith('prevent-app-suspension');
      expect(powerSaveBlocker.stop).not.toHaveBeenCalled();
    },
  );

  it('tracks an active main-repo session solely from events', () => {
    sessionManager.emit(
      'session-created',
      createSession('main-repo-session', 'running', { isMainRepo: true }),
    );

    expect(powerSaveBlocker.start).toHaveBeenCalledTimes(1);
    expect(powerSaveBlocker.start).toHaveBeenCalledWith('prevent-app-suspension');
  });

  it.each<Session['status']>(['stopped', 'error'])(
    'stops when the last active session reaches %s',
    status => {
      sessionManager.emit('session-created', createSession('session-1', 'running'));
      sessionManager.emit('session-updated', createSession('session-1', status));

      expect(powerSaveBlocker.stop).toHaveBeenCalledTimes(1);
      expect(powerSaveBlocker.stop).toHaveBeenCalledWith(42);
    },
  );

  it('stays held until every active session has stopped', () => {
    sessionManager.emit('session-created', createSession('session-1', 'running'));
    sessionManager.emit('session-created', createSession('session-2', 'waiting'));
    sessionManager.emit('session-updated', createSession('session-1', 'stopped'));

    expect(powerSaveBlocker.stop).not.toHaveBeenCalled();

    sessionManager.emit('session-updated', createSession('session-2', 'stopped'));
    expect(powerSaveBlocker.stop).toHaveBeenCalledTimes(1);
  });

  it('stays held across a running to waiting to running flap', () => {
    sessionManager.emit('session-created', createSession('session-1', 'running'));
    sessionManager.emit('session-updated', createSession('session-1', 'waiting'));
    sessionManager.emit('session-updated', createSession('session-1', 'running'));

    expect(powerSaveBlocker.start).toHaveBeenCalledTimes(1);
    expect(powerSaveBlocker.stop).not.toHaveBeenCalled();
  });

  it('stops when the last active session is archived', () => {
    sessionManager.emit('session-created', createSession('session-1', 'ready'));
    sessionManager.emit('session-deleted', { id: 'session-1' });

    expect(powerSaveBlocker.stop).toHaveBeenCalledTimes(1);
    expect(powerSaveBlocker.stop).toHaveBeenCalledWith(42);
  });

  it('acquires and releases for interrupted-session status events', () => {
    sessionManager.emit('session-updated', createSession('resumed-session', 'running'));
    sessionManager.emit('session-updated', createSession('resumed-session', 'stopped'));

    expect(powerSaveBlocker.start).toHaveBeenCalledTimes(1);
    expect(powerSaveBlocker.stop).toHaveBeenCalledTimes(1);
  });

  it('stops immediately when disabled and remains stopped for later active sessions', () => {
    sessionManager.emit('session-created', createSession('session-1', 'running'));

    configManager.setKeepAwake(false);
    sessionManager.emit('session-updated', createSession('session-1', 'stopped'));
    sessionManager.emit('session-created', createSession('session-2', 'running'));

    expect(powerSaveBlocker.stop).toHaveBeenCalledTimes(1);
    expect(powerSaveBlocker.start).toHaveBeenCalledTimes(1);
  });

  it('seeds session statuses from the sessions-loaded event', () => {
    sessionManager.emit('sessions-loaded', [
      createSession('stopped-session', 'stopped'),
      createSession('active-session', 'waiting'),
    ]);

    expect(powerSaveBlocker.start).toHaveBeenCalledTimes(1);
  });

  it('keeps a tracked active main-repo session held when sessions-loaded omits it', () => {
    sessionManager.emit(
      'session-created',
      createSession('main-repo-session', 'running', { isMainRepo: true }),
    );

    sessionManager.emit('sessions-loaded', [
      createSession('ordinary-session', 'stopped'),
    ]);

    expect(powerSaveBlocker.start).toHaveBeenCalledTimes(1);
    expect(powerSaveBlocker.stop).not.toHaveBeenCalled();
  });

  it('does not reacquire for an archived running update after prior deletion', () => {
    sessionManager.emit('session-deleted', { id: 'archived-session' });
    sessionManager.emit(
      'session-updated',
      createSession('archived-session', 'running', { archived: true }),
    );

    expect(powerSaveBlocker.start).not.toHaveBeenCalled();
    expect(powerSaveBlocker.stop).not.toHaveBeenCalled();
  });

  it('drops a previously active session when a late archived running update arrives', () => {
    sessionManager.emit('session-created', createSession('archived-session', 'running'));
    sessionManager.emit(
      'session-updated',
      createSession('archived-session', 'running', { archived: true }),
    );

    expect(powerSaveBlocker.start).toHaveBeenCalledTimes(1);
    expect(powerSaveBlocker.stop).toHaveBeenCalledTimes(1);
  });

  it('seeds active sessions from the construction snapshot before any event', () => {
    manager.dispose();
    powerSaveBlocker.start.mockClear();
    powerSaveBlocker.stop.mockClear();

    sessionManager = new SessionManagerStub([
      createSession('main-repo-session', 'running', { isMainRepo: true }),
      createSession('archived-session', 'running', { archived: true }),
      createSession('stopped-session', 'stopped'),
    ]);
    manager = new PowerSaveManager(configManager, sessionManager, panelActivity, powerSaveBlocker);
    manager.sync();

    expect(powerSaveBlocker.start).toHaveBeenCalledTimes(1);
    expect(powerSaveBlocker.start).toHaveBeenCalledWith('prevent-app-suspension');
    expect(powerSaveBlocker.stop).not.toHaveBeenCalled();
  });

  // Issue #610: session rows sit at stopped/interrupted while their agent panels
  // work, so a working panel must hold the blocker on its own.
  it('holds one blocker while an agent panel is working, with every session stopped', () => {
    sessionManager.emit('sessions-loaded', [createSession('session-1', 'stopped')]);
    panelActivity.setState('panel-1', 'working');
    panelActivity.setState('panel-1', 'working');

    expect(powerSaveBlocker.start).toHaveBeenCalledTimes(1);
    expect(powerSaveBlocker.start).toHaveBeenCalledWith('prevent-app-suspension');
    expect(powerSaveBlocker.stop).not.toHaveBeenCalled();
  });

  it.each<AgentState>(['idle', 'blocked', 'unknown'])(
    'releases when the last working panel turns %s',
    state => {
      panelActivity.setState('panel-1', 'working');
      panelActivity.setState('panel-2', 'working');
      panelActivity.setState('panel-1', state);

      expect(powerSaveBlocker.stop).not.toHaveBeenCalled();

      panelActivity.setState('panel-2', state);
      expect(powerSaveBlocker.stop).toHaveBeenCalledTimes(1);
      expect(powerSaveBlocker.stop).toHaveBeenCalledWith(42);
    },
  );

  it('stays held while a panel works after its session stops, and releases when both are idle', () => {
    sessionManager.emit('session-created', createSession('session-1', 'running'));
    panelActivity.setState('panel-1', 'working');
    sessionManager.emit('session-updated', createSession('session-1', 'stopped'));

    expect(powerSaveBlocker.stop).not.toHaveBeenCalled();

    panelActivity.setState('panel-1', 'idle');
    expect(powerSaveBlocker.start).toHaveBeenCalledTimes(1);
    expect(powerSaveBlocker.stop).toHaveBeenCalledTimes(1);
  });

  it('does not hold for a working panel while keep-awake is disabled', () => {
    configManager.setKeepAwake(false);
    panelActivity.setState('panel-1', 'working');

    expect(powerSaveBlocker.start).not.toHaveBeenCalled();

    configManager.setKeepAwake(true);
    expect(powerSaveBlocker.start).toHaveBeenCalledTimes(1);
  });

  it('stops listening to panel activity after dispose', () => {
    manager.dispose();
    panelActivity.setState('panel-1', 'working');

    expect(powerSaveBlocker.start).not.toHaveBeenCalled();
    expect(panelActivity.listenerCount('agent-status')).toBe(0);
  });

  it('defaults keep-awake to enabled for a fresh ConfigManager', () => {
    const freshConfigManager = new ConfigManager();

    expect(freshConfigManager.getConfig().keepAwakeWhileSessionsActive).toBe(true);
  });
});
