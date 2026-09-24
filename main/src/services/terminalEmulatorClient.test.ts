import { EventEmitter } from 'events';
import { describe, expect, it, vi } from 'vitest';
import { inProcessEmulatorHost } from '../test/inProcessEmulatorHost';
import { TerminalEmulatorHostConnection } from './terminalEmulatorClient';

describe('RemoteTerminalEmulator', () => {
  it('pushes screen changes so synchronous reads catch up without a refresh', async () => {
    const emulator = inProcessEmulatorHost().createEmulator(20, 3);
    emulator.write('\x1b]0;agent title\x07\x1b[?1049h\x1b[Hworking');

    await vi.waitFor(() => expect(emulator.state).toEqual({
      screenText: 'working',
      inputScreenText: 'working',
      isAlternateScreen: true,
      oscTitle: 'agent title',
      oscProgress: '',
    }));
    emulator.dispose();
  });

  it('keeps the final capture, scrollback included, readable after dispose', async () => {
    const emulator = inProcessEmulatorHost().createEmulator(20, 3);
    emulator.write(Array.from({ length: 8 }, (_, index) => `line ${index}`).join('\r\n'));
    emulator.dispose();
    emulator.write('\r\nignored after dispose');

    const snapshot = await emulator.restoreSnapshot();
    expect(snapshot?.serialized).toContain('line 0');
    expect(snapshot?.serialized).not.toContain('ignored');
    expect(snapshot?.screenText).toBe('line 5\nline 6\nline 7');
    expect((await emulator.refresh()).screenText).toBe('line 5\nline 6\nline 7');
  });

  it('reads rendered scrollback across the thread and returns null once disposed', async () => {
    const emulator = inProcessEmulatorHost().createEmulator(20, 3);
    emulator.write('working 10%\rworking 99%\r\ndone\r\n' + Array.from({ length: 5 }, (_, index) => `line ${index}`).join('\r\n'));

    await expect(emulator.readScrollback(100)).resolves.toBe('working 99%\ndone\nline 0\nline 1\nline 2\nline 3\nline 4');
    await expect(emulator.readScrollback(2)).resolves.toBe('line 3\nline 4');

    emulator.dispose();
    await expect(emulator.readScrollback(2)).resolves.toBeNull();
  });

  it('settles reads instead of hanging when the emulator thread dies', async () => {
    const thread = Object.assign(new EventEmitter(), { postMessage: vi.fn(), unref: vi.fn() });
    const emulator = new TerminalEmulatorHostConnection(thread).createEmulator(20, 3);
    const pending = emulator.restoreSnapshot();

    thread.emit('exit');

    await expect(pending).resolves.toBeNull();
    await expect(emulator.refresh()).resolves.toMatchObject({ screenText: '' });
  });
});
