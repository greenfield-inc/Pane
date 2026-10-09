import type { TerminalPanelState } from '../../../shared/types/panels';

type TerminalRestoreSource = 'alternateScreen' | 'scrollback' | 'serialized';

export interface TerminalRestoreContent {
  content: string;
  source: TerminalRestoreSource;
}

function normalizeScrollback(scrollback: TerminalPanelState['scrollbackBuffer']): string {
  if (Array.isArray(scrollback)) return scrollback.join('\n');
  return scrollback ?? '';
}

/** Select the buffer that represents the live terminal's active screen. */
export function selectTerminalRestoreContent(state: TerminalPanelState): TerminalRestoreContent | null {
  if (state.isAlternateScreen) {
    if (state.serializedBuffer) {
      return { content: state.serializedBuffer, source: 'serialized' };
    }
    if (state.alternateScreenBuffer) {
      return { content: state.alternateScreenBuffer, source: 'alternateScreen' };
    }
  }

  const scrollback = normalizeScrollback(state.scrollbackBuffer);
  if (scrollback) {
    return { content: scrollback, source: 'scrollback' };
  }
  if (state.serializedBuffer) {
    return { content: state.serializedBuffer, source: 'serialized' };
  }
  return null;
}

/**
 * Byte count of a terminal chunk, as the flow-control ack contract measures it.
 * Shared by every viewer that writes to a PTY and must ack what it wrote.
 */
const OUTPUT_ENCODER = new TextEncoder();

export function terminalOutputByteLength(value: string): number {
  return OUTPUT_ENCODER.encode(value).byteLength;
}

export interface TerminalOutputAcknowledger {
  acknowledge(output: string): void;
  flush(): void;
  dispose(): void;
}

/**
 * Batch acknowledgements after xterm reports that it consumed each chunk.
 * Callers own that ordering; this helper owns only the byte accounting and
 * bounded flush cadence shared by terminal viewers.
 */
export function createTerminalOutputAcknowledger(
  send: (bytes: number) => void,
  batchSize = 5_000,
  batchIntervalMs = 100,
): TerminalOutputAcknowledger {
  let pendingBytes = 0;
  let flushTimer: ReturnType<typeof setTimeout> | null = null;

  const flush = () => {
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
    if (pendingBytes === 0) return;
    const bytes = pendingBytes;
    pendingBytes = 0;
    send(bytes);
  };

  return {
    acknowledge(output) {
      pendingBytes += terminalOutputByteLength(output);
      if (pendingBytes >= batchSize) {
        flush();
      } else if (!flushTimer) {
        flushTimer = setTimeout(flush, batchIntervalMs);
      }
    },
    flush,
    dispose: flush,
  };
}
