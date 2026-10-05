import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
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

type HostOptions = Omit<ConstructorParameters<typeof ScriptHosts>[0], 'getEngine' | 'childEntry'>;

function makeHosts(engine: ComputerUseEngine, options: HostOptions = {}) {
  hosts = new ScriptHosts({ getEngine: () => engine, childEntry: child.entry, ...options });
  return hosts;
}

describe('ScriptHosts', () => {
  it('returns logs, the return value, and engine data', async () => {
    const h = makeHosts(fakeEngine().engine);
    const result = await h.run('a', `console.log('hello', 2); const r = await engine.call('list_windows', {}); return r.data.tool;`);
    expect(result).toEqual({ ok: true, text: 'hello 2\nlist_windows', images: [] });
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

  it('reports a script process that cannot start instead of crashing', async () => {
    hosts = new ScriptHosts({ getEngine: () => fakeEngine().engine, childEntry: '/nonexistent/scriptHostChild.js' });
    const result = await hosts.run('a', 'return 1');
    expect(result.ok).toBe(false);
    expect(result.text).toMatch(/^The script process (failed|exited)/);
  });

  it('drops engine calls still queued when the script is reset', async () => {
    const { engine, log } = fakeEngine(300);
    const h = makeHosts(engine);
    const running = h.run('a', `for (let i = 0; i < 5; i++) engine.call('click', { pid: 9, text: String(i) }); await new Promise(() => {})`);
    // Reset while the first click is still in flight and the other four wait behind it.
    while (log.length === 0) await new Promise((resolve) => setTimeout(resolve, 10));
    h.reset('a');
    await running;
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(log.filter((entry) => entry.startsWith('start'))).toEqual(['start click:0']);
  });

  it('stops a script that forges a message to the daemon, without crashing it', async () => {
    const h = makeHosts(fakeEngine().engine);
    // The vm is not a boundary: a script can reach the real process object and its IPC channel.
    const result = await h.run('a', `setTimeout.constructor('return process')().send({ type: 'call', callId: 1 }); await new Promise(() => {})`);
    expect(result).toEqual({ ok: false, text: 'The script process sent a malformed message and was stopped.', images: [] });
    expect((await h.run('a', 'return 1')).text).toBe('1');
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

  describe('confinement (the vm is not a boundary, so the process is)', () => {
    // Every host-realm function leads back to the child's real `process`.
    const escape = `const p = sleep.constructor('return process')();`;

    it('denies files outside Pane\'s code and child processes', async () => {
      const h = makeHosts(fakeEngine().engine);
      const result = await h.run('a', `${escape}
        const tryIt = (f) => { try { f(); return 'allowed'; } catch (e) { return e.code; } };
        return [
          tryIt(() => p.getBuiltinModule('fs').readFileSync('/etc/hosts')),
          tryIt(() => p.getBuiltinModule('fs').writeFileSync(p.getBuiltinModule('os').tmpdir() + '/escape', 'x')),
          tryIt(() => p.getBuiltinModule('child_process').execSync('true')),
        ].join()`);
      expect(result.text).toBe('ERR_ACCESS_DENIED,ERR_ACCESS_DENIED,ERR_ACCESS_DENIED');
    });

    it.runIf(process.platform === 'darwin')('denies sockets on macOS, so scripts can\'t reach the daemon or the engine directly', async () => {
      const dir = fs.mkdtempSync('/tmp/cu-sock-');
      const socketPath = path.join(dir, 's.sock');
      const server = net.createServer((socket) => socket.end()).listen(socketPath);
      try {
        const h = makeHosts(fakeEngine().engine);
        const result = await h.run('a', `${escape}
          return await new Promise((resolve) => {
            const s = p.getBuiltinModule('net').connect(${JSON.stringify(socketPath)});
            s.on('connect', () => { s.destroy(); resolve('connected'); });
            s.on('error', (e) => resolve(e.code));
          })`);
        expect(result.text).not.toBe('connected');
      } finally {
        server.close();
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });

    it('re-checks caps on what the child sends', async () => {
      const h = makeHosts(fakeEngine().engine, { maxOutputChars: 10 });
      const pixel = JSON.stringify(PIXEL);
      const result = await h.run('a', `${escape}
        p.send({ type: 'done', runId: 0, ok: true, text: 'y'.repeat(300), images: Array.from({ length: 25 }, () => (${pixel})) });
        await new Promise(() => {})`);
      expect(result.text).toBe(`${'y'.repeat(10)}\n[output truncated: 290 more characters]\n[5 more images dropped]`);
      expect(result.images).toHaveLength(20);
    });
  });

  it('a hold keeps other agents off the app, and off the clipboard, until the action ends', async () => {
    const { engine, log } = fakeEngine(40);
    const h = makeHosts(engine);
    const action = `await engine.hold({ pid: 7, clipboard: true }, async () => {
      await engine.call('clipboard_write', { text: 'A1' });
      await engine.call('press_key', { pid: 7, text: 'A2' });
    })`;
    const holding = h.run('a', action);
    while (log.length === 0) await new Promise((resolve) => setTimeout(resolve, 5));
    await Promise.all([
      holding,
      h.run('b', `await engine.call('type_text', { pid: 7, text: 'B' })`),
      h.run('c', `await engine.call('clipboard_write', { text: 'C' })`),
    ]);
    expect(log.filter((entry) => entry.startsWith('start')).slice(0, 2)).toEqual(['start clipboard_write:A1', 'start press_key:A2']);
  });

  it('shows the foreground notice before any foreground call, naming the app', async () => {
    const notices: string[] = [];
    const h = makeHosts(fakeEngine().engine, {
      showForegroundNotice: async ({ connectionId, app }) => {
        notices.push(`${connectionId}:${app}`);
        return `Pane: an agent is bringing ${app} to the front`;
      },
    });
    const result = await h.run('a', `return (await engine.call('click', { pid: 7, delivery_mode: 'foreground' })).notice`);
    expect(notices).toEqual(['a:TextEdit']);
    expect(result.text).toBe('Pane: an agent is bringing TextEdit to the front');
    await h.run('a', `await engine.call('click', { pid: 7 })`);
    expect(notices).toHaveLength(1);
  });

  it('shows one foreground notice per held action, not one per call', async () => {
    const notices: string[] = [];
    const h = makeHosts(fakeEngine().engine, { showForegroundNotice: async ({ app }) => { notices.push(app); return `Pane: bringing ${app}`; } });
    const result = await h.run('a', `return await engine.hold({ pid: 7 }, async () => {
      const first = await engine.call('type_text', { pid: 7, text: 'a', delivery_mode: 'foreground' });
      const second = await engine.call('press_key', { pid: 7, key: 'Return', delivery_mode: 'foreground' });
      return [first.notice, second.notice].join(' | ');
    })`);
    expect(notices).toEqual(['TextEdit']);
    expect(result.text).toBe('Pane: bringing TextEdit | Pane: bringing TextEdit');
  });
});
