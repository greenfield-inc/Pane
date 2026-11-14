import { EventEmitter } from 'events';
import { describe, expect, it, vi } from 'vitest';
import type { AppConfig } from '../types/config';
import type { BackgroundActivityProfile } from '../../../shared/types/backgroundActivity';
import { BackgroundActivity } from './backgroundActivity';

class Config extends EventEmitter {
  config: AppConfig = {};
  getConfig(): AppConfig {
    return this.config;
  }
  set(profile: BackgroundActivityProfile): void {
    this.config = { backgroundActivity: profile };
    this.emit('config-updated');
  }
}

/** A computer: lock, sleep, battery, Low Power Mode and remote apps, as the OS reports them. */
function computer(options: { lockEvents?: boolean; locked?: boolean } = {}) {
  const power = new EventEmitter();
  const remoteStreams = Object.assign(new EventEmitter(), { open: 0, count() { return this.open; } });
  const state = { locked: options.locked ?? false, onBattery: false, lowPower: false, now: 0, lowPowerReads: 0 };
  const config = new Config();
  const activity = new BackgroundActivity(config, {
    power,
    lockEvents: options.lockEvents ?? true,
    isLocked: () => state.locked,
    isOnBattery: () => state.onBattery,
    readLowPower: async () => {
      state.lowPowerReads += 1;
      return state.lowPower;
    },
    remoteStreams,
    now: () => state.now,
    logger: { info: () => {} },
  });
  const changes: boolean[] = [];
  activity.on('change', (away: boolean) => changes.push(away));
  return {
    activity, config, state, changes,
    lock() { state.locked = true; power.emit('lock-screen'); },
    unlock() { state.locked = false; power.emit('unlock-screen'); },
    unplug() { state.onBattery = true; power.emit('on-battery'); },
    sleep() { power.emit('suspend'); },
    wake() { power.emit('resume'); },
    openRemote() { remoteStreams.open += 1; remoteStreams.emit('change'); },
    closeRemote() { remoteStreams.open -= 1; remoteStreams.emit('change'); },
  };
}

const settle = () => new Promise(resolve => setImmediate(resolve));

