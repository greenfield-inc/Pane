import { EventEmitter } from 'events';
import { Writable } from 'stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createWindowsKeepAwakeHelper,
  F15_INTERVAL_MS,
  HELPER_READY_TIMEOUT_MS,
  type HelperProcess,
  type WindowsKeepAwakeMode,
} from './windowsKeepAwakeHelper';

function createLogger() {
  return { info: vi.fn(), warn: vi.fn() };
}

class FakeHelperProcess extends EventEmitter implements HelperProcess {
  readonly stdout = new EventEmitter();
  readonly stdin = { write: vi.fn(), end: vi.fn(), on: vi.fn() };
  readonly kill = vi.fn(() => true);

  say(line: string): void {
    this.stdout.emit('data', Buffer.from(`${line}\r\n`));
  }
}

describe('Windows keep-awake helper', () => {
  let processes: FakeHelperProcess[];
  let modes: WindowsKeepAwakeMode[];
  let logger: ReturnType<typeof createLogger>;
  let spawn: (mode: WindowsKeepAwakeMode) => HelperProcess;

  beforeEach(() => {
    vi.useFakeTimers();
    processes = [];
    modes = [];
    logger = createLogger();
    spawn = mode => {
      const child = new FakeHelperProcess();
      processes.push(child);
      modes.push(mode);
      return child;
    };
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('starts one helper in the requested mode and logs once it holds the request', () => {
    const helper = createWindowsKeepAwakeHelper({ spawn, logger });

    helper.start('system-required');
    processes[0].say('ready');

    expect(modes).toEqual(['system-required']);
    expect(logger.info).toHaveBeenCalledTimes(1);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('presses F15 when ready and then every 59 seconds', () => {
    const helper = createWindowsKeepAwakeHelper({ spawn, logger });

    helper.start('press-f15');
    expect(processes[0].stdin.write).not.toHaveBeenCalled();

    processes[0].say('ready');
    expect(processes[0].stdin.write).toHaveBeenCalledTimes(1);
    expect(processes[0].stdin.write).toHaveBeenLastCalledWith('f15\n');

    vi.advanceTimersByTime(58_999);
    expect(processes[0].stdin.write).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1);
    expect(processes[0].stdin.write).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(59_000 * 3);
    expect(processes[0].stdin.write).toHaveBeenCalledTimes(5);
    expect(F15_INTERVAL_MS).toBe(59_000);
  });

  it('never presses F15 while holding the system request', () => {
    const helper = createWindowsKeepAwakeHelper({ spawn, logger });

    helper.start('system-required');
    processes[0].say('ready');
    vi.advanceTimersByTime(10 * 60_000);

    expect(processes[0].stdin.write).not.toHaveBeenCalled();
  });

  it('closes stdin, kills the helper and stops pressing when stopped', () => {
    const helper = createWindowsKeepAwakeHelper({ spawn, logger });

    const handle = helper.start('press-f15');
    processes[0].say('ready');
    handle.stop();
    processes[0].emit('exit', null, 'SIGTERM');
    vi.advanceTimersByTime(5 * 60_000);

    expect(processes[0].stdin.end).toHaveBeenCalledTimes(1);
    expect(processes[0].kill).toHaveBeenCalledTimes(1);
    expect(processes[0].stdin.write).toHaveBeenCalledTimes(1);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('warns once with the reason and keeps going when the helper fails before ready', () => {
    const helper = createWindowsKeepAwakeHelper({ spawn, logger });

    helper.start('system-required');
    processes[0].say('error Cannot add type. Definition of new types is not supported in this language mode.');
    processes[0].emit('exit', 1, null);

    expect(logger.warn).toHaveBeenCalledTimes(1);
    const message = String(logger.warn.mock.calls[0][0]);
    expect(message).toContain('Windows system-awake request not held');
    expect(message).toContain('Definition of new types is not supported');
    expect(message).toContain("Electron's request still is");
    expect(message).toContain('Next:');
  });

  it('does not start the helper again after it failed', () => {
    const helper = createWindowsKeepAwakeHelper({ spawn, logger });

    helper.start('system-required');
    processes[0].emit('exit', 1, null);
    const handle = helper.start('press-f15');
    handle.stop();

    expect(processes).toHaveLength(1);
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it('gives up and kills a helper that never reports ready', () => {
    const helper = createWindowsKeepAwakeHelper({ spawn, logger });

    helper.start('press-f15');
    vi.advanceTimersByTime(HELPER_READY_TIMEOUT_MS);

    expect(processes[0].kill).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(String(logger.warn.mock.calls[0][0])).toContain('Windows auto-lock not prevented');
  });

  it('warns when spawning powershell.exe fails', () => {
    const helper = createWindowsKeepAwakeHelper({ spawn, logger });

    helper.start('system-required');
    processes[0].emit('error', Object.assign(new Error('spawn powershell.exe ENOENT'), { code: 'ENOENT' }));

    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(String(logger.warn.mock.calls[0][0])).toContain('spawn powershell.exe ENOENT');
  });

  it('fails soft when writing to the helper fails with EPIPE', async () => {
    const child = new FakeHelperProcess();
    const failingStdin = new Writable({
      write(_chunk, _encoding, callback) {
        callback(Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }));
      },
    });
    Object.assign(child, { stdin: failingStdin });
    const helper = createWindowsKeepAwakeHelper({ spawn: () => child, logger });

    helper.start('press-f15');
    child.say('ready');
    await vi.waitFor(() => expect(logger.warn).toHaveBeenCalledTimes(1));

    expect(String(logger.warn.mock.calls[0][0])).toContain('write EPIPE');
    expect(child.kill).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(F15_INTERVAL_MS * 3);
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it('warns when a ready helper exits on its own, and may start again later', () => {
    const helper = createWindowsKeepAwakeHelper({ spawn, logger });

    helper.start('system-required');
    processes[0].say('ready');
    processes[0].emit('exit', 1, null);
    helper.start('system-required');

    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(String(logger.warn.mock.calls[0][0])).toContain('exited');
    expect(processes).toHaveLength(2);
  });
});
