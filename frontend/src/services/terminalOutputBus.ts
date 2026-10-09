import { boundary, decodeOptionalBoundary } from '../../../shared/validation/boundaryDecoder';
import type { TerminalOutputEvent } from '../../../shared/types/panels';

/**
 * One `terminal:output` subscription for the whole grid, fanned out by panel.
 *
 * The event is broadcast for every panel, so a listener per live tile means
 * every panel's output visits every tile: twelve busy agents cost twelve
 * dispatches each, a hundred and forty-four callbacks per tick, before any of
 * them has decided the chunk was not theirs. The bus takes the broadcast once,
 * decodes it once, and hands it only to the tile that asked for that panel.
 *
 * The IPC subscription itself is created on the first listener and torn down
 * with the last, so leaving Mission Control leaves nothing attached.
 */

type TerminalOutputListener = (output: string) => void;

const payloadSchema = boundary.object({
  panelId: boundary.string,
  output: boundary.string,
});

const listenersByPanel = new Map<string, Set<TerminalOutputListener>>();
let unsubscribeFromIpc: (() => void) | null = null;

function dispatch(payload: TerminalOutputEvent): void {
  // Reject what is not addressed to a panel anyone is watching before paying
  // for a decode.
  if (!('panelId' in payload)) return;
  const listeners = listenersByPanel.get(payload.panelId);
  if (!listeners || listeners.size === 0) return;

  const data = decodeOptionalBoundary(payload, payloadSchema);
  if (!data) return;
  // A copy: a listener that unsubscribes itself while the set is being walked
  // would otherwise skip the listener after it.
  for (const listener of [...listeners]) listener(data.output);
}

/** Listen to one panel's PTY output. Returns the unsubscribe. */
export function subscribeToTerminalOutput(
  panelId: string,
  listener: TerminalOutputListener,
): () => void {
  let listeners = listenersByPanel.get(panelId);
  if (!listeners) {
    listeners = new Set();
    listenersByPanel.set(panelId, listeners);
  }
  listeners.add(listener);

  unsubscribeFromIpc ??= window.electronAPI.events.onTerminalOutput(dispatch);

  return () => {
    const current = listenersByPanel.get(panelId);
    if (!current) return;
    current.delete(listener);
    if (current.size === 0) listenersByPanel.delete(panelId);
    if (listenersByPanel.size === 0) {
      unsubscribeFromIpc?.();
      unsubscribeFromIpc = null;
    }
  };
}
