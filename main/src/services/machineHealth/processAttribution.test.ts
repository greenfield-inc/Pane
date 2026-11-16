import { spawn, type ChildProcess } from 'child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { attributeProcesses, parsePosixProcessTable, readCommandLines, readEscapedEnvTags, readProcessRows, type ProcessRow } from './processAttribution';

const row = (pid: number, ppid: number, started: number, rssMB: number, name = `p${pid}`): ProcessRow =>
  ({ pid, ppid, started: String(started), startedAt: started, rssKB: rssMB * 1024, cpuSeconds: 0, name });

describe('attributeProcesses', () => {
  it('gives each Pane its tab roots and every descendant, and nothing else', () => {
    const table = [
      row(1, 0, 0, 10, 'launchd'),
      row(100, 1, 10, 50, 'zsh'), // tab A1 of Pane A
      row(101, 100, 11, 400, 'node'),
      row(102, 101, 12, 100, 'esbuild'),
      row(200, 1, 20, 300, 'claude'), // tab B1 of Pane B
      row(300, 1, 30, 999, 'Grain'), // not Pane's
    ];
    const panes = attributeProcesses(table, [
      { pid: 100, sessionId: 'A', panelId: 'A1' },
      { pid: 200, sessionId: 'B', panelId: 'B1' },
    ], new Map());
    expect(panes.get('A')?.map(p => [p.pid, p.panelId, p.escaped])).toEqual([[100, 'A1', false], [101, 'A1', false], [102, 'A1', false]]);
    expect(panes.get('B')?.map(p => p.pid)).toEqual([200]);
    expect([...panes.keys()].sort()).toEqual(['A', 'B']);
  });

  it('does not adopt a child whose recorded parent pid was reused after it started', () => {
    // 401 started at 5, before the current pid 400 (started 40) existed: its real parent died.
    const table = [row(400, 1, 40, 10, 'zsh'), row(401, 400, 5, 10, 'old')];
    const panes = attributeProcesses(table, [{ pid: 400, sessionId: 'A', panelId: null }], new Map());
    expect(panes.get('A')?.map(p => p.pid)).toEqual([400]);
  });

  it('attributes an escaped process by its PANE_SESSION_ID and PANE_PANEL_ID, and only for known Panes', () => {
    const table = [row(500, 1, 50, 30, 'fake-runpane.js'), row(501, 500, 51, 5, 'sh'), row(600, 1, 60, 30, 'other-instance')];
    const env = new Map([
      [500, { sessionId: 'A', panelId: 'A2' }],
      [600, { sessionId: 'Z', panelId: null }],
    ]);
    const panes = attributeProcesses(table, [], env, new Set(['A']));
    expect(panes.get('A')?.map(p => [p.pid, p.panelId, p.escaped])).toEqual([[500, 'A2', true], [501, 'A2', true]]);
    expect(panes.has('Z')).toBe(false);
  });
});

describe('parsePosixProcessTable', () => {
  it('reads pid, parent, RSS, CPU time, start time and a name with spaces', () => {
    const stdout = [
      '    1     0  21648  88:05.52 Wed Nov 11 08:36:48 2026     /sbin/launchd',
      '  144 57061  40224   0:00.34 Sun Nov 15 12:35:00 2026     /Applications/Grain.app/Contents/MacOS/Grain Helper (Renderer)',
      '  777   144   2048 1-02:03:04 Sun Nov 15 12:36:00 2026 node',
    ].join('\n');
    const rows = parsePosixProcessTable(stdout);
    expect(rows.map(r => [r.pid, r.ppid, r.rssKB, r.cpuSeconds, r.started, r.name])).toEqual([
      [1, 0, 21648, 5285.52, 'Wed Nov 11 08:36:48 2026', '/sbin/launchd'],
      [144, 57061, 40224, 0.34, 'Sun Nov 15 12:35:00 2026', '/Applications/Grain.app/Contents/MacOS/Grain Helper (Renderer)'],
      [777, 144, 2048, 93784, 'Sun Nov 15 12:36:00 2026', 'node'],
    ]);
  });
});

describe.skipIf(process.platform === 'win32')('reading live processes', () => {
  const children: ChildProcess[] = [];
  const spawnIdle = (env: Record<string, string>): number => {
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { env, stdio: 'ignore' });
    children.push(child);
    if (!child.pid) throw new Error('spawn failed');
    return child.pid;
  };
  const asEscaped = (pid: number): ProcessRow => ({ ...row(pid, 1, 0, 1), started: 'x' });
  afterEach(() => { for (const child of children.splice(0)) child.kill(); });

  it('attributes an escaped process only when its PANE_INSTANCE names this instance', async () => {
    const mine = spawnIdle({ PANE_SESSION_ID: 'A', PANE_PANEL_ID: 'A1', PANE_INSTANCE: 'mine' });
    const theirs = spawnIdle({ PANE_SESSION_ID: 'A', PANE_PANEL_ID: 'A1', PANE_INSTANCE: 'theirs' });
    const untagged = spawnIdle({ PANE_SESSION_ID: 'A' });
    await new Promise(resolve => setTimeout(resolve, 300));
    const tags = await readEscapedEnvTags([asEscaped(mine), asEscaped(theirs), asEscaped(untagged)], new Set(), 'mine');
    expect([...tags]).toEqual([[mine, { sessionId: 'A', panelId: 'A1' }]]);
  });

  it('reads the process table and command lines under a non-US locale', async () => {
    const previous = process.env.LC_ALL;
    process.env.LC_ALL = 'en_GB.UTF-8';
    try {
      const pid = spawnIdle({});
      await new Promise(resolve => setTimeout(resolve, 300));
      const self = (await readProcessRows()).find(r => r.pid === pid);
      expect(Number.isFinite(self?.startedAt)).toBe(true);
      expect((await readCommandLines([pid])).get(pid)).toBe(`${process.execPath} -e setTimeout(() => {}, 30000)`);
    } finally {
      if (previous === undefined) delete process.env.LC_ALL;
      else process.env.LC_ALL = previous;
    }
  });
});
