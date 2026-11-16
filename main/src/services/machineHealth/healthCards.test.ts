import { describe, expect, it } from 'vitest';
import type { HealthProcess, MachineHealthSnapshot, PaneUsage, StorageInventory } from '../../../../shared/types/machineHealth';
import { HealthCardController } from './healthCardController';
import { CardGate, type CardQuestion } from './healthCards';

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
  const snapshot = (disk: 'ok' | 'warning' | 'critical', panes: PaneUsage[] = []): MachineHealthSnapshot => ({
    sampledAt: 0, platform: 'darwin', hostname: 'mac', cpuPercent: 0, app: { rssMB: 100, cpuPercent: 0 }, panes, leaks: [],
    disk: { level: disk, volumes: [{ path: '/', roles: ['pane-data'], totalBytes: 500 * GB, freeBytes: 13 * GB, level: disk }] },
    memory: { level: 'ok', source: 'macos-pressure', detail: '', totalBytes: 32 * GB, freeBytes: 2 * GB, swapUsedBytes: null },
  });
  const scanned: StorageInventory = { scannedAt: 0, durationMs: 0, panes: [], buckets: { paneWorktrees: 0, dependencies: 0, qaAndScratch: 0, agentTemp: 0, paneData: 0 },
    items: [{ id: 'update-snapshot:/u', kind: 'update-snapshot', tier: 1, path: '/u', sizeBytes: 9 * GB, modifiedAt: 0, sessionId: null, reason: 'old update' }] };
  const escaped = (pid: number, sessionId = 'p1'): HealthProcess => ({ pid, started: `start-${pid}`, name: 'tmux', sessionId, panelId: null, rssMB: 50, cpuPercent: 0, escaped: true });

  // A one-process leftovers card offers 'Stop it' / 'Keep it'.
  const singular = (answer: string) => (answer === 'Stop them' ? 'Stop it' : answer === 'Keep them' ? 'Keep it' : answer);

  function controller(answer: string | null, options: { inventory?: StorageInventory | null; paneState?: 'archived' | 'paused' | 'open'; kept?: string[] } = {}) {
    const asked: CardQuestion[] = [];
    const cleaned: string[][] = [];
    const stopped: number[][] = [];
    const alerts: string[] = [];
    let now = 0;
    let inventory = options.inventory === undefined ? scanned : options.inventory;
    const c = new HealthCardController({
      // A null answer leaves the card waiting.
      now: () => now, ask: question => { asked.push(question); return answer === null ? new Promise(() => {}) : Promise.resolve({ answer: question.choices.includes(answer) ? answer : singular(answer) }); },
      inventory: () => inventory, idleOffer: () => ({ paneIds: [], memoryMB: 0 }), pauseIdleHours: () => 2, paneName: id => id,
      paneState: () => options.paneState ?? 'archived', tabName: () => null,
      canRestart: async () => false, cleanUp: async ids => { cleaned.push(ids); }, pauseIdle: async () => {}, stopProcess: async () => {},
      stopProcesses: async processes => { stopped.push(processes.map(proc => proc.pid)); return { at: now, source: 'card', removed: [], skipped: [], freedBytes: 0 }; },
      restartProcess: async () => {}, ignoreLeak: () => {}, archive: async () => {}, alert: title => alerts.push(title), log: () => {},
      readKept: () => [...(options.kept ?? [])], writeKept: ids => { if (options.kept) options.kept.splice(0, options.kept.length, ...ids); },
    });
    return { c, asked, cleaned, stopped, alerts, setNow: (value: number) => { now = value; }, setInventory: (value: StorageInventory | null) => { inventory = value; } };
  }
  const settle = () => new Promise(resolve => setTimeout(resolve, 0));

  it('raises the disk card once, runs Clean up on the listed items, and alerts only at critical', async () => {
    const { c, asked, cleaned, alerts } = controller('Clean up');
    c.onSnapshot(snapshot('warning'));
    await settle();
    c.onSnapshot(snapshot('warning'));
    await settle();
    expect(asked.map(question => question.title)).toEqual(['Disk almost full']);
    expect(asked[0].card.rows.map(row => row.label)).toEqual(['u']);
    expect(cleaned).toEqual([['update-snapshot:/u']]);
    expect(alerts).toEqual([]);
    c.onSnapshot(snapshot('critical'));
    await settle();
    expect(asked.map(question => question.title)).toEqual(['Disk almost full', 'Disk is almost full']);
    expect(alerts).toEqual(['Disk is almost full']);
  });

  it('alerts when disk turns critical while the warning card still waits, once per episode', async () => {
    const { c, asked, alerts } = controller(null);
    c.onSnapshot(snapshot('warning'));
    c.onSnapshot(snapshot('critical'));
    c.onSnapshot(snapshot('critical'));
    await settle();
    expect(asked).toHaveLength(1);
    expect(alerts).toEqual(['Disk is almost full']);
    c.onSnapshot(snapshot('warning'));
    c.onSnapshot(snapshot('critical'));
    expect(alerts).toHaveLength(2);
  });

  it('waits for the storage scan before raising the disk card', async () => {
    const { c, asked, setInventory } = controller('Not now', { inventory: null });
    c.onSnapshot(snapshot('warning'));
    await settle();
    expect(asked).toHaveLength(0);
    setInventory(scanned);
    c.onSnapshot(snapshot('warning'));
    await settle();
    expect(asked.map(question => question.choices)).toEqual([['Clean up', 'Not now']]);
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

  const pane = (processes: HealthProcess[]): PaneUsage => ({ sessionId: 'p1', name: 'old-pane', rssMB: 0, cpuPercent: 0, processes });

  it('asks before stopping processes an archived Pane left behind, and stops exactly those', async () => {
    const { c, asked, stopped } = controller('Stop them');
    c.onSnapshot(snapshot('ok', [pane([escaped(10), { ...escaped(11), escaped: false }])]));
    await settle();
    expect(asked.map(question => question.choices)).toEqual([['Stop it', 'Keep it']]);
    expect(asked[0].card.rows.map(row => row.note)).toEqual(['pid 10']);
    expect(stopped).toEqual([[10]]);
  });

  it('never asks about kept processes again, and asks again for a new one', async () => {
    const { c, asked, stopped } = controller('Keep them');
    c.onSnapshot(snapshot('ok', [pane([escaped(10)])]));
    await settle();
    c.onSnapshot(snapshot('ok', [pane([escaped(10)])]));
    await settle();
    expect(asked).toHaveLength(1);
    c.onSnapshot(snapshot('ok', [pane([escaped(10), escaped(12)])]));
    await settle();
    expect(asked.map(question => question.card.rows.map(row => row.note))).toEqual([['pid 10'], ['pid 12']]);
    expect(stopped).toEqual([]);
  });

  it('remembers kept processes across a restart', async () => {
    const kept: string[] = [];
    const first = controller('Keep them', { kept });
    first.c.onSnapshot(snapshot('ok', [pane([escaped(10)])]));
    await settle();
    const restarted = controller('Keep them', { kept });
    restarted.c.onSnapshot(snapshot('ok', [pane([escaped(10)])]));
    await settle();
    expect(restarted.asked).toHaveLength(0);
  });

  it('leaves the processes of an open Pane alone', async () => {
    const { c, asked } = controller('Stop them', { paneState: 'open' });
    c.onSnapshot(snapshot('ok', [pane([escaped(10)])]));
    await settle();
    expect(asked).toHaveLength(0);
  });
});
