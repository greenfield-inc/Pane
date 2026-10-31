import { describe, expect, it } from 'vitest';
import { AutoJoin, type VouchAnswer, type Voucher } from '../src/autoJoin';
import type { UnjoinedComputer } from '../src/model';
import type { Cancel } from '../src/timers';

const MINUTE = 60_000;
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

/** A paired computer whose vouch answers are scripted, one per ask; it records each ask. */
class Computer implements Voucher {
  live = true;
  asked = 0;
  constructor(readonly id: string, readonly name: string, private readonly answers: VouchAnswer[] = []) {}
  answer(next: VouchAnswer): this {
    this.answers.push(next);
    return this;
  }
  async vouch(): Promise<VouchAnswer> {
    this.asked += 1;
    return this.answers.shift() ?? { kind: 'answered', code: null, skipped: [] };
  }
}

const skipped = (...entries: Array<[string, string]>): VouchAnswer => ({ kind: 'answered', code: null, skipped: entries.map(([name, reason]) => ({ name, reason })) });

function launch(computers: Computer[], codes: Record<string, string[]> = {}) {
  let now = 0;
  const tasks: Array<{ at: number; fn: () => void; done: boolean }> = [];
  const joinedCodes: string[] = [];
  const autoJoin = new AutoJoin({
    vouchers: () => computers,
    join: async (code) => {
      joinedCodes.push(code);
      return { joined: codes[code] ?? [], failed: [] };
    },
    later: (fn, ms): Cancel => {
      const task = { at: now + ms, fn, done: false };
      tasks.push(task);
      return { cancel: () => { task.done = true; } };
    },
    now: () => now,
    changed: () => {},
  });
  autoJoin.start();
  return {
    autoJoin,
    joinedCodes,
    async advance(ms: number) {
      now += ms;
      for (const task of tasks.filter((candidate) => !candidate.done && candidate.at <= now)) {
        task.done = true;
        task.fn();
      }
      await settle();
    },
    unjoined: (): UnjoinedComputer[] => autoJoin.unjoined(),
  };
}

describe('glasses joining your other computers on their own', () => {
  it('asks the next paired computer when the first does not answer, and pairs with the code it returns', async () => {
    const studio = new Computer('studio', 'studio-mac', [{ kind: 'unavailable' }]);
    const build = new Computer('build', 'build-box', [{ kind: 'answered', code: 'pane-glasses://office', skipped: [] }]);
    const { joinedCodes } = launch([studio, build], { 'pane-glasses://office': ['office-pc'] });
    await settle();
    expect([studio.asked, build.asked]).toEqual([1, 1]);
    expect(joinedCodes).toEqual(['pane-glasses://office']);
  });

  it('asks the next computer about a computer the first could not reach or had no password for', async () => {
    const studio = new Computer('studio', 'studio-mac', [skipped(['nas', 'needs its password'], ['devbox', 'not answering'])]);
    const build = new Computer('build', 'build-box', [{ kind: 'answered', code: 'pane-glasses://nas', skipped: [{ name: 'devbox', reason: 'not answering' }] }]);
    const { joinedCodes, unjoined } = launch([studio, build], { 'pane-glasses://nas': ['nas'] });
    await settle();
    expect([studio.asked, build.asked]).toEqual([1, 1]);
    expect(joinedCodes).toEqual(['pane-glasses://nas']);
    expect(unjoined()).toEqual([{ name: 'devbox', reason: 'not answering' }]);
  });

  it('asks no other computer about one only you can fix, until the next launch', async () => {
    const studio = new Computer('studio', 'studio-mac', [skipped(['office-pc', 'update Pane there'])]).answer(skipped(['office-pc', 'not answering']));
    const build = new Computer('build', 'build-box');
    const first = launch([studio, build]);
    await settle();
    expect(first.unjoined()).toEqual([{ name: 'office-pc', reason: 'update Pane there' }]);
    expect(build.asked).toBe(0);

    // Ten minutes on, studio-mac asks again; office-pc is still not worth asking build-box about.
    await first.advance(10 * MINUTE);
    expect(studio.asked).toBe(2);
    expect(build.asked).toBe(0);
    expect(first.unjoined()).toEqual([{ name: 'office-pc', reason: 'not answering' }]);

    // After a relaunch, a reason another computer could solve sends the glasses to build-box.
    first.autoJoin.stop();
    studio.answer(skipped(['office-pc', 'not answering']));
    launch([studio, build]);
    await settle();
    expect(build.asked).toBe(1);
  });

  it('skips a computer on an older Pane until the next ten-minute round, and waits for one that is live', async () => {
    const studio = new Computer('studio', 'studio-mac', [{ kind: 'unsupported' }]);
    const build = new Computer('build', 'build-box');
    build.live = false;
    const { autoJoin, advance } = launch([studio, build]);
    await settle();
    expect(studio.asked).toBe(1);
    build.live = true;
    autoJoin.poke();
    await settle();
    expect([studio.asked, build.asked]).toEqual([1, 1]);
    // Updated in the meantime, studio-mac answers the next round, so build-box isn't needed.
    await advance(10 * MINUTE);
    expect([studio.asked, build.asked]).toEqual([2, 1]);
  });

  it('asks each computer at most once in five minutes however often it is poked, and again every ten', async () => {
    const studio = new Computer('studio', 'studio-mac');
    const { autoJoin, advance } = launch([studio]);
    await settle();
    autoJoin.poke();
    await advance(4 * MINUTE);
    autoJoin.poke();
    await settle();
    expect(studio.asked).toBe(1);
    await advance(6 * MINUTE);
    expect(studio.asked).toBe(2);
  });
});
