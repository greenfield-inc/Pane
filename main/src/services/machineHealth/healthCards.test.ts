import { describe, expect, it } from 'vitest';
import type { MachineHealthSnapshot, StorageInventory } from '../../../../shared/types/machineHealth';
import { HealthCardController } from './healthCardController';
import { CardGate } from './healthCards';

const HOUR = 3_600_000;

describe('CardGate', () => {
  it('shows a condition once, again only after 6 hours or when it worsens', () => {
    let now = 0;
    const gate = new CardGate(() => now);
    expect(gate.shouldShow('disk', 'warning')).toBe(true);
    gate.shown('disk', 'warning');
    now = 5 * HOUR;
    expect(gate.shouldShow('disk', 'warning')).toBe(false);
    expect(gate.shouldShow('disk', 'critical')).toBe(true);
    now = 6 * HOUR;
    expect(gate.shouldShow('disk', 'warning')).toBe(true);
  });

  it('holds a condition for 24 hours after Not now, unless it worsens', () => {
    let now = 0;
    const gate = new CardGate(() => now);
    gate.shown('memory', 'warning');
    gate.snooze('memory', 'warning');
    now = 23 * HOUR;
    expect(gate.shouldShow('memory', 'warning')).toBe(false);
    expect(gate.shouldShow('memory', 'critical')).toBe(true);
    now = 24 * HOUR;
    expect(gate.shouldShow('memory', 'warning')).toBe(true);
  });

  it('never shows a second card while one for the same condition is open', () => {
    const gate = new CardGate(() => 0);
    gate.shown('disk', 'warning');
    gate.open('disk');
    expect(gate.shouldShow('disk', 'critical')).toBe(false);
    gate.closed('disk');
    expect(gate.shouldShow('disk', 'critical')).toBe(true);
  });
});

describe('HealthCardController', () => {
  const GB = 1024 ** 3;
  const snapshot = (disk: 'ok' | 'warning' | 'critical'): MachineHealthSnapshot => ({
    sampledAt: 0, platform: 'darwin', hostname: 'mac', cpuPercent: 0, app: { rssMB: 100, cpuPercent: 0 }, panes: [], leaks: [],
    disk: { level: disk, volumes: [{ path: '/', roles: ['pane-data'], totalBytes: 500 * GB, freeBytes: 13 * GB, level: disk }] },
    memory: { level: 'ok', source: 'macos-pressure', detail: '', totalBytes: 32 * GB, freeBytes: 2 * GB, swapUsedBytes: null },
  });
  const inventory: StorageInventory = { scannedAt: 0, durationMs: 0, panes: [], buckets: { paneWorktrees: 0, dependencies: 0, qaAndScratch: 0, agentTemp: 0, paneData: 0 },
    items: [{ id: 'update-snapshot:/u', kind: 'update-snapshot', tier: 1, path: '/u', sizeBytes: 9 * GB, modifiedAt: 0, sessionId: null, reason: 'old update' }] };

  function controller(answer: string) {
    const asked: string[] = [];
    const cleaned: string[][] = [];
    const alerts: string[] = [];
    let now = 0;
    const c = new HealthCardController({
      now: () => now, ask: async question => { asked.push(question.title); return { answer }; },
      inventory: () => inventory, idleOffer: () => ({ paneIds: [], memoryMB: 0 }), pauseIdleHours: () => 2, paneName: id => id,
      canRestart: async () => false, cleanUp: async ids => { cleaned.push(ids); }, pauseIdle: async () => {}, stopProcess: async () => {},
      restartProcess: async () => {}, ignoreLeak: () => {}, archive: async () => {}, alert: title => alerts.push(title), log: () => {},
    });
    return { c, asked, cleaned, alerts, setNow: (value: number) => { now = value; } };
  }
  const settle = () => new Promise(resolve => setTimeout(resolve, 0));

  it('raises the disk card once, runs Clean up on the listed items, and alerts only at critical', async () => {
    const { c, asked, cleaned, alerts } = controller('Clean up');
    c.onSnapshot(snapshot('warning'));
    await settle();
    c.onSnapshot(snapshot('warning'));
    await settle();
    expect(asked).toEqual(['Disk almost full']);
    expect(cleaned).toEqual([['update-snapshot:/u']]);
    expect(alerts).toEqual([]);
    c.onSnapshot(snapshot('critical'));
    await settle();
    expect(asked).toEqual(['Disk almost full', 'Disk is almost full']);
    expect(alerts).toEqual(['Disk is almost full']);
  });

  it('after Not now, stays quiet for 24 hours', async () => {
    const { c, asked, setNow } = controller('Not now');
    c.onSnapshot(snapshot('warning'));
    await settle();
    setNow(7 * HOUR);
    c.onSnapshot(snapshot('warning'));
    await settle();
    expect(asked).toHaveLength(1);
    setNow(24 * HOUR);
    c.onSnapshot(snapshot('warning'));
    await settle();
    expect(asked).toHaveLength(2);
  });
});