describe('background activity', () => {
  it('is away while locked under Balanced, and back the moment the screen unlocks', () => {
    const pc = computer();
    pc.lock();
    expect(pc.activity.isAway()).toBe(true);
    pc.unlock();
    expect(pc.activity.isAway()).toBe(false);
    expect(pc.changes).toEqual([true, false]);
  });

  it('counts a locked screen as nobody looking, even with Pane focused in front', () => {
    const pc = computer();
    pc.activity.setWindowState({ focused: true, visible: true });
    pc.lock();
    expect(pc.activity.isAway()).toBe(true);
  });

  it('never pauses under Performance', () => {
    const pc = computer();
    pc.config.set('performance');
    pc.lock();
    pc.unplug();
    pc.sleep();
    expect(pc.activity.isAway()).toBe(false);
    expect(pc.changes).toEqual([]);
  });

  it('under Balanced keeps running on battery with the window minimized; Battery saver pauses then', () => {
    const pc = computer();
    pc.unplug();
    pc.activity.setWindowState({ focused: false, visible: false });
    expect(pc.activity.isAway()).toBe(false);
    pc.config.set('batterySaver');
    expect(pc.activity.isAway()).toBe(true);
  });

  it('keeps running under Battery saver on battery while the window is unfocused but on screen', () => {
    const pc = computer();
    pc.config.set('batterySaver');
    pc.unplug();
    pc.activity.setWindowState({ focused: false, visible: true });
    expect(pc.activity.isAway()).toBe(false);
    pc.activity.setWindowState({ visible: false });
    expect(pc.activity.isAway()).toBe(true);
    pc.activity.setWindowState({ visible: true });
    expect(pc.activity.isAway()).toBe(false);
  });

  it('counts an open phone or remote app as looking, even while the desktop is locked', () => {
    const pc = computer();
    pc.lock();
    pc.openRemote();
    expect(pc.activity.isAway()).toBe(false);
    pc.closeRemote();
    expect(pc.activity.isAway()).toBe(true);
  });

  it('is away during sleep and back on wake', () => {
    const pc = computer();
    pc.sleep();
    expect(pc.activity.isAway()).toBe(true);
    pc.wake();
    expect(pc.activity.isAway()).toBe(false);
  });

  it('pauses under Balanced in Low Power Mode once the window leaves the screen, reading it at most once a minute', async () => {
    const pc = computer();
    pc.state.lowPower = true;
    pc.activity.setWindowState({ focused: false, visible: false });
    await settle();
    expect(pc.activity.isAway()).toBe(true);
    expect(pc.state.lowPowerReads).toBe(1);

    pc.activity.setWindowState({ focused: true });
    pc.activity.setWindowState({ focused: false });
    await settle();
    expect(pc.state.lowPowerReads).toBe(1);

    pc.state.now = 61_000;
    pc.state.lowPower = false;
    pc.activity.setWindowState({ focused: true });
    pc.activity.setWindowState({ focused: false });
    await settle();
    expect(pc.state.lowPowerReads).toBe(2);
    expect(pc.activity.isAway()).toBe(false);
  });

  it('skips optional network work in Low Power Mode outside Performance, and on battery only under Battery saver', async () => {
    const pc = computer();
    pc.unplug();
    expect(await pc.activity.isConstrained()).toBe(false);
    pc.config.set('batterySaver');
    expect(await pc.activity.isConstrained()).toBe(true);

    pc.config.set('balanced');
    pc.state.lowPower = true;
    pc.state.now = 61_000;
    expect(await pc.activity.isConstrained()).toBe(true);
    pc.config.set('performance');
    expect(await pc.activity.isConstrained()).toBe(false);
  });

  it('sees Low Power Mode turn off while someone keeps looking, once the last read is a minute old', async () => {
    const pc = computer();
    pc.state.lowPower = true;
    expect(await pc.activity.isConstrained()).toBe(true);

    pc.state.lowPower = false;
    pc.state.now = 30_000;
    expect(await pc.activity.isConstrained()).toBe(true);
    pc.state.now = 61_000;
    expect(await pc.activity.isConstrained()).toBe(false);
    expect(pc.state.lowPowerReads).toBe(2);
  });

  it('sees a lock that ended without an unlock event, such as a screensaver at launch, once the window gains focus', () => {
    const pc = computer({ locked: true });
    pc.activity.setWindowState({ focused: false, visible: false });
    expect(pc.activity.isAway()).toBe(true);
    pc.state.locked = false;
    pc.activity.setWindowState({ focused: true, visible: true });
    expect(pc.activity.isAway()).toBe(false);
  });

  it('on Linux, sees an unlock within half a minute while the window stays on screen but unfocused', () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    try {
      const pc = computer({ lockEvents: false });
      pc.activity.setWindowState({ focused: false, visible: true });
      pc.state.locked = true;
      pc.activity.evaluate('the Linux power poll ran');
      expect(pc.activity.isAway()).toBe(true);
      pc.state.locked = false;
      vi.advanceTimersByTime(30_000);
      expect(pc.activity.isAway()).toBe(false);
      pc.activity.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('on Linux, where no lock event fires, sees the lock when asked to look again', () => {
    const pc = computer({ lockEvents: false });
    pc.state.locked = true;
    expect(pc.activity.isAway()).toBe(false);
    pc.activity.evaluate('the Linux power poll ran');
    expect(pc.activity.isAway()).toBe(true);
    pc.state.locked = false;
    pc.activity.setWindowState({ focused: false });
    pc.activity.setWindowState({ focused: true });
    expect(pc.activity.isAway()).toBe(false);
  });
});
