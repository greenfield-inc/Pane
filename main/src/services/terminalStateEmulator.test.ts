import { describe, expect, it } from 'vitest';
import { TerminalStateEmulator } from './terminalStateEmulator';

describe('TerminalStateEmulator', () => {
  it('preserves negotiated Win32 input mode across snapshots and split output chunks', async () => {
    const emulator = new TerminalStateEmulator(20, 5);
    emulator.write('\x1b[?90');
    emulator.write('01h');
    await emulator.waitForIdle();
    expect(emulator.serializeForRestore()).toContain('\x1b[?9001h');
    emulator.write('\x1b[?1049h');
    await emulator.waitForIdle();
    const snapshot = emulator.serializeForRestore();
    expect(snapshot).toContain('\x1b[?9001h');
    const restored = new TerminalStateEmulator(20, 5);
    restored.write(snapshot);
    await restored.waitForIdle();
    expect(restored.serializeForRestore()).toContain('\x1b[?9001h');
    restored.dispose();
    emulator.dispose();
    expect(emulator.serializeForRestore()).toContain('\x1b[?9001h');
  });

  it.each(['\x1b[?9001l', '\x1bc', '\x1b[!p'])('honors Win32 mode reset %j', async (reset) => {
    const emulator = new TerminalStateEmulator(20, 5);
    emulator.write(`\x1b[?9001h${reset}`);
    await emulator.waitForIdle();
    expect(emulator.serializeForRestore()).not.toContain('\x1b[?9001h');
    emulator.dispose();
  });

  it('renders cursor-addressed alternate-screen output as a coherent screen', async () => {
    const emulator = new TerminalStateEmulator(20, 5);

    emulator.write('\x1b[?1049h\x1b[2J\x1b[HClaude\x1b[2;1Hanswer\rworking');
    await emulator.waitForIdle();

    expect(emulator.isAlternateScreen).toBe(true);
    expect(emulator.getScreenText()).toBe('Claude\nworking');
    const serialized = emulator.serializeForRestore();
    expect(serialized).toContain('\x1b[?1049h');

    const restored = new TerminalStateEmulator(20, 5);
    restored.write(serialized);
    await restored.waitForIdle();
    expect(restored.isAlternateScreen).toBe(true);
    expect(restored.getScreenText()).toBe('Claude\nworking');
    restored.dispose();
    emulator.dispose();
  });

  it('restores the normal screen after leaving the alternate buffer', async () => {
    const emulator = new TerminalStateEmulator(20, 5);

    emulator.write('shell prompt\r\n$ claude');
    emulator.write('\x1b[?1049h\x1b[Hagent response');
    await emulator.waitForIdle();
    expect(emulator.getScreenText()).toBe('agent response');

    emulator.write('\x1b[?1049l');
    await emulator.waitForIdle();

    expect(emulator.isAlternateScreen).toBe(false);
    expect(emulator.getScreenText()).toBe('shell prompt\n$ claude');
    emulator.dispose();
  });

  it('tracks terminal resizes', async () => {
    const emulator = new TerminalStateEmulator(10, 2);
    emulator.write('1234567890abc');
    await emulator.waitForIdle();

    emulator.resize(20, 2);
    expect(emulator.getScreenText()).toContain('1234567890');
    emulator.dispose();
  });

  it('retains scrollback history in the post-dispose serialization snapshot', async () => {
    const emulator = new TerminalStateEmulator(40, 3);
    // 10 lines through a 3-row viewport: the early lines live only in scrollback
    for (let i = 1; i <= 10; i++) {
      emulator.write(`history-line-${String(i).padStart(2, '0')}\r\n`);
    }
    await emulator.waitForIdle();

    emulator.dispose();

    // destroyTerminal fires saveTerminalState without awaiting it, so the save
    // reads this snapshot after disposal — it must still include scrollback,
    // or closing a terminal silently truncates its persisted history.
    const serialized = emulator.serializeForRestore(true);
    expect(serialized).toContain('history-line-01');
    expect(serialized).toContain('history-line-10');
  });

  it('includes active input modes in restore serialization', async () => {
    const emulator = new TerminalStateEmulator(20, 5);
    emulator.write('\x1b[?1h\x1b[?1004h\x1b[?2004h');
    await emulator.waitForIdle();

    const serialized = emulator.serializeForRestore();
    expect(serialized).toContain('\x1b[?1h');
    expect(serialized).toContain('\x1b[?1004h');
    expect(serialized).toContain('\x1b[?2004h');
    emulator.dispose();
  });

  it('captures the OSC window title and updates it as it changes', async () => {
    const emulator = new TerminalStateEmulator(20, 5);
    expect(emulator.getOscTitle()).toBe('');

    emulator.write('\x1b]2;⠙ Claude\x07body');
    await emulator.waitForIdle();
    expect(emulator.getOscTitle()).toBe('⠙ Claude');

    emulator.write('\x1b]2;✳ Ready\x07');
    await emulator.waitForIdle();
    expect(emulator.getOscTitle()).toBe('✳ Ready');

    emulator.dispose();
    // Preserved after dispose, like screen text.
    expect(emulator.getOscTitle()).toBe('✳ Ready');
  });

  it('captures OSC title set via the OSC 0 form', async () => {
    const emulator = new TerminalStateEmulator(20, 5);
    emulator.write('\x1b]0;Action Required · Codex\x07');
    await emulator.waitForIdle();
    expect(emulator.getOscTitle()).toBe('Action Required · Codex');
    emulator.dispose();
  });
});
