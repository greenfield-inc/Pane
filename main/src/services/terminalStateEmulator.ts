import { SerializeAddon } from '@xterm/addon-serialize';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import { Terminal } from '@xterm/headless';

const HEADLESS_SCROLLBACK_LINES = 2500;

// A pane switch reads the same idle terminal's restore serialization several
// times (mount, activation refresh, its delayed backstop), and serializing 2500
// rows is the costliest step of each read. Keep each serialization until its emulator next changes,
// for the most recently read few emulators only, so memory stays bounded.
const RESTORE_CACHE_LIMIT = 4;
const restoreCache = new Map<TerminalStateEmulator, { includeScrollback: boolean; serialized: string }>();

/**
 * Maintains an xterm-compatible terminal model for state restoration and
 * local-control screen reads. PTY output parsing is asynchronous, so callers
 * that need a coherent snapshot must await waitForIdle first. The app runs
 * these on the emulator thread (terminalEmulatorHost.ts), not the main thread.
 */
export class TerminalStateEmulator {
  private readonly terminal: Terminal;
  private readonly serializeAddon = new SerializeAddon();
  private pendingWrites = 0;
  private idleResolvers: Array<() => void> = [];
  private disposed = false;
  private finalIsAlternateScreen = false;
  private finalSerializedBuffer = '';
  private finalScreenText = '';
  private finalScrollbackText = '';
  private currentTitle = '';
  private currentProgress = '';
  private win32InputMode = false;

  constructor(cols: number, rows: number) {
    this.terminal = new Terminal({
      cols,
      rows,
      scrollback: HEADLESS_SCROLLBACK_LINES,
      allowProposedApi: true,
    });
    this.terminal.loadAddon(this.serializeAddon);
    // Match the renderer's cell widths. This model backs terminal restore,
    // runpane's screen reads, and agent status detection, so if it measures a
    // wide emoji as one cell while the renderer measures two, every one of
    // those drifts from what the user is actually looking at.
    this.terminal.loadAddon(new Unicode11Addon());
    this.terminal.unicode.activeVersion = '11';
    // The headless 6.0 model/serializer does not know DECSET 9001. Retain it
    // explicitly so a renderer reset or remount does not lose ConPTY's request.
    for (const [final, enabled] of [['h', true], ['l', false]] as const) {
      this.terminal.parser.registerCsiHandler({ prefix: '?', final }, (params) => {
        if (params.includes(9001)) this.win32InputMode = enabled;
        return false;
      });
    }
    this.terminal.parser.registerEscHandler({ final: 'c' }, () => {
      this.win32InputMode = false;
      return false;
    });
    this.terminal.parser.registerCsiHandler({ intermediates: '!', final: 'p' }, () => {
      this.win32InputMode = false;
      return false;
    });
    // Capture OSC window/icon title (OSC 0 / OSC 2) — agents encode live status
    // (spinner, "Action Required") into it, which the status detector reads.
    this.terminal.onTitleChange((title) => {
      this.currentTitle = title;
    });
    // Capture OSC 9;4 progress payloads (e.g. "4;0") where terminals emit them.
    this.terminal.parser.registerOscHandler(9, (data) => {
      this.currentProgress = data;
      return false; // allow other handlers to also process
    });
  }

  write(data: string): void {
    if (!data || this.disposed) return;

    restoreCache.delete(this);
    this.pendingWrites += 1;
    this.terminal.write(data, () => {
      if (this.disposed) return;
      this.pendingWrites -= 1;
      if (this.pendingWrites === 0) {
        const resolvers = this.idleResolvers;
        this.idleResolvers = [];
        for (const resolve of resolvers) resolve();
      }
    });
  }

  waitForIdle(): Promise<void> {
    if (this.pendingWrites === 0) return Promise.resolve();
    return new Promise(resolve => this.idleResolvers.push(resolve));
  }

  resize(cols: number, rows: number): void {
    if (this.disposed || (cols === this.terminal.cols && rows === this.terminal.rows)) return;
    restoreCache.delete(this);
    this.terminal.resize(cols, rows);
  }

  get isAlternateScreen(): boolean {
    return this.disposed
      ? this.finalIsAlternateScreen
      : this.terminal.buffer.active.type === 'alternate';
  }

