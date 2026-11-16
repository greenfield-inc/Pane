import { describe, expect, it } from 'vitest';
import { FinishedPaneMonitor, findFinishedPanes, type FinishedPane, type FinishedPaneDeps } from './finishedPanes';

const DAY = 86_400_000;
const NOW = Date.parse('2026-11-15T12:00:00Z');

const pane = (id: string, idleDays: number) => ({ id, name: id, projectName: 'repo', worktreePath: `/w/${id}`, inactiveSince: NOW - idleDays * DAY });

function deps(over: Partial<FinishedPaneDeps> = {}): FinishedPaneDeps {
  return {
    now: () => NOW,
    idleDays: 14,
    panes: () => [],
    prStatus: async () => ({ state: 'open', number: 1 }),
    folderExists: async () => true,
    protectionOf: async () => null,
    sizeOf: () => 1000,
    ...over,
  };
}

describe('findFinishedPanes', () => {
  it('finds Panes whose PR merged or closed, whose folder is missing, or that sat idle 14 days', async () => {
    const finished = await findFinishedPanes(deps({
      panes: () => [pane('merged', 1), pane('closed', 1), pane('missing', 1), pane('idle', 15), pane('busy', 13)],
      prStatus: async id => (id === 'merged' ? { state: 'merged', number: 808 } : id === 'closed' ? { state: 'closed', number: 9 } : { state: 'none' }),
      folderExists: async path => path !== '/w/missing',
    }));
    expect(finished.map(p => [p.sessionId, p.reason, p.prNumber ?? null, p.protection])).toEqual([
      ['merged', 'pr-merged', 808, null],
      ['closed', 'pr-closed', 9, null],
      ['missing', 'folder-missing', null, null],
      ['idle', 'idle', null, null],
    ]);
  });

  it('lists finished Panes that are protected with the reason they are skipped', async () => {
    const reasons = {
      dirty: 'It has uncommitted changes.', pinned: 'It is pinned.', focused: 'It is the Pane you are looking at.',
      working: 'An agent is working in it.', card: 'It has an open Notify card.',
    };
    const finished = await findFinishedPanes(deps({
      panes: () => Object.keys(reasons).map(id => pane(id, 20)),
      prStatus: async () => ({ state: 'none' }),
      protectionOf: async id => Object.entries(reasons).find(([key]) => key === id)?.[1] ?? null,
    }));
    expect(finished.map(p => [p.sessionId, p.reason, p.protection])).toEqual(Object.entries(reasons).map(([id, reason]) => [id, 'idle', reason]));
  });

  it('treats an unknown PR state as not finished unless another signal says so', async () => {
    const finished = await findFinishedPanes(deps({ panes: () => [pane('offline', 2)], prStatus: async () => ({ state: 'unknown' }) }));
    expect(finished).toEqual([]);
  });
});

describe('FinishedPaneMonitor', () => {
  const finished = (sessionId: string, protection: string | null = null): FinishedPane =>
    ({ sessionId, name: sessionId, projectName: 'repo', reason: 'pr-merged', prNumber: 1, idleDays: 1, sizeBytes: 1000, protection });

  function monitor(list: FinishedPane[], automatic: boolean) {
    const archived: string[] = [];
    const runs: unknown[] = [];
    const m = new FinishedPaneMonitor({
      now: () => NOW, find: async () => list.filter(pane => !archived.includes(pane.sessionId)),
      archive: async id => { archived.push(id); }, automatic: () => automatic, record: run => runs.push(run),
    });
    return { m, archived, runs };
  }

  it('archives nothing by itself while the automatic switch is off', async () => {
    const { m, archived } = monitor([finished('a')], false);
    await m.check();
    expect(archived).toEqual([]);
  });

  it('with the switch on, archives finished Panes that are not protected, in one pass', async () => {
    const { m, archived, runs } = monitor([finished('a'), finished('b', 'It is pinned.')], true);
    await m.check();
    expect(archived).toEqual(['a']);
    expect(runs).toEqual([expect.objectContaining({ source: 'schedule', removed: [expect.objectContaining({ id: 'a', kind: 'finished-pane' })], skipped: [] })]);
  });

  it('re-checks when asked to archive: a Pane that became protected or unfinished is skipped', async () => {
    const list = [finished('a'), finished('b')];
    const { m, archived } = monitor(list, false);
    await m.list(true);
    list[0] = finished('a', 'An agent is working in it.');
    list.pop();
    const run = await m.archive(['a', 'b'], 'card');
    expect(archived).toEqual([]);
    expect(run.skipped.map(entry => [entry.id, entry.reason])).toEqual([['a', 'An agent is working in it.'], ['b', 'It is no longer finished.']]);
  });
});
