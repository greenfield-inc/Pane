import { describe, expect, it } from 'vitest';
import type { HealthProcess, MachineHealthSnapshot, PaneUsage } from '../../../../shared/types/machineHealth';
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
  const snapshot = (disk: 'ok' | 'warning' | 'critical', panes: PaneUsage[] = [], memory: 'ok' | 'warning' | 'critical' = 'ok'): MachineHealthSnapshot => ({
    sampledAt: 0, platform: 'darwin', hostname: 'mac', cpuPercent: 0, app: { rssMB: 100, cpuPercent: 0 }, panes, leaks: [],
    disk: { level: disk, volumes: [{ path: '/', roles: ['pane-data'], totalBytes: 500 * GB, freeBytes: 13 * GB, level: disk }] },
    memory: { level: memory, source: 'macos-pressure', detail: '', totalBytes: 32 * GB, freeBytes: 2 * GB, swapUsedBytes: null },
  });
  const escaped = (pid: number, sessionId = 'p1'): HealthProcess => ({ pid, started: `start-${pid}`, name: 'tmux', sessionId, panelId: null, rssMB: 50, cpuPercent: 0, escaped: true });

  // A one-process leftovers card offers 'Stop it' / 'Keep it'.
  const singular = (answer: string) => (answer === 'Stop them' ? 'Stop it' : answer === 'Keep them' ? 'Keep it' : answer);

  function controller(answer: string | null, options: { paneState?: 'archived' | 'paused' | 'open'; kept?: string[]; awayFor?: number; notifications?: boolean; unavailable?: boolean } = {}) {
    const asked: CardQuestion[] = [];
    const stopped: number[][] = [];
    const alerts: string[] = [];
    const withdrawn: Array<{ title: string; reason: string }> = [];
    const titles = new Map<string, string>();
    // The first `awayFor` alerts find the person away from this machine.
    let away = options.awayFor ?? 0;
    const delivered = () => {
      if (away === 0) return true;
      away -= 1;
      return false;
    };
    let now = 0;
    let notifications = options.notifications ?? true;
    let unavailable = options.unavailable ?? false;
    const c = new HealthCardController({
      // A null answer leaves the card waiting.
      now: () => now, notificationsOn: () => notifications, ask: (question, id) => { asked.push(question); titles.set(id, question.title); if (unavailable) return Promise.resolve({ unavailable: 'Approvals are not running.', next: 'Turn on Approvals in Settings.' }); return answer === null ? new Promise(() => {}) : Promise.resolve({ answer: question.choices.includes(answer) ? answer : singular(answer) }); },
      paneName: id => id,
      paneState: () => options.paneState ?? 'archived', tabName: () => null,
      canRestart: async () => false, stopProcess: async () => {},
      stopProcesses: async processes => { stopped.push(processes.map(proc => proc.pid)); return { at: now, source: 'card', removed: [], skipped: [], freedBytes: 0 }; },
      withdraw: (id, reason) => { withdrawn.push({ title: titles.get(id) ?? id, reason }); },
      restartProcess: async () => {}, ignoreLeak: () => {}, archive: async () => {}, alert: title => { alerts.push(title); return delivered(); }, log: () => {},
      readKept: () => [...(options.kept ?? [])], writeKept: ids => { if (options.kept) options.kept.splice(0, options.kept.length, ...ids); },
    });
    return { c, asked, stopped, alerts, withdrawn, setNow: (value: number) => { now = value; },  setNotifications: (value: boolean) => { notifications = value; }, setUnavailable: (value: boolean) => { unavailable = value; } };
  }
  const settle = () => new Promise(resolve => setTimeout(resolve, 0));

  it('warns about the disk without offering a cleanup, and alerts only at critical', async () => {
    const { c, asked, alerts } = controller(null);
    c.onSnapshot(snapshot('warning'));
    c.onSnapshot(snapshot('warning'));
    expect(alerts).toEqual([]);
    c.onSnapshot(snapshot('critical'));
    await settle();
    expect(asked.map(question => [question.title, question.context, question.choices])).toEqual([
      ['Disk space is low', '13 GB free. Open Resources to see what uses the disk.', ['Not now']],
      ['Disk is almost full', '13 GB free. Open Resources to see what uses the disk.', ['Not now']],
    ]);
    expect(asked.map(question => question.card.freesBytes)).toEqual([undefined, undefined]);
    expect(alerts).toEqual(['Disk is almost full']);
  });

  it.each([true, false])('never alerts a person about memory (switch on: %s)', async notifications => {
    const { c, asked, alerts } = controller(null, { notifications });
    c.onSnapshot(snapshot('ok', [], 'warning'));
    c.onSnapshot(snapshot('ok', [], 'critical'));
    await settle();
    expect(asked).toEqual([]);
    expect(alerts).toEqual([]);
  });

  it('replaces a waiting warning card with the critical one when disk turns critical, alerting once per episode', async () => {
    const { c, asked, alerts, withdrawn } = controller(null);
    c.onSnapshot(snapshot('warning'));
    c.onSnapshot(snapshot('critical'));
    c.onSnapshot(snapshot('critical'));
    await settle();
    expect(asked.map(question => question.title)).toEqual(['Disk space is low', 'Disk is almost full']);
    expect(withdrawn).toEqual([{ title: 'Disk space is low', reason: 'it turned critical, and a new card replaces it' }]);
    expect(alerts).toEqual(['Disk is almost full']);
    c.onSnapshot(snapshot('warning'));
    c.onSnapshot(snapshot('critical'));
    expect(alerts).toHaveLength(2);
  });

  it('tries the critical alert again on the next sample when the person was away from this machine', async () => {
    const { c, alerts } = controller(null, { awayFor: 1 });
    c.onSnapshot(snapshot('critical'));
    c.onSnapshot(snapshot('critical'));
    c.onSnapshot(snapshot('critical'));
    expect(alerts).toEqual(['Disk is almost full', 'Disk is almost full']);
  });

  it('keeps a critical card through a dip to warning, takes it back once disk recovers, and raises the next episode', async () => {
    const { c, asked, withdrawn } = controller(null);
    c.onSnapshot(snapshot('critical'));
    c.onSnapshot(snapshot('warning'));
    c.onSnapshot(snapshot('critical'));
    await settle();
    expect(asked).toHaveLength(1);
    expect(withdrawn).toEqual([]);
    c.onSnapshot(snapshot('ok'));
    c.onSnapshot(snapshot('ok'));
    expect(withdrawn).toEqual([{ title: 'Disk is almost full', reason: 'free disk is back above the warning line' }]);
    c.onSnapshot(snapshot('critical'));
    expect(asked.map(question => question.title)).toEqual(['Disk is almost full', 'Disk is almost full']);
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

  describe('with Notifications off', () => {
    it('raises no card or notification for a warning, a left-behind process, finished Panes or a leak', async () => {
      const { c, asked, alerts } = controller('Not now', { notifications: false });
      c.onSnapshot(snapshot('warning', [pane([escaped(10)])], 'warning'));
      c.onFinished([{ sessionId: 'p1', name: 'done', projectName: 'repo', reason: 'pr-merged', prNumber: 1, idleDays: 0, sizeBytes: GB, protection: null }], snapshot('ok'));
      await c.onLeak({ pid: 10, started: 'start-10', name: 'node', sessionId: 'p1', panelId: null, memoryMB: 3000, growthMB: 1500, windowMs: 30 * 60_000, series: [] }, snapshot('ok'));
      await settle();
      expect(asked).toEqual([]);
      expect(alerts).toEqual([]);
    });

    it('still raises critical disk, once per episode', async () => {
      const { c, asked, alerts, setNow } = controller(null, { notifications: false });
      c.onSnapshot(snapshot('critical', [], 'critical'));
      await settle();
      expect(asked.map(question => question.title)).toEqual(['Disk is almost full']);
      expect(alerts).toEqual(['Disk is almost full']);

      // Still critical a day later: the episode already notified.
      setNow(24 * HOUR);
      c.onSnapshot(snapshot('critical', [], 'critical'));
      await settle();
      expect(asked).toHaveLength(1);
      expect(alerts).toHaveLength(1);

      // A new episode notifies again.
      c.onSnapshot(snapshot('ok'));
      c.onSnapshot(snapshot('critical'));
      await settle();
      expect(alerts).toEqual(['Disk is almost full', 'Disk is almost full']);
    });

    it('keeps a critical card snoozed with Not now when the switch is turned off after it', async () => {
      const { c, asked, alerts, setNotifications } = controller('Not now');
      c.onSnapshot(snapshot('critical'));
      await settle();
      setNotifications(false);
      c.onSnapshot(snapshot('critical'));
      await settle();
      expect(asked).toHaveLength(1);
      expect(alerts).toHaveLength(1);
    });

    it('raises one critical card in an hour of the level crossing the line, as with the switch on', async () => {
      const { c, asked, setNow } = controller('Not now', { notifications: false });
      for (let minute = 0; minute < 60; minute += 2) {
        setNow(minute * 60_000);
        c.onSnapshot(snapshot('critical'));
        await settle();
        c.onSnapshot(snapshot('warning'));
        await settle();
      }
      expect(asked).toHaveLength(1);
    });

    it('asks again in the same episode once Approvals can show the card', async () => {
      const { c, asked, setUnavailable } = controller(null, { notifications: false, unavailable: true });
      c.onSnapshot(snapshot('critical'));
      await settle();
      setUnavailable(false);
      c.onSnapshot(snapshot('critical'));
      await settle();
      expect(asked).toHaveLength(2);
    });
  });
});
