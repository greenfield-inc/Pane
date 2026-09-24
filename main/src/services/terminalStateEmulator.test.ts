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

  it('can blank dim cells, which TUIs use for placeholder suggestions', async () => {
    const emulator = new TerminalStateEmulator(40, 5);

    emulator.write('❯ \x1b[2mTry "fix the tests"\x1b[22m\r\ntyped \x1b[2mhint\x1b[22m kept');
    await emulator.waitForIdle();

    expect(emulator.getScreenText()).toBe('❯ Try "fix the tests"\ntyped hint kept');
    expect(emulator.getScreenText({ omitDim: true })).toBe('❯\ntyped      kept');
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

  it('keeps restore serialization current across output, resizes, and clears', async () => {
    const emulator = new TerminalStateEmulator(40, 2);
    emulator.write('line-1\r\nline-2\r\nline-3');
    await emulator.waitForIdle();
    expect(emulator.serializeForRestore()).not.toContain('line-1');

    // Growing the viewport pulls scrollback rows back into view.
    emulator.resize(40, 5);
    expect(emulator.serializeForRestore()).toContain('line-1');

    expect(emulator.serializeForRestore(true)).not.toContain('line-4');
    emulator.write('\r\nline-4');
    await emulator.waitForIdle();
    expect(emulator.serializeForRestore(true)).toContain('line-4');

    emulator.clearScrollback();
    expect(emulator.serializeForRestore(true)).not.toContain('line-1');
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

  it('renders in-place cursor-motion repaints as clean scrollback text', async () => {
    const emulator = new TerminalStateEmulator(20, 5);

    // A spinner that repaints its status line in place via cursor-column moves
    // (not carriage returns). The raw append log of these bytes, once ANSI is
    // stripped, collapses into overlapping garbage ("Workingorking•rking...").
    // The emulator applies the motions in place, so the rendered line is clean.
    emulator.write('Working');
    emulator.write('\x1b[7D\x1b[KWorking.');
    emulator.write('\x1b[8D\x1b[KWorking..');
    emulator.write('\x1b[9D\x1b[KWorking...');
    await emulator.waitForIdle();

    const text = emulator.getScrollbackText();
    expect(text).toBe('Working...');
    expect(text).not.toContain('orking•');
    emulator.dispose();
  });

  it('limits scrollback text to the last N rendered lines', async () => {
    const emulator = new TerminalStateEmulator(40, 3);
    for (let i = 1; i <= 10; i++) {
      emulator.write(`line-${String(i).padStart(2, '0')}\r\n`);
    }
    await emulator.waitForIdle();

    const lastThree = emulator.getScrollbackText(3);
    expect(lastThree).toBe('line-08\nline-09\nline-10');

    const all = emulator.getScrollbackText();
    expect(all).toContain('line-01');
    expect(all).toContain('line-10');
    emulator.dispose();
  });

  it('preserves bounded scrollback reads after disposal', async () => {
    const emulator = new TerminalStateEmulator(40, 3);
    for (let i = 1; i <= 10; i++) {
      emulator.write(`line-${String(i).padStart(2, '0')}\r\n`);
    }
    await emulator.waitForIdle();

    emulator.dispose();

    expect(emulator.getScrollbackText(2)).toBe('line-09\nline-10');
    expect(emulator.getScrollbackText()).toContain('line-01');
  });

  it('rejects invalid scrollback line limits', () => {
    const emulator = new TerminalStateEmulator(40, 3);

    expect(() => emulator.getScrollbackText(-1)).toThrow(RangeError);
    expect(() => emulator.getScrollbackText(1.5)).toThrow(RangeError);
    expect(() => emulator.getScrollbackText(Number.POSITIVE_INFINITY)).toThrow(RangeError);

    emulator.dispose();
  });

  it('captures OSC title set via the OSC 0 form', async () => {
    const emulator = new TerminalStateEmulator(20, 5);
    emulator.write('\x1b]0;Action Required · Codex\x07');
    await emulator.waitForIdle();
    expect(emulator.getOscTitle()).toBe('Action Required · Codex');
    emulator.dispose();
  });
});
