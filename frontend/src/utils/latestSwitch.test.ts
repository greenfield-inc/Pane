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
});
