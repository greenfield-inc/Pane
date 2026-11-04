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
    this.update({ keepAwakeWhileSessionsActive: enabled });
  }

  update(changes: Partial<AppConfig>): void {
    this.config = { ...this.config, ...changes };
    this.emit('config-updated', this.getConfig());
  }
}

class PowerSourceStub extends EventEmitter {
  onBattery = false;

  isOnBattery(): boolean {
    return this.onBattery;
  }

  unplug(): void {
    this.onBattery = true;
    this.emit('on-battery');
  }

  plugIn(): void {
    this.onBattery = false;
    this.emit('on-ac');
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

function createLogger() {
  return { info: vi.fn(), warn: vi.fn() };
}

function createHelper(calls: () => string[], stops: Array<() => void>) {
  return {
    start: vi.fn((mode: string) => {
      calls().push(`helper:start:${mode}`);
      const stop = vi.fn(() => {
        calls().push(`helper:stop:${mode}`);
      });
      stops.push(stop);
      return { stop };
    }),
  };
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
  let powerSource: PowerSourceStub;
  let manager: PowerSaveManager;

  beforeEach(() => {
    powerSaveBlocker.start.mockClear();
    powerSaveBlocker.stop.mockClear();
    powerSaveBlocker.isStarted.mockClear();
    configManager = new ConfigManagerStub();
    sessionManager = new SessionManagerStub();
    panelActivity = new PanelActivityStub();
    powerSource = new PowerSourceStub();
    manager = new PowerSaveManager(configManager, sessionManager, panelActivity, {
      blocker: powerSaveBlocker,
      powerSource,
      helper: null,
    });
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
    manager = new PowerSaveManager(configManager, sessionManager, panelActivity, {
      blocker: powerSaveBlocker,
      powerSource,
      helper: null,
    });
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

  describe('power modes', () => {
    let calls: string[] = [];
    let helperStops: Array<() => void> = [];
    let helper = createHelper(() => calls, helperStops);
    let logger = createLogger();

    function createManager(options: { windows?: boolean; pollMs?: number | null } = {}): void {
      manager.dispose();
      calls = [];
      manager = new PowerSaveManager(configManager, sessionManager, panelActivity, {
        blocker: powerSaveBlocker,
        powerSource,
        helper: options.windows === false ? null : helper,
        powerSourcePollMs: options.pollMs ?? null,
        logger,
      });
    }

    function startWork(): void {
      sessionManager.emit('session-created', createSession('session-1', 'running'));
    }

    beforeEach(() => {
      helperStops = [];
      logger = createLogger();
      helper = createHelper(() => calls, helperStops);
      powerSaveBlocker.start.mockImplementation((type: string) => {
        calls.push(`blocker:start:${type}`);
        return 42;
      });
      powerSaveBlocker.stop.mockImplementation(() => {
        calls.push('blocker:stop');
      });
      createManager();
    });

    afterEach(() => {
      powerSaveBlocker.start.mockImplementation(() => 42);
      powerSaveBlocker.stop.mockImplementation(() => undefined);
    });

    it('holds app suspension and the Windows system request while plugged in', () => {
      startWork();

      expect(calls).toEqual(['blocker:start:prevent-app-suspension', 'helper:start:system-required']);
    });

    it('holds nothing on battery while the battery option is off (the default)', () => {
      powerSource.onBattery = true;
      startWork();

      expect(calls).toEqual([]);
    });

    it('keeps the screen on and presses F15 on Windows battery when the battery option is on', () => {
      configManager.update({ keepAwakeOnBattery: true });
      powerSource.onBattery = true;
      startWork();

      expect(calls).toEqual(['blocker:start:prevent-display-sleep', 'helper:start:press-f15']);
    });

    it('holds only Electron blockers on macOS and Linux', () => {
      createManager({ windows: false });
      configManager.update({ keepAwakeOnBattery: true });
      startWork();
      powerSource.unplug();

      expect(calls).toEqual([
        'blocker:start:prevent-app-suspension',
        'blocker:stop',
        'blocker:start:prevent-display-sleep',
      ]);
    });

    it('holds nothing while plugged in when the plugged-in option is off', () => {
      configManager.update({ keepAwakeWhilePluggedIn: false, keepAwakeOnBattery: true });
      startWork();

      expect(calls).toEqual([]);
    });

    it('holds nothing in either power state when both options are off', () => {
      configManager.update({ keepAwakeWhilePluggedIn: false, keepAwakeOnBattery: false });
      startWork();
      powerSource.unplug();
      powerSource.plugIn();

      expect(calls).toEqual([]);
    });

    it('holds nothing when the master toggle is off, whatever the options say', () => {
      configManager.update({ keepAwakeWhileSessionsActive: false, keepAwakeOnBattery: true });
      startWork();
      powerSource.unplug();

      expect(calls).toEqual([]);
    });

    it('releases the plugged-in mode before holding battery mode when unplugged, and back', () => {
      configManager.update({ keepAwakeOnBattery: true });
      startWork();
      calls = [];

      powerSource.unplug();
      expect(calls).toEqual([
        'blocker:stop',
        'helper:stop:system-required',
        'blocker:start:prevent-display-sleep',
        'helper:start:press-f15',
      ]);

      calls = [];
      powerSource.plugIn();
      expect(calls).toEqual([
        'blocker:stop',
        'helper:stop:press-f15',
        'blocker:start:prevent-app-suspension',
        'helper:start:system-required',
      ]);
    });

    it('releases everything when unplugged with the battery option off', () => {
      startWork();
      calls = [];

      powerSource.unplug();

      expect(calls).toEqual(['blocker:stop', 'helper:stop:system-required']);
      expect(logger.info).toHaveBeenLastCalledWith(expect.stringContaining('plugged-in -> off'));
    });

    it('applies the mode again from scratch after the computer wakes', () => {
      startWork();
      calls = [];

      powerSource.emit('resume');

      expect(calls).toEqual([
        'blocker:stop',
        'helper:stop:system-required',
        'blocker:start:prevent-app-suspension',
        'helper:start:system-required',
      ]);
      expect(logger.info).toHaveBeenLastCalledWith(expect.stringContaining('applied again because the computer woke'));
    });

    it('does nothing on wake when nothing is held', () => {
      powerSource.emit('resume');

      expect(calls).toEqual([]);
      expect(logger.info).not.toHaveBeenCalled();
    });

    it('releases the blocker and the helper when the master toggle turns off mid-session', () => {
      startWork();
      calls = [];

      configManager.setKeepAwake(false);
      expect(calls).toEqual(['blocker:stop', 'helper:stop:system-required']);

      calls = [];
      configManager.setKeepAwake(true);
      expect(calls).toEqual(['blocker:start:prevent-app-suspension', 'helper:start:system-required']);
    });

    it('releases the helper when the last session goes idle', () => {
      startWork();
      sessionManager.emit('session-updated', createSession('session-1', 'stopped'));

      expect(helperStops[0]).toHaveBeenCalledTimes(1);
    });

    it('keeps the Electron blocker and warns when the helper fails to start', () => {
      helper.start.mockImplementation(() => {
        throw new Error('spawn powershell.exe ENOENT');
      });
      startWork();

      expect(calls).toEqual(['blocker:start:prevent-app-suspension']);
      expect(logger.warn).toHaveBeenCalledTimes(1);
      expect(String(logger.warn.mock.calls[0][0])).toContain('spawn powershell.exe ENOENT');
    });

    it('logs each mode change once', () => {
      startWork();
      sessionManager.emit('session-created', createSession('session-2', 'running'));
      panelActivity.setState('panel-1', 'working');

      expect(logger.info).toHaveBeenCalledTimes(1);
      expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('off -> plugged-in'));
    });

    it('releases the helper and the blocker on dispose', () => {
      startWork();
      calls = [];
      manager.dispose();

      expect(calls).toEqual(['blocker:stop', 'helper:stop:system-required']);
    });

    describe('polling a power source without events (Linux)', () => {
      beforeEach(() => {
        vi.useFakeTimers();
        createManager({ windows: false, pollMs: 60_000 });
        configManager.update({ keepAwakeOnBattery: true });
      });

      afterEach(() => {
        vi.useRealTimers();
      });

      it('switches mode within one poll of the power source changing', () => {
        startWork();
        calls = [];
        powerSource.onBattery = true;

        vi.advanceTimersByTime(59_999);
        expect(calls).toEqual([]);
        vi.advanceTimersByTime(1);
        expect(calls).toEqual(['blocker:stop', 'blocker:start:prevent-display-sleep']);
      });

      it('stops polling once there is no activity', () => {
        const isOnBattery = vi.spyOn(powerSource, 'isOnBattery');
        startWork();
        sessionManager.emit('session-updated', createSession('session-1', 'stopped'));
        isOnBattery.mockClear();

        vi.advanceTimersByTime(10 * 60_000);
        expect(isOnBattery).not.toHaveBeenCalled();
      });
    });
  });

  it('defaults keep-awake to on while sessions are active, off while plugged in and on battery, for a fresh ConfigManager', () => {
    const config = new ConfigManager().getConfig();

    expect(config.keepAwakeWhileSessionsActive).toBe(true);
    expect(config.keepAwakeWhilePluggedIn).toBe(false);
    expect(config.keepAwakeOnBattery).toBe(false);
  });
});