  /**
   * Serialize the visible normal buffer and, when active, the alternate buffer.
   * Pass includeScrollback to also serialize normal-buffer scrollback history —
   * the restore source for normal buffers, since this model rendered every PTY
   * byte and therefore contains no repaint duplication.
   */
  serializeForRestore(includeScrollback = false): string {
    if (this.disposed) return this.finalSerializedBuffer;
    const cached = restoreCache.get(this);
    restoreCache.delete(this);
    const serialized = cached?.includeScrollback === includeScrollback
      ? cached.serialized
      : this.serializeAddon.serialize({
          scrollback: includeScrollback ? HEADLESS_SCROLLBACK_LINES : 0,
        }) + (this.win32InputMode ? '\x1b[?9001h' : '');
    // Only a fully parsed buffer is safe to reuse; mid-parse reads are partial.
    if (this.pendingWrites === 0) restoreCache.set(this, { includeScrollback, serialized });
    const oldest = restoreCache.size > RESTORE_CACHE_LIMIT ? restoreCache.keys().next().value : undefined;
    if (oldest) restoreCache.delete(oldest);
    return serialized;
  }

  /**
   * Return plain text for the currently visible viewport. omitDim blanks dim
   * cells, which agent TUIs use for placeholder suggestions in their composer.
   */
  getScreenText({ omitDim = false }: { omitDim?: boolean } = {}): string {
    if (this.disposed) return this.finalScreenText;

    const buffer = this.terminal.buffer.active;
    const lines: string[] = [];
    const end = buffer.viewportY + this.terminal.rows;
    const cell = buffer.getNullCell();

    for (let index = buffer.viewportY; index < end; index += 1) {
      const line = buffer.getLine(index);
      if (!line || !omitDim) {
        lines.push(line?.translateToString(true) ?? '');
        continue;
      }
      let text = '';
      for (let column = 0; column < line.length; column += 1) {
        line.getCell(column, cell);
        if (cell.getWidth() === 0) continue;
        text += cell.isDim() ? ' '.repeat(cell.getWidth()) : cell.getChars() || ' ';
      }
      lines.push(text.trimEnd());
    }

    while (lines.length > 0 && lines[lines.length - 1] === '') {
      lines.pop();
    }
    return lines.join('\n');
  }

  /**
   * Return plain text for the buffer's scrollback history plus the current
   * viewport, optionally limited to the last `maxLines` rows. This model
   * rendered every PTY byte with cursor motions applied in place, so the text
   * is free of the overlapping-fragment corruption that plagues an ANSI-stripped
   * raw append log (spinners, progress bars, TUI status lines that repaint via
   * cursor moves rather than carriage returns).
   */
  getScrollbackText(maxLines?: number): string {
    if (maxLines !== undefined && (!Number.isSafeInteger(maxLines) || maxLines < 0)) {
      throw new RangeError('maxLines must be a non-negative safe integer');
    }

    const lines = this.disposed ? this.finalScrollbackText.split('\n') : [];
    if (!this.disposed) {
      const buffer = this.terminal.buffer.active;
      for (let index = 0; index < buffer.length; index += 1) {
        lines.push(buffer.getLine(index)?.translateToString(true) ?? '');
      }
    }

    // Trim trailing blank rows first so `maxLines` counts real content, not the
    // empty rows below the cursor.
    while (lines.length > 0 && lines[lines.length - 1] === '') {
      lines.pop();
    }

    const limited = maxLines !== undefined && maxLines >= 0 && maxLines < lines.length
      ? lines.slice(lines.length - maxLines)
      : lines;
    return limited.join('\n');
  }

  /** Latest OSC window/icon title, preserved after dispose. */
  getOscTitle(): string {
    return this.currentTitle;
  }

  /** Latest OSC 9;4 progress payload (e.g. "4;0"), preserved after dispose. */
  getOscProgress(): string {
    return this.currentProgress;
  }

  clearScrollback(): void {
    restoreCache.delete(this);
    this.terminal.clear();
  }

  dispose(): void {
    if (this.disposed) return;
    this.finalIsAlternateScreen = this.isAlternateScreen;
    // Capture WITH scrollback: destroyTerminal fires saveTerminalState without
    // awaiting it, so the save usually reads this snapshot after disposal — a
    // viewport-only capture would silently drop the session's history.
    this.finalSerializedBuffer = this.serializeForRestore(true);
    restoreCache.delete(this);
    this.finalScreenText = this.getScreenText();
    this.finalScrollbackText = this.getScrollbackText();
    this.disposed = true;
    this.terminal.dispose();
    const resolvers = this.idleResolvers;
    this.idleResolvers = [];
    this.pendingWrites = 0;
    for (const resolve of resolvers) resolve();
  }
}
