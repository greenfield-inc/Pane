import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LoopManager, type LoopRunStarter } from './loopManager';
import { LoopRepository } from './loopRepository';
import { createLoopTestDb } from './loopTestDb';
import type { LoopInput } from '../../../../shared/types/loop';

// Expected instants are worked for New York (EDT, UTC-4, in October 2026).
process.env.TZ = 'America/New_York';

const utc = (iso: string) => Date.parse(iso);

const nightly: LoopInput = {
  name: 'Nightly bug sweep',
  projectId: 1,
  cron: '0 3 * * *',
  agent: 'claude',
  initialInput: 'Sweep yesterday’s merged PRs for bugs.',
  enabled: true,
};

/** Let archives started in the background finish. */
const settle = () => new Promise(resolve => setImmediate(resolve));

function setup(
  startRun: LoopRunStarter = async () => ({ sessionId: `pane-${Math.random()}` }),
  refusesArchive: (sessionId: string) => boolean = () => false,
) {
  let nowMs = utc('2026-10-23T12:00:00Z');
  const archived: string[] = [];
  const started: string[] = [];
  const preparedSessions: Array<{ target: string; name: string; agent: string }> = [];
  const manager = new LoopManager({
    repo: new LoopRepository((() => { const db = createLoopTestDb(); return () => db; })()),
    startRun: async (loop, slotAtMs) => {
      started.push(loop.name);
      return startRun(loop, slotAtMs);
    },
    archiveRun: async sessionId => {
      if (refusesArchive(sessionId)) return false;
      archived.push(sessionId);
      return true;
    },
    projectExists: id => id === 1,
    prepareSession: async (target, loop) => {
      preparedSessions.push({ target, ...loop });
      return target === 'new' ? 'session-new' : target;
    },
    now: () => nowMs,
  });
  return {
    manager,
    started,
    archived,
    preparedSessions,
    setNow: (iso: string) => { nowMs = utc(iso); },
  };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('LoopManager.save', () => {
  it('rejects a cron that runs more than once an hour', async () => {
    const { manager } = setup();
    await expect(manager.save({ ...nightly, cron: '*/30 * * * *' })).rejects.toThrow(/60 minutes/);
    expect(manager.list()).toEqual([]);
  });

  it('rejects a project that does not exist', async () => {
    const { manager } = setup();
    await expect(manager.save({ ...nightly, projectId: 7 })).rejects.toThrow(/Project 7 does not exist/);
  });

  it('shows the schedule and the next run', async () => {
    const { manager } = setup();
    const loop = await manager.save(nightly);
    expect(loop).toMatchObject({ scheduleText: 'Daily at 3:00 AM', nextRunAtMs: utc('2026-10-24T07:00:00Z'), runs: [] });
  });
});

describe('LoopManager Session loops', () => {
  const standup: LoopInput = {
    name: 'Morning standup',
    orchestrationSessionId: 'new',
    cron: '0 9 * * 1-5',
    agent: 'codex',
    initialInput: 'Summarize what changed across my projects since yesterday.',
    worktreeTemplate: 'standup',
    enabled: true,
  };

  it('targets exactly one of a project or a Session, sends a prompt, and runs no command', async () => {
    const { manager, preparedSessions } = setup();
    await expect(manager.save({ ...standup, projectId: 1 })).rejects.toThrow('A loop targets either a project or a Session.');
    await expect(manager.save({ ...standup, orchestrationSessionId: undefined })).rejects.toThrow('A loop targets either a project or a Session.');
    await expect(manager.save({ ...standup, agent: undefined, toolCommand: 'pnpm test' })).rejects.toThrow('cannot run a command');
    await expect(manager.save({ ...standup, initialInput: '  ' })).rejects.toThrow('needs a prompt');
    // Nothing invalid reaches the Session: a new one is created only for a loop that saves.
    expect(preparedSessions).toEqual([]);
    expect(manager.list()).toEqual([]);
  });

  it('stores the prepared Session as the target, with no project or worktree template', async () => {
    const { manager, preparedSessions } = setup();
    const loop = await manager.save(standup);
    expect(preparedSessions).toEqual([{ target: 'new', name: 'Morning standup', agent: 'codex' }]);
    expect(loop).toMatchObject({ orchestrationSessionId: 'session-new', scheduleText: 'Every weekday (Monday to Friday) at 9:00 AM' });
    expect(loop.projectId).toBeUndefined();
    expect(loop.worktreeTemplate).toBeUndefined();
  });

  it('keeps the last 10 runs by dropping rows, since a Session run has no Pane to archive', async () => {
    const { manager, archived } = setup(async () => ({ sessionId: null }));
    const { id } = await manager.save(standup);
    for (let index = 0; index < 11; index += 1) await manager.runNow(id);
    await settle();
    expect(manager.list()[0].runs).toHaveLength(10);
    expect(manager.list()[0].runs.every(run => run.status === 'started' && run.sessionId === null)).toBe(true);
    expect(archived).toEqual([]);
  });
});

describe('LoopManager runs', () => {
  it('starts a due loop once and records the slot', async () => {
    const { manager, started, setNow } = setup(async () => ({ sessionId: 'pane-1' }));
    const { id } = await manager.save(nightly);
    manager.start();

    setNow('2026-10-24T07:02:00Z');
    await manager.tick();
    await manager.tick();

    expect(started).toEqual(['Nightly bug sweep']);
    expect(manager.list()[0].runs).toMatchObject([
      { loopId: id, slotAtMs: utc('2026-10-24T07:00:00Z'), trigger: 'schedule', status: 'started', sessionId: 'pane-1' },
    ]);
    manager.stop();
  });

  it('records a run missed while Pane was closed as skipped, at its slot time', async () => {
    const { manager, started, setNow } = setup();
    await manager.save(nightly);

    // Pane comes back at 09:00 EDT, two hours after the 03:00 slot.
    setNow('2026-10-24T13:00:00Z');
    manager.start();
    await manager.tick();

    expect(started).toEqual([]);
    const [loop] = manager.list();
    expect(loop.runs).toMatchObject([{ status: 'skipped', slotAtMs: utc('2026-10-24T07:00:00Z'), sessionId: null }]);
    expect(loop.nextRunAtMs).toBe(utc('2026-10-25T07:00:00Z'));
    manager.stop();
  });

  it('re-reads each loop before starting it, so a loop paused meanwhile does not run', async () => {
    let releaseFirst: () => void = () => {};
    const { manager, started, setNow } = setup(loop => loop.name === 'First'
      ? new Promise(resolve => { releaseFirst = () => resolve({ sessionId: 'pane-first' }); })
      : Promise.resolve({ sessionId: 'pane-second' }));
    await manager.save({ ...nightly, name: 'First' });
    const second = await manager.save({ ...nightly, name: 'Second' });
    manager.start();
    await manager.tick();
    setNow('2026-10-24T07:01:00Z');

    const tick = manager.tick();
    await vi.waitFor(() => expect(started).toEqual(['First']));
    manager.setEnabled(second.id, false);
    releaseFirst();
    await tick;

    expect(started).toEqual(['First']);
    expect(manager.list().find(loop => loop.id === second.id)?.runs).toEqual([]);
    manager.stop();
  });

  it('runs now without moving the schedule, and never starts one loop twice at once', async () => {
    let release: () => void = () => {};
    const { manager } = setup(() => new Promise(resolve => { release = () => resolve({ sessionId: 'pane-now' }); }));
    const { id, nextRunAtMs } = await manager.save(nightly);

    const first = manager.runNow(id);
    await expect(manager.runNow(id)).rejects.toThrow(/already starting/);
    release();
    const loop = await first;

    expect(loop.nextRunAtMs).toBe(nextRunAtMs);
    expect(loop.runs).toMatchObject([{ trigger: 'manual', status: 'started', sessionId: 'pane-now' }]);
  });

  it('records a run whose Pane could not be created as failed', async () => {
    const { manager } = setup(async () => { throw new Error('No space left on device'); });
    const { id } = await manager.save(nightly);
    const loop = await manager.runNow(id);
    expect(loop.runs).toMatchObject([{ status: 'failed', error: 'No space left on device', sessionId: null }]);
  });

  it('keeps the last 10 runs and archives older run Panes', async () => {
    let count = 0;
    const { manager, archived } = setup(async () => ({ sessionId: `pane-${++count}` }));
    const { id } = await manager.save(nightly);
    for (let index = 0; index < 12; index++) await manager.runNow(id);
    await settle();

    expect(manager.list()[0].runs.map(run => run.sessionId)).toEqual(
      ['pane-12', 'pane-11', 'pane-10', 'pane-9', 'pane-8', 'pane-7', 'pane-6', 'pane-5', 'pane-4', 'pane-3'],
    );
    expect(archived).toEqual(['pane-1', 'pane-2']);
  });

  it('keeps an old run listed, with a note, when its Pane has uncommitted or unpushed work', async () => {
    let count = 0;
    const { manager, archived } = setup(async () => ({ sessionId: `pane-${++count}` }), sessionId => sessionId === 'pane-1');
    const { id } = await manager.save(nightly);
    for (let index = 0; index < 11; index++) await manager.runNow(id);
    await settle();

    const runs = manager.list()[0].runs;
    expect(runs.map(run => run.sessionId)).toEqual(
      ['pane-11', 'pane-10', 'pane-9', 'pane-8', 'pane-7', 'pane-6', 'pane-5', 'pane-4', 'pane-3', 'pane-2', 'pane-1'],
    );
    expect(runs[10]).toMatchObject({
      status: 'started',
      error: 'Kept because the run Pane has uncommitted or unpushed work. Archive it yourself when you\'re done.',
    });
    expect(archived).toEqual([]);
  });
});

describe('LoopManager timer', () => {
  it('starts a loop when its slot comes, and stops scheduling once stopped', async () => {
    const { manager, started, setNow } = setup();
    await manager.save(nightly);
    manager.start();
    await manager.tick();

    // The clock reaches 03:00 EDT while the timer sleeps; it wakes within a minute.
    setNow('2026-10-24T07:00:30Z');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(started).toEqual(['Nightly bug sweep']);

    manager.stop();
    setNow('2026-10-25T07:00:30Z');
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(started).toEqual(['Nightly bug sweep']);
  });
});

describe('LoopManager schedule restarts', () => {
  it('counts a resumed loop from the resume, so the slot it was paused over does not run', async () => {
    const { manager, started, setNow } = setup();
    const { id } = await manager.save(nightly);
    manager.setEnabled(id, false);
    manager.start();

    // Resumed at 03:05 EDT, five minutes after a slot that would still be in its grace period.
    setNow('2026-10-24T07:05:00Z');
    const loop = manager.setEnabled(id, true);
    await manager.tick();

    expect(started).toEqual([]);
    expect(loop.nextRunAtMs).toBe(utc('2026-10-25T07:00:00Z'));
    expect(manager.list()[0].runs).toEqual([]);
    manager.stop();
  });

  it('counts an edited cron from the edit, so a slot it moved into the past does not run', async () => {
    const { manager, started, setNow } = setup();
    const { id } = await manager.save(nightly);
    manager.start();

    // At 03:10 EDT the cron moves to 03:05, which passed five minutes ago.
    setNow('2026-10-24T07:10:00Z');
    const loop = await manager.save({ ...nightly, id, cron: '5 3 * * *' });
    await manager.tick();

    expect(started).toEqual([]);
    expect(loop.nextRunAtMs).toBe(utc('2026-10-25T07:05:00Z'));
    expect(manager.list()[0].runs).toEqual([]);
    manager.stop();
  });
});
