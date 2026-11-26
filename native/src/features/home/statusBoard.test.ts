import { describe, expect, it } from 'vitest';

import type { NotifyItem, NotifySharedState } from '@shared/types/notify';

import { buildAllMachinesList, type MachineFeed } from '@/features/allMachines/allMachinesList';

import { boardCounts, sessionWaiting, terminalWaiting, tilePanes, todayBuckets } from './statusBoard';

const notify = (items: Array<Partial<NotifyItem> & Pick<NotifyItem, 'id' | 'createdAt'>>): NotifySharedState => ({
  machine: 'host', epoch: 'e1', revision: 1, enabled: true, queue: [], hidden: [],
  items: items.map(item => ({ title: 'Ship it?', ui: 'approve', state: 'waiting', source: { name: 'agent', agent: 'Claude' }, ...item })) as NotifyItem[],
});

// One machine: two Panes working, one finished unseen, one idle, one paused while working, one archived.
const mac: MachineFeed = {
  key: 'mac',
  name: 'studio-mac',
  snapshot: {
    projects: [{ id: 1, name: 'acme-web', sessions: [
      { id: 'build', name: 'build', lastActivity: '2026-11-15T09:00:00Z' },
      { id: 'tests', name: 'tests', lastActivity: '2026-11-15T09:30:00Z' },
      { id: 'docs', name: 'docs', lastActivity: '2026-11-15T08:00:00Z' },
      { id: 'idle', name: 'idle' },
      { id: 'held', name: 'held', paused: { at: '2026-11-15T07:00:00Z' } as never },
      { id: 'gone', name: 'gone', archived: true },
    ] }],
    statuses: {
      agentStatus: { p1: 'working', p2: 'working', p3: 'idle', p4: 'idle', p5: 'working' },
      agentStatusSession: { p1: 'build', p2: 'tests', p3: 'docs', p4: 'idle', p5: 'held' },
      agentType: {},
      unseen: { docs: true },
    },
    notify: notify([
      { id: 'q-open', createdAt: 1 },
      { id: 'q-sent', createdAt: 2, state: 'sent' },
      { id: 'q-stale', createdAt: 3, staleSince: 10 },
    ]),
    permissions: [{ id: 'perm', sessionId: 'idle', toolName: 'Bash', input: {}, timestamp: 4 }],
  },
};

describe('boardCounts', () => {
  it('counts what waits on you, working and ready Panes, and every open Pane', () => {
    // Waiting: the open question and the permission request; not the answer held for Undo or the stale one.
    // The permission request marks "idle" as needing input, so it is neither working nor ready.
    expect(boardCounts(buildAllMachinesList([mac], ''))).toEqual({ needs: 2, working: 2, ready: 1, all: 5 });
  });

  it('sums every machine on All', () => {
    const box: MachineFeed = { key: 'box', name: 'build-box', snapshot: { projects: [{ id: 1, name: 'infra', sessions: [{ id: 'x', name: 'x' }] }], notify: notify([{ id: 'q-box', createdAt: 5 }]) } };
    expect(boardCounts(buildAllMachinesList([mac, box], ''))).toEqual({ needs: 3, working: 2, ready: 1, all: 6 });
  });
});

describe('terminalWaiting', () => {
  // Codex stopped at "Allow this command?" in its terminal: blocked, with no approval behind it.
  const box: MachineFeed = {
    key: 'box',
    name: 'build-box',
    snapshot: {
      projects: [{ id: 1, name: 'infra', sessions: [
        { id: 'prompt', name: 'prompt', lastActivity: '2026-11-15T09:00:00Z' },
        { id: 'asked', name: 'asked' },
        { id: 'held', name: 'held', paused: { at: '2026-11-15T07:00:00Z' } as never },
      ] }],
      statuses: {
        agentStatus: { p1: 'blocked', p2: 'blocked', p3: 'blocked' },
        agentStatusSession: { p1: 'prompt', p2: 'asked', p3: 'held' },
        agentType: { prompt: 'codex' },
        unseen: {},
      },
      // "asked" waits through a permission request, so it counts there only.
      permissions: [{ id: 'perm', sessionId: 'asked', toolName: 'Bash', input: {}, timestamp: 4 }],
    },
  };

  it('lists Panes blocked in the terminal without an approval, and Needs you counts them once', () => {
    const list = buildAllMachinesList([box], '');
    expect(terminalWaiting(list).map(row => row.pane.name)).toEqual(['prompt']);
    expect(boardCounts(list).needs).toBe(2);
  });

  it('keeps a Pane whose question is held after an archive out of the terminal list, and out of the count', () => {
    // "prompt" asked a question, and the person archived it: it is held for Undo, not in the terminal.
    const list = buildAllMachinesList([{ ...box, snapshot: { ...box.snapshot!, notify: notify([{ id: 'q', createdAt: 1, source: { name: 'prompt', agent: 'Codex', paneId: 'prompt' } }]) } }], '');
    const held = list.waiting.filter(row => row.type === 'question');
    const board = { ...list, waiting: list.waiting.filter(row => row.type !== 'question') };
    expect(terminalWaiting(board, held)).toEqual([]);
    // Only "asked"'s permission request still needs you.
    expect(boardCounts(board, held).needs).toBe(1);
  });

  it('leaves out a machine that went offline, like its approvals', () => {
    const list = buildAllMachinesList([{ ...box, offlineSince: 1 }], '');
    expect(terminalWaiting(list)).toEqual([]);
    expect(boardCounts(list).needs).toBe(0);
  });
});

