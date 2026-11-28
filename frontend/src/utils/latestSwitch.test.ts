import { describe, expect, it } from 'vitest';
import { createLatestSwitch } from './latestSwitch';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { resolve, promise };
}

describe('createLatestSwitch (T-128, D-6)', () => {
  it('runs a press made during a switch once that switch ends, instead of dropping it', async () => {
    const first = deferred<string>();
    const ran: string[] = [];
    const latest = createLatestSwitch(async (target: string) => {
      ran.push(target);
      return target === 'build' ? first.promise : `on ${target}`;
    });

    const toBuild = latest.request('build');
    const toStudio = latest.request('studio');
    expect(ran).toEqual(['build']);
    first.resolve('on build');

    expect(await toBuild).toEqual({ superseded: true, value: 'on build' });
    expect(await toStudio).toEqual({ superseded: false, value: 'on studio' });
    expect(ran).toEqual(['build', 'studio']);
  });

  it('runs only the newest of several presses made during a switch; the others say they were superseded', async () => {
    const first = deferred<string>();
    const ran: string[] = [];
    const latest = createLatestSwitch(async (target: string) => {
      ran.push(target);
      return target === 'a' ? first.promise : target;
    });

    const a = latest.request('a');
    const b = latest.request('b');
    const c = latest.request('c');
    expect(await b).toEqual({ superseded: true });
    first.resolve('a');
    await a;

    expect(await c).toEqual({ superseded: false, value: 'c' });
    expect(ran).toEqual(['a', 'c']);
  });

  it('reports the switch in flight as superseded once a newer press is waiting', async () => {
    const first = deferred<string>();
    const latest = createLatestSwitch(async (target: string) => (target === 'a' ? first.promise : target));

    const a = latest.request('a');
    expect(latest.isSuperseded(1)).toBe(false);
    const b = latest.request('b');
    expect(latest.isSuperseded(1)).toBe(true);
    first.resolve('a');

    expect(await a).toEqual({ superseded: true, value: 'a' });
    expect(await b).toEqual({ superseded: false, value: 'b' });
  });

  it('never returns before the request is queued, so the caller never waits on a running switch to accept a press', () => {
    const latest = createLatestSwitch(() => new Promise<string>(() => undefined));
    latest.request('a');
    const started = performance.now();
    void latest.request('b');
    expect(performance.now() - started).toBeLessThan(5);
  });

  it('asks the switch in flight to stop when a press for another target queues behind it, and lets the newer one run at once', async () => {
    const hung = deferred<string>();
    const cancels: Array<[string, string]> = [];
    const latest = createLatestSwitch(async (target: string) => (target === 'build' ? hung.promise : `on ${target}`), {
      cancel: (running, next) => {
        cancels.push([running, next]);
        // The host stops the probes it was running, so that switch ends without switching.
        if (running !== next) hung.resolve('cancelled');
      },
    });

    const toBuild = latest.request('build');
    const again = latest.request('build');
    expect(cancels).toEqual([['build', 'build']]);
    const toStudio = latest.request('studio');
    expect(cancels).toEqual([['build', 'build'], ['build', 'studio']]);

    expect(await again).toEqual({ superseded: true });
    expect(await toBuild).toEqual({ superseded: true, value: 'cancelled' });
    expect(await toStudio).toEqual({ superseded: false, value: 'on studio' });
  });

  it('withdraws a request still waiting, which then never runs (T-132, review 1781 SF-2)', async () => {
    let finish: (value: string) => void = () => undefined;
    const ran: string[] = [];
    const latest = createLatestSwitch((target: string) => {
      ran.push(target);
      return target === 'studio' ? new Promise<string>(resolve => { finish = resolve; }) : Promise.resolve(`on ${target}`);
    });
    const toStudio = latest.request('studio');
    const toBuild = latest.request('build');
    expect(latest.withdraw(target => target === 'other')).toBe(false);
    expect(latest.withdraw(target => target === 'build')).toBe(true);
    expect(await toBuild).toEqual({ superseded: true });
    finish('on studio');
    await toStudio;
    await Promise.resolve();
    expect(ran).toEqual(['studio']);
  });
});
