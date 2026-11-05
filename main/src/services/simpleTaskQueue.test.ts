import { describe, expect, it } from 'vitest';
import { PaneCommandRegistry, teammatePaneCaller } from '../daemon/commandRegistry';
import { SimpleQueue } from './simpleTaskQueue';

describe('SimpleQueue', () => {
  it('runs each job as the caller that added it, not the caller whose job ran before it', async () => {
    const queue = new SimpleQueue<string, string | null>('creations', 1);
    const ranAs = new Map<string, string | null>();
    let releaseFirst: () => void = () => undefined;
    const firstHeld = new Promise<void>(resolve => { releaseFirst = resolve; });
    const done = new Promise<void>(resolve => queue.on('completed', job => { if (job.data === 'owner') resolve(); }));
    queue.process(1, async job => {
      if (job.data === 'teammate') await firstHeld;
      ranAs.set(job.data, teammatePaneCaller());
      return teammatePaneCaller();
    });

    const registry = new PaneCommandRegistry();
    registry.register('runpane:machine:info', async () => { await queue.add('teammate'); return null; });
    await registry.invokeRemote('runpane:machine:info', [], { teammate: 'bob@example.com' });
    await queue.add('owner');
    releaseFirst();
    await done;

    expect(ranAs).toEqual(new Map([['teammate', 'bob@example.com'], ['owner', null]]));
  });
});
