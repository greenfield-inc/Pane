/** The parts of a WebContents this needs (Electron's WebContents fits). */
export interface DebuggableContents {
  isDestroyed(): boolean;
  once(event: 'destroyed', listener: () => void): void;
  debugger: { attach(protocolVersion?: string): void; isAttached(): boolean; detach(): void };
}

const retained = new Set<DebuggableContents['debugger']>();

/**
 * The only way Pane attaches a Chrome DevTools debugger to a WebContents (a test fails on any other
 * `.debugger.attach(`). In Electron 43 a Debugger that garbage collection frees while still attached
 * crashes the whole app when its page closes (electron/electron#53376: closing an approval's
 * document did this, D-216). So this holds the Debugger until its WebContents is destroyed, and
 * detaches it then if it is still attached.
 */
export function attachDebugger(contents: DebuggableContents, protocolVersion = '1.3'): void {
  const debug = contents.debugger;
  if (debug.isAttached()) return;
  debug.attach(protocolVersion);
  if (retained.has(debug)) return;
  retained.add(debug);
  const release = () => {
    try {
      if (debug.isAttached()) debug.detach();
    } finally {
      retained.delete(debug);
    }
  };
  if (contents.isDestroyed()) release();
  else contents.once('destroyed', release);
}

/** How many debuggers are held until their page goes; for tests. */
export const retainedDebuggerCount = (): number => retained.size;
