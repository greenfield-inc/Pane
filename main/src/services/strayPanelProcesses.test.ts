import * as fs from 'fs';
import { describe, expect, it, vi } from 'vitest';
import {
  findStrayPanelTrees,
  parseProcStat,
  processTrees,
  stopStrayPanelProcesses,
  terminateProcesses,
  type ProcessEntry,
  type ProcessTable,
} from './strayPanelProcesses';

const DAEMON = 1244216;
const SUBREAPER = 1597; // systemd --user, which adopts what a dead daemon leaves
const TTY = 34816;

function proc(pid: number, ppid: number, sid: number, comm: string, extra: Partial<ProcessEntry> = {}): ProcessEntry {
  return { pid, ppid, sid, ttyNr: TTY, comm, state: 'S', ...extra };
}

/** The layout found on a cloud Session after two daemon restarts that ended in SIGKILL. */
function scratchTable(): ProcessTable & { entries: ProcessEntry[] } {
  const entries = [
    proc(1, 0, 1, 'systemd', { ttyNr: 0 }),
    proc(SUBREAPER, 1, SUBREAPER, 'systemd', { ttyNr: 0 }),
    proc(DAEMON, SUBREAPER, DAEMON, 'pane', { ttyNr: 0 }),
    // The current daemon's PTY for panel A.
    proc(1244275, DAEMON, 1244275, 'bash'),
    proc(1244394, 1244275, 1244275, 'claude'),
    // Two earlier daemons' PTYs for panel A, adopted by the subreaper.
    proc(374813, SUBREAPER, 374813, 'bash'),
    proc(374925, 374813, 374813, 'claude'),
    proc(375289, 374925, 374813, 'cua-driver'),
    proc(517860, SUBREAPER, 517860, 'bash'),
    proc(517979, 517860, 517860, 'claude'),
    // A server an agent in panel A detached with setsid: no terminal.
    proc(523885, SUBREAPER, 523885, 'node', { ttyNr: 0 }),
    // An earlier daemon's PTY for panel B.
    proc(374818, SUBREAPER, 374818, 'bash'),
    proc(374926, 374818, 374818, 'claude'),
    // A zombie shell for panel A.
    proc(600000, SUBREAPER, 600000, 'bash', { state: 'Z' }),
  ];
  const panels = new Map<number, string>([
    [1244275, 'A'], [1244394, 'A'], [374813, 'A'], [374925, 'A'], [375289, 'A'],
    [517860, 'A'], [517979, 'A'], [523885, 'A'], [600000, 'A'],
    [374818, 'B'], [374926, 'B'],
  ]);
  return { entries, list: () => entries, panelIdOf: pid => panels.get(pid) };
}

describe('parseProcStat', () => {
  it('reads pid, ppid, session and terminal, even when comm has spaces and parentheses', () => {
    const text = '374925 (claude (x) y) S 374813 374925 374813 34816 374925 4194560 1 2 3';
    expect(parseProcStat(text)).toEqual({
      pid: 374925, ppid: 374813, sid: 374813, ttyNr: 34816, comm: 'claude (x) y', state: 'S',
    });
  });

  it.runIf(process.platform === 'linux')('reads this process from /proc', () => {
    const entry = parseProcStat(fs.readFileSync('/proc/self/stat', 'utf8'));
    expect(entry?.pid).toBeGreaterThan(0);
    expect(entry?.ppid).toBeGreaterThan(0);
  });
});

describe('findStrayPanelTrees', () => {
  it("finds the panel's PTY shells outside this daemon with everything under them", () => {
    const trees = findStrayPanelTrees(scratchTable(), 'A', DAEMON);

    expect(trees).toEqual([
      { panelId: 'A', leaderPid: 374813, pids: [374813, 374925, 375289] },
      { panelId: 'A', leaderPid: 517860, pids: [517860, 517979] },
    ]);
  });

  it("never returns this daemon's own PTY, a detached server, a zombie or another panel", () => {
    const pids = findStrayPanelTrees(scratchTable(), 'A', DAEMON).flatMap(tree => tree.pids);

    expect(pids).not.toContain(1244275);
    expect(pids).not.toContain(1244394);
    expect(pids).not.toContain(523885);
    expect(pids).not.toContain(600000);
    expect(pids).not.toContain(374926);
  });

  it('finds nothing for a panel with no earlier processes', () => {
    expect(findStrayPanelTrees(scratchTable(), 'C', DAEMON)).toEqual([]);
  });
});

describe('processTrees', () => {
  it('expands roots to their descendants before anything is killed', () => {
    expect(processTrees([1244275, 374818], scratchTable()).sort((a, b) => a - b))
      .toEqual([374818, 374926, 1244275, 1244394]);
  });

  it('returns the roots alone where there is no process table', () => {
    expect(processTrees([7, 8], { list: () => [], panelIdOf: () => undefined })).toEqual([7, 8]);
  });
});

/** Fake processes: `stubborn` ones ignore SIGTERM. */
function fakeProcesses(pids: number[], stubborn: number[] = []) {
  const alive = new Set(pids);
  const signals: Array<[number, NodeJS.Signals]> = [];
  return {
    alive,
    signals,
    options: {
      graceMs: 300,
      pollMs: 100,
      isAlive: (pid: number) => alive.has(pid),
      kill: (pid: number, signal: NodeJS.Signals) => {
        signals.push([pid, signal]);
        if (signal === 'SIGKILL' || !stubborn.includes(pid)) alive.delete(pid);
      },
      sleep: vi.fn(async () => undefined),
    },
  };
}

describe('terminateProcesses', () => {
  it('sends SIGTERM and stops there when everything exits', async () => {
    const fake = fakeProcesses([1, 2]);

    expect(await terminateProcesses([1, 2], fake.options)).toEqual([]);
    expect(fake.signals).toEqual([[1, 'SIGTERM'], [2, 'SIGTERM']]);
  });

  it('sends SIGKILL after the grace to what ignored SIGTERM', async () => {
    const fake = fakeProcesses([1, 2], [2]);

    expect(await terminateProcesses([1, 2], fake.options)).toEqual([]);
    expect(fake.signals).toEqual([[1, 'SIGTERM'], [2, 'SIGTERM'], [2, 'SIGKILL']]);
    expect(fake.options.sleep).toHaveBeenCalledTimes(4);
  });

  it('skips pids that are already gone and reports survivors', async () => {
    const fake = fakeProcesses([2]);
    fake.options.kill = (pid, signal) => { fake.signals.push([pid, signal]); };

    expect(await terminateProcesses([1, 2], fake.options)).toEqual([2]);
    expect(fake.signals.map(([pid]) => pid)).not.toContain(1);
  });
});

describe('stopStrayPanelProcesses', () => {
  it("stops only the panel's stray trees", async () => {
    const table = scratchTable();
    const fake = fakeProcesses(table.entries.map(entry => entry.pid));

    const result = await stopStrayPanelProcesses('A', { ...fake.options, table, ownPid: DAEMON });

    expect(result.survivors).toEqual([]);
    expect(fake.signals.map(([pid]) => pid).sort((a, b) => a - b))
      .toEqual([374813, 374925, 375289, 517860, 517979]);
    expect(fake.alive.has(1244394)).toBe(true);
    expect(fake.alive.has(523885)).toBe(true);
  });
});
