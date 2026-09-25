import { describe, expect, it } from 'vitest';

import { TerminalSession, utf8ByteLength } from './terminalSession';

interface Call {
  channel: string;
  args: unknown[];
}

/** A fake host. `respond` answers a channel; unanswered channels resolve to undefined. */
function fakeHost(respond: Record<string, (args: unknown[]) => unknown> = {}) {
  const calls: Call[] = [];
  const screen: string[] = [];
  const invoke = async (channel: string, args: unknown[]) => {
    calls.push({ channel, args });
    return respond[channel]?.(args);
  };
  const session = new TerminalSession({
    invoke,
    panelId: 'panel-1',
    sessionId: 'pane-1',
    viewerId: 'viewer-1',
    sink: {
      reset: data => screen.splice(0, screen.length, `[reset]${data}`),
      write: data => screen.push(data),
    },
  });
  return { calls, screen, session, channels: () => calls.map(call => call.channel) };
}

const tick = () => new Promise(resolve => setTimeout(resolve, 0));

describe('TerminalSession.restore', () => {
  it('sizes a running panel\'s PTY before reading its snapshot', async () => {
    const host = fakeHost({
      'panels:checkInitialized': () => true,
      'terminal:getState': () => ({ scrollbackBuffer: '$ ls\r\nREADME.md\r\n' }),
    });

    await host.session.restore({ cols: 48, rows: 30 });

    expect(host.calls).toEqual([
      { channel: 'panels:checkInitialized', args: ['panel-1'] },
      { channel: 'terminal:resize', args: ['panel-1', 48, 30] },
      { channel: 'terminal:setVisibility', args: ['panel-1', true, 'viewer-1'] },
      { channel: 'terminal:getState', args: ['panel-1'] },
    ]);
    expect(host.screen).toEqual(['[reset]$ ls\r\nREADME.md\r\n']);
  });

  it('starts an unstarted panel at the screen size and shows everything it prints from the first byte', async () => {
    const host = fakeHost({ 'panels:checkInitialized': () => false });
    let releaseStart: () => void = () => undefined;
    const started = new Promise<void>(resolve => { releaseStart = resolve; });
    const session = new TerminalSession({
      invoke: async (channel, args) => {
        host.calls.push({ channel, args });
        if (channel === 'panels:checkInitialized') return false;
        if (channel === 'panels:initialize') await started;
      },
      panelId: 'panel-1',
      sessionId: 'pane-1',
      viewerId: 'viewer-1',
      sink: { reset: data => host.screen.push(`[reset]${data}`), write: data => host.screen.push(data) },
    });

    const restoring = session.restore({ cols: 48, rows: 30 });
    await tick();
    session.receiveOutput({ panelId: 'panel-1', output: 'first frame' });
    releaseStart();
    await restoring;

    expect(host.screen).toEqual(['[reset]', 'first frame']);
    expect(host.calls).toContainEqual({ channel: 'panels:initialize', args: ['panel-1', { sessionId: 'pane-1', cols: 48, rows: 30 }] });
    expect(host.channels()).not.toContain('terminal:getState');
  });

  it('shows the serialized frame of a full-screen app and forces it to repaint', async () => {
    const host = fakeHost({
      'panels:checkInitialized': () => true,
      'terminal:getState': () => ({
        isAlternateScreen: true,
        scrollbackBuffer: 'shell history',
        serializedBuffer: 'claude frame',
      }),
    });

    await host.session.restore({ cols: 48, rows: 30 });

    expect(host.screen).toEqual(['[reset]claude frame']);
    expect(host.channels()).not.toContain('panels:initialize');
    expect(host.calls.at(-1)).toEqual({ channel: 'terminal:resize', args: ['panel-1', 48, 30, { force: true }] });
  });

  it('joins a legacy array scrollback', async () => {
    const host = fakeHost({
      'panels:checkInitialized': () => true,
      'terminal:getState': () => ({ scrollbackBuffer: ['one\r\n', 'two\r\n'] }),
    });

    await host.session.restore({ cols: 80, rows: 24 });

    expect(host.screen).toEqual(['[reset]one\r\ntwo\r\n']);
  });

  it('drops a restore that finishes after the screen detached', async () => {
    let releaseState: (state: unknown) => void = () => undefined;
    const host = fakeHost({
      'panels:checkInitialized': () => true,
      'terminal:getState': () => new Promise(resolve => { releaseState = resolve; }),
    });

    const restoring = host.session.restore({ cols: 80, rows: 24 });
    await tick();
    host.session.detach();
    releaseState({ scrollbackBuffer: 'late' });
    await restoring;

    expect(host.screen).toEqual([]);
  });
});

