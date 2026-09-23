import { SerializeAddon } from '@xterm/addon-serialize';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import { Terminal } from '@xterm/headless';

const HEADLESS_SCROLLBACK_LINES = 2500;

/**
 * Maintains an xterm-compatible terminal model for state restoration and
 * local-control screen reads. PTY output parsing is asynchronous, so callers
 * that need a coherent snapshot must await waitForIdle first.
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
    if (this.disposed) return;
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
    return this.disposed
      ? this.finalSerializedBuffer
      : this.serializeAddon.serialize({
          scrollback: includeScrollback ? HEADLESS_SCROLLBACK_LINES : 0,
        }) + (this.win32InputMode ? '\x1b[?9001h' : '');
  }

  /** Return plain text for the currently visible viewport. */
  getScreenText(): string {
    if (this.disposed) return this.finalScreenText;

    const buffer = this.terminal.buffer.active;
    const lines: string[] = [];
    const end = buffer.viewportY + this.terminal.rows;

    for (let index = buffer.viewportY; index < end; index += 1) {
      lines.push(buffer.getLine(index)?.translateToString(true) ?? '');
    }

    while (lines.length > 0 && lines[lines.length - 1] === '') {
      lines.pop();
    }
    return lines.join('\n');
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
    this.terminal.clear();
  }

  dispose(): void {
    if (this.disposed) return;
    this.finalIsAlternateScreen = this.isAlternateScreen;
    // Preserve scrollback for reads that resume after natural exit or shutdown.
    // Explicit destruction drains and saves the model before disposal.
    this.finalSerializedBuffer = this.serializeForRestore(true);
    this.finalScreenText = this.getScreenText();
    this.disposed = true;
    this.terminal.dispose();
    const resolvers = this.idleResolvers;
    this.idleResolvers = [];
    this.pendingWrites = 0;
    for (const resolve of resolvers) resolve();
  }
}