describe('sessionWaiting', () => {
  const session = (id: string, paneIds: string[]) => ({
    id, name: id, updatedAt: '2026-11-15T09:00:00Z', associations: paneIds.map(paneId => ({ paneId })),
  }) as never;
  const blocked = (paneIds: string[]) => ({
    agentStatus: Object.fromEntries(paneIds.map(id => [`tab-${id}`, 'blocked' as const])),
    agentStatusSession: Object.fromEntries(paneIds.map(id => [`tab-${id}`, id])),
    agentType: {},
    unseen: {},
  });
  const box: MachineFeed = {
    key: 'box',
    name: 'build-box',
    snapshot: {
      projects: [{ id: 1, name: 'infra', sessions: [{ id: 'prompt', name: 'prompt' }, { id: 'asked', name: 'asked' }, { id: 'loose', name: 'loose' }] }],
      statuses: blocked(['prompt', 'asked', 'loose']),
      permissions: [{ id: 'perm', sessionId: 'asked', toolName: 'Bash', input: {}, timestamp: 4 }],
      sessions: [session('ship', ['prompt', 'asked']), session('quiet', [])],
    },
  };

  it('counts a Session’s approvals and its Panes stopped in their terminal, each once', () => {
    // "asked" waits through its permission request, "prompt" in its terminal, "loose" is in no Session.
    expect([...sessionWaiting(buildAllMachinesList([box], ''))]).toEqual([['box:ship', 2]]);
  });

  it('counts a question one of its Panes asked outside any Session', () => {
    const asked = notify([{ id: 'q', createdAt: 1, source: { name: 'prompt', agent: 'Codex', paneId: 'prompt' } }]);
    // "prompt" now waits through its question instead of its terminal.
    expect([...sessionWaiting(buildAllMachinesList([{ ...box, snapshot: { ...box.snapshot!, notify: asked } }], ''))]).toEqual([['box:ship', 2]]);
  });

  it('counts a question filed under the Session once, and leaves out one already answered', () => {
    const asked = notify([
      { id: 'q', createdAt: 1, source: { name: 'prompt', agent: 'Codex', paneId: 'prompt', session: { id: 'ship', name: 'ship', paneId: 'ship-pane' } } },
      { id: 'sent', createdAt: 2, state: 'sent', source: { name: 'prompt', agent: 'Codex', paneId: 'prompt' } },
    ]);
    expect([...sessionWaiting(buildAllMachinesList([{ ...box, snapshot: { ...box.snapshot!, notify: asked } }], ''))]).toEqual([['box:ship', 2]]);
  });

  it('counts nothing on a machine that went offline', () => {
    expect([...sessionWaiting(buildAllMachinesList([{ ...box, offlineSince: 1 }], ''))]).toEqual([]);
  });
});

describe('tilePanes', () => {
  it('lists the Working tile newest first and leaves paused Panes out', () => {
    const { recent } = buildAllMachinesList([mac], '');
    expect(tilePanes(recent, 'working').map(row => row.pane.name)).toEqual(['tests', 'build']);
    expect(tilePanes(recent, 'ready').map(row => row.pane.name)).toEqual(['docs']);
  });
});

describe('todayBuckets', () => {
  it('splits today into the last hour and the part of the day, keeping order', () => {
    const at = (hour: number, minute = 0) => new Date(2026, 10, 15, hour, minute).getTime();
    const now = at(18, 30);
    const rows = [at(18, 10), at(17, 45), at(17, 5), at(14), at(9), at(8)];
    expect(todayBuckets(rows, row => row, now).map(bucket => [bucket.label, bucket.rows.length])).toEqual([
      ['Last hour', 2],
      ['This evening', 1],
      ['This afternoon', 1],
      ['This morning', 2],
    ]);
  });
});