describe('TerminalSession output', () => {
  it('writes output for its panel once the snapshot is shown, and only acks output that arrived before it', async () => {
    let releaseState: (state: unknown) => void = () => undefined;
    const host = fakeHost({
      'panels:checkInitialized': () => true,
      'terminal:getState': () => new Promise(resolve => { releaseState = resolve; }),
    });

    const restoring = host.session.restore({ cols: 80, rows: 24 });
    await tick();
    host.session.receiveOutput({ panelId: 'panel-1', output: 'héllo' });
    releaseState({ scrollbackBuffer: 'héllo' });
    await restoring;
    host.session.receiveOutput({ panelId: 'panel-1', output: ' world' });
    host.session.receiveOutput({ panelId: 'panel-2', output: 'other pane' });

    expect(host.screen).toEqual(['[reset]héllo', ' world']);
    expect(host.calls.filter(call => call.channel === 'terminal:ack')).toEqual([
      { channel: 'terminal:ack', args: ['panel-1', 6] },
    ]);
  });

  it('keeps one ack in flight and folds the bytes rendered meanwhile into the next one', async () => {
    let releaseAck: () => void = () => undefined;
    const host = fakeHost({ 'terminal:ack': () => new Promise<void>(resolve => { releaseAck = resolve; }) });

    host.session.ack(100);
    host.session.ack(20);
    host.session.ack(30);
    releaseAck();
    await tick();

    expect(host.calls).toEqual([
      { channel: 'terminal:ack', args: ['panel-1', 100] },
      { channel: 'terminal:ack', args: ['panel-1', 50] },
    ]);
  });
});

describe('TerminalSession.sendInput', () => {
  it('delivers keystrokes in the order they were typed even when a request is slow', async () => {
    const delivered: string[] = [];
    let releaseFirst: () => void = () => undefined;
    const host = fakeHost({
      'terminal:input': ([, data]) => {
        if (data === 'first') return new Promise<void>(resolve => { releaseFirst = () => { delivered.push('first'); resolve(); }; });
        delivered.push(data as string);
      },
    });

    const first = host.session.sendInput('first');
    const second = host.session.sendInput('\r');
    await tick();
    expect(delivered).toEqual([]);
    releaseFirst();
    await Promise.all([first, second]);

    expect(delivered).toEqual(['first', '\r']);
  });

  it('keeps sending after one keystroke fails', async () => {
    const host = fakeHost({
      'terminal:input': ([, data]) => {
        if (data === 'bad') throw new Error('offline');
      },
    });

    await expect(host.session.sendInput('bad')).rejects.toThrow('offline');
    await host.session.sendInput('good');

    expect(host.calls.map(call => call.args[1])).toEqual(['bad', 'good']);
  });
});

describe('utf8ByteLength', () => {
  it('counts UTF-8 bytes, which is what the host counts for flow control', () => {
    expect(utf8ByteLength('abc')).toBe(3);
    expect(utf8ByteLength('é')).toBe(2);
    expect(utf8ByteLength('€')).toBe(3);
    expect(utf8ByteLength('😀')).toBe(4);
    expect(utf8ByteLength('\x1b[31m✓\x1b[0m')).toBe(5 + 3 + 4);
  });
});
