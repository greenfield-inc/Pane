import { afterAll, afterEach, describe, expect, it } from 'vitest';
import type { ComputerUseEngine } from './engine';
import { ScriptHosts } from './scriptHosts';
import { buildScriptHostChild, fakeEngine, PIXEL } from '../../test/computerUseFakes';

const child = buildScriptHostChild();
afterAll(child.cleanup);

let hosts: ScriptHosts | undefined;
afterEach(async () => {
  await hosts?.stopAll('test over');
  hosts = undefined;
});

function makeHosts(engine: ComputerUseEngine, options: { idleTimeoutMs?: number; runTimeoutMs?: number; maxOutputChars?: number } = {}) {
  hosts = new ScriptHosts({ getEngine: () => engine, childEntry: child.entry, ...options });
  return hosts;
}

describe('ScriptHosts', () => {
  it('returns logs, the return value, and engine data', async () => {
    const h = makeHosts(fakeEngine().engine);
    const result = await h.run('a', `console.log('hello', 2); const r = await engine.call('list_apps', {}); return r.data.tool;`);
    expect(result).toEqual({ ok: true, text: 'hello 2\nlist_apps', images: [] });
  });

  it('keeps globalThis state per connection until reset', async () => {
    const h = makeHosts(fakeEngine().engine);
    await h.run('a', 'globalThis.count = 41');
    expect((await h.run('a', 'return ++count')).text).toBe('42');
    expect((await h.run('b', 'return typeof count')).text).toBe('undefined');
    expect(h.reset('a')).toBe(true);
    expect((await h.run('a', 'return typeof count')).text).toBe('undefined');
  });

  it('returns images the script attaches', async () => {
    const h = makeHosts(fakeEngine().engine);
    const result = await h.run('a', `image(await engine.call('screenshot', { pid: 1 }))`);
    expect(result.images).toEqual([PIXEL]);
  });

  it('reports a thrown error with ok false and keeps the host usable', async () => {
    const h = makeHosts(fakeEngine().engine);
    const result = await h.run('a', `console.log('before'); throw new Error('boom')`);
    expect(result.ok).toBe(false);
    expect(result.text).toMatch(/^before\nError: boom/);
    expect((await h.run('a', 'return 1')).ok).toBe(true);
  });

  it('gives scripts no require or process', async () => {
    const h = makeHosts(fakeEngine().engine);
    expect((await h.run('a', 'return [typeof require, typeof process].join()')).text).toBe('undefined,undefined');
  });

  it('serializes two agents on the same app and runs different apps in parallel', async () => {
    const { engine, log } = fakeEngine(40);
    const h = makeHosts(engine);
    const typeInto = (pid: number, text: string) =>
      `for (const ch of ${JSON.stringify(text)}) await engine.call('type_text', { pid: ${pid}, text: ch })`;

    await Promise.all([h.run('a', typeInto(7, 'ab')), h.run('b', typeInto(7, 'xy'))]);
    // Same window: every call finishes before the next one starts.
    for (let i = 0; i < log.length; i += 2) {
      expect(log[i].replace('start', '')).toBe(log[i + 1].replace('end', ''));
    }

    log.length = 0;
    await Promise.all([h.run('a', typeInto(7, 'a')), h.run('b', typeInto(8, 'b'))]);
    expect(log.slice(0, 2).sort()).toEqual(['start type_text:a', 'start type_text:b']);
  });

  it('caps long output', async () => {
    const h = makeHosts(fakeEngine().engine, { maxOutputChars: 10 });
    const result = await h.run('a', `return 'x'.repeat(25)`);
    expect(result.text).toBe(`${'x'.repeat(10)}\n[output truncated: 15 more characters]`);
  });

  it('stops a script that runs too long and resets its state', async () => {
    const h = makeHosts(fakeEngine().engine, { runTimeoutMs: 1000 });
    await h.run('a', 'globalThis.kept = true');
    const result = await h.run('a', 'await new Promise(() => {})');
    expect(result).toEqual({ ok: false, text: 'The script ran longer than 1 s and was stopped; its state was reset.', images: [] });
    expect((await h.run('a', 'return typeof kept')).text).toBe('undefined');
  });

  it('closes an idle host', async () => {
    const h = makeHosts(fakeEngine().engine, { idleTimeoutMs: 100 });
    await h.run('a', 'globalThis.kept = true');
    expect(h.summaries().map((s) => s.connectionId)).toEqual(['a']);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(h.summaries()).toEqual([]);
  });

  it('stopAll ends a running script with the reason and stops the engine', async () => {
    const fake = fakeEngine();
    const h = makeHosts(fake.engine);
    const running = h.run('a', 'await new Promise(() => {})');
    await new Promise((resolve) => setTimeout(resolve, 200));
    await h.stopAll('Computer use is off on this machine.');
    expect(await running).toEqual({ ok: false, text: 'Computer use is off on this machine.', images: [] });
    expect(h.summaries()).toEqual([]);
    expect(fake.stops()).toBe(1);
  });
});
