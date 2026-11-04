import { describe, expect, it } from 'vitest';
import { LoopRepository, type StoredLoop } from './loopRepository';
import { createLoopTestDb } from './loopTestDb';
import type { LoopRun } from '../../../../shared/types/loop';

const loop: StoredLoop = {
  id: 'loop-1',
  name: 'Nightly bug sweep',
  projectId: 1,
  cron: '0 3 * * *',
  toolCommand: 'agent-farm run greenfield/bug-sweep --since 24h',
  initialInput: 'Start with yesterday',
  worktreeTemplate: 'bug-sweep',
  enabled: true,
  scheduleFromMs: 1_000,
  createdAtMs: 500,
};

function run(id: string, slotAtMs: number, overrides: Partial<LoopRun> = {}): LoopRun {
  return { id, loopId: loop.id, slotAtMs, trigger: 'schedule', status: 'started', error: null, sessionId: `pane-${id}`, ...overrides };
}

describe('LoopRepository', () => {
  it('reads back what it stores', () => {
    const db = createLoopTestDb();
    const repo = new LoopRepository(() => db);
    repo.upsert(loop);
    expect(repo.get('loop-1')).toEqual(loop);

    repo.upsert({ ...loop, toolCommand: undefined, agent: 'codex', initialInput: undefined, enabled: false });
    expect(repo.list()).toEqual([{
      id: 'loop-1',
      name: 'Nightly bug sweep',
      projectId: 1,
      cron: '0 3 * * *',
      agent: 'codex',
      worktreeTemplate: 'bug-sweep',
      enabled: false,
      scheduleFromMs: 1_000,
      createdAtMs: 500,
    }]);
    expect(repo.get('missing')).toBeNull();
  });

  it('lists runs newest first and finds the ones past the kept count', () => {
    const db = createLoopTestDb();
    const repo = new LoopRepository(() => db);
    repo.upsert(loop);
    repo.addRun(run('a', 100));
    repo.addRun(run('b', 200, { status: 'skipped', sessionId: null }));
    repo.addRun(run('c', 300));
    repo.finishRun('c', { status: 'failed', error: 'no worktree', sessionId: null });

    expect(repo.runs(loop.id).map(r => [r.id, r.status, r.error])).toEqual([
      ['c', 'failed', 'no worktree'],
      ['b', 'skipped', null],
      ['a', 'started', null],
    ]);
    expect(repo.oldRuns(loop.id, 1).map(r => r.id)).toEqual(['a', 'b']);
    repo.deleteRun('a');
    expect(repo.runs(loop.id).map(r => r.id)).toEqual(['c', 'b']);
  });

  it('counts only scheduled runs as the last handled slot', () => {
    const db = createLoopTestDb();
    const repo = new LoopRepository(() => db);
    repo.upsert(loop);
    expect(repo.lastScheduledSlot(loop.id)).toBeNull();
    repo.addRun(run('a', 100));
    repo.addRun(run('b', 900, { trigger: 'manual' }));
    expect(repo.lastScheduledSlot(loop.id)).toBe(100);
  });

  it('deletes a loop with its runs', () => {
    const db = createLoopTestDb();
    const repo = new LoopRepository(() => db);
    repo.upsert(loop);
    repo.addRun(run('a', 100));
    repo.delete(loop.id);
    expect(repo.get(loop.id)).toBeNull();
    expect(repo.runs(loop.id)).toEqual([]);
  });
});
