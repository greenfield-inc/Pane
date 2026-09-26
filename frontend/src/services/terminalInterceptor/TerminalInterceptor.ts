import { isPrintable } from './input';
import type {
  InterceptHandler,
  InterceptResult,
  InterceptorState,
} from './types';

interface TerminalInterceptorOptions {
  onStateChange: (state: InterceptorState) => void;
  onFlush: (data: string) => void;
}

interface InterceptorInput {
  data: string | null;
  key?: number;
  released?: boolean;
}

/** Decode only the interceptor's view; callers still forward the original data. */
function interceptorInput(data: string): InterceptorInput {
  if (!data.startsWith('\x1b[')) return { data };
  // Win32 input mode: CSI Vk;Sc;Uc;Kd;Cs;Rc _. xterm emits one record per event.
  const record = /^\[(\d+);\d+;(\d+);([01]);(\d+);\d+_$/.exec(data.slice(1));
  if (!record) return { data };
  const [, virtualKey, unicode, keyDown, controlState] = record;
  const key = Number(virtualKey);
  const char = Number(unicode);
  const modifiers = Number(controlState);
  // Modifier/lock transitions and key releases are not text or menu actions.
  if (keyDown === '0') return { data: null, key, released: true };
  if ([16, 17, 18, 20, 91, 92, 144, 145].includes(key)) return { data: null };
  if (key === 8 && char === 8) return { data: '\x7f', key };
  if (char > 0 && char <= 0x10ffff) {
    const text = String.fromCodePoint(char);
    // Keep Alt+printable distinct from printable text; Ctrl+Alt may be AltGr.
    return { data: (modifiers & 3) && !(modifiers & 12) ? `\x1b${text}` : text, key };
  }
  const arrow = new Map([[37, 'D'], [38, 'A'], [39, 'C'], [40, 'B']]).get(key);
  if (arrow) {
    const modifier = 1 + ((modifiers & 16) ? 1 : 0)
      + ((modifiers & 3) ? 2 : 0) + ((modifiers & 12) ? 4 : 0);
    return { data: `\x1b[${modifier === 1 ? '' : `1;${modifier}`}${arrow}`, key };
  }
  return { data, key };
}

export class TerminalInterceptor {
  private handlers: Map<string, InterceptHandler> = new Map();
  private active: boolean = false;
  private activeHandler: InterceptHandler | null = null;
  private activeTrigger: string | null = null;
  private buffer: string = ''; // printable chars only (trigger + filter text) — flushed on cancel
  private filterBuffer: string = ''; // just the filter text (after trigger)
  private consumedWin32Keys = new Set<number>();

  private readonly _onStateChange: (state: InterceptorState) => void;
  private readonly _onFlush: (data: string) => void;

  constructor(options: TerminalInterceptorOptions) {
    this._onStateChange = options.onStateChange;
    this._onFlush = options.onFlush;
  }

  registerHandler(trigger: string, handler: InterceptHandler): void {
    this.handlers.set(trigger, handler);
  }

  handleInput(rawData: string): InterceptResult {
    const { data, key, released } = interceptorInput(rawData);
    if (released && key !== undefined) {
      return { consumed: this.consumedWin32Keys.delete(key) };
    }
    if (data === null) return { consumed: false };
    const result = this.handleTextInput(data);
    if (key !== undefined) {
      if (result.consumed) this.consumedWin32Keys.add(key);
      else this.consumedWin32Keys.delete(key);
    }
    return result;
  }

  private handleTextInput(data: string): InterceptResult {
    if (!this.active) {
      const handler = this.handlers.get(data);
      if (handler === undefined) {
        return { consumed: false };
      }

      const activated = handler.onActivate();
      if (!activated) {
        return { consumed: false };
      }

      this.active = true;
      this.activeHandler = handler;
      this.activeTrigger = data;
      this.buffer = data;
      this.filterBuffer = '';
      this.notifyStateChange();
      return { consumed: true };
    }

    // Active: get the action FIRST, before appending to buffer.
    // activeHandler is always non-null when active is true.
    if (this.activeHandler === null) {
      this.deactivate();
      return { consumed: false };
    }
    const action = this.activeHandler.onInput(data, this.filterBuffer);

    switch (action.type) {
      case 'consume':
        // Only buffer printable characters — navigation keys (arrow escape sequences,
        // backspace, etc.) are consumed but NOT added to the buffer, so they won't be
        // flushed to the PTY on cancel.
        if (isPrintable(data)) {
          this.buffer += data;
        }
        return { consumed: true };

      case 'cancel': {
        // Replay the held prefix. Unless this is a picker-owned cancellation
        // key, let the caller forward the original paste, IME or control input.
        const toFlush = this.buffer;
        this.deactivate();
        this._onFlush(toFlush);
        return { consumed: action.consumeInput ?? false };
      }

      case 'dismiss':
        // Silently deactivate without flushing anything to PTY
        this.deactivate();
        return { consumed: true };

      case 'execute':
        this.deactivate();
        return { consumed: true };

      case 'update':
        if (isPrintable(data)) {
          this.buffer += data;
        }
        this.filterBuffer = action.buffer;
        this.notifyStateChange();
        return { consumed: true };
    }
  }

  notifyStateChange(): void {
    this._onStateChange({
      active: this.active,
      triggerChar: this.activeTrigger,
      buffer: this.filterBuffer,
      handlerState: this.activeHandler?.getState() ?? null,
    });
  }

  /** Force-cancel from async code — flushes buffered printable text to PTY */
  forceCancel(): void {
    if (!this.active) return;
    const toFlush = this.buffer;
    this.deactivate();
    this._onFlush(toFlush);
  }

  deactivate(): void {
    if (this.activeHandler !== null) {
      this.activeHandler.onDeactivate();
    }
    this.active = false;
    this.activeHandler = null;
    this.activeTrigger = null;
    this.buffer = '';
    this.filterBuffer = '';
    this.notifyStateChange();
  }

  getState(): InterceptorState {
    return {
      active: this.active,
      triggerChar: this.activeTrigger,
      buffer: this.filterBuffer,
      handlerState: this.activeHandler?.getState() ?? null,
    };
  }

  dispose(): void {
    if (this.active) {
      this.deactivate();
    }
    this.handlers.clear();
    this.consumedWin32Keys.clear();
  }
}
