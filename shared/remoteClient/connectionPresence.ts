import type { RemotePaneConnectionStatus } from '../types/remoteDaemon';

/** How long a connection may be down before Pane says so. Until then it dims and pulses. */
export const CONNECTION_GRACE_MS = 10_000;

/**
 * What the machine dot and the content under it show. `restoring` is a machine
 * that answered but is still reloading after the grace window: it pulses like
 * `reconnecting` and says so in a bar.
 */
export type ConnectionPresence = 'connected' | 'reconnecting' | 'restoring' | 'unreachable';

/** `downForMs` is how long the connection has been continuously not connected. */
export function connectionPresence(status: RemotePaneConnectionStatus, downForMs: number): ConnectionPresence {
  if (status === 'connected') return 'connected';
  // The client stopped: it gave up, or the host rejected its credential. Waiting cannot help.
  if (status === 'error') return 'unreachable';
  if (downForMs < CONNECTION_GRACE_MS) return 'reconnecting';
  return status === 'restoring' ? 'restoring' : 'unreachable';
}

export interface ConnectionNotice {
  message: string;
  canRetry: boolean;
}

/** The one-line bar shown under the header once the grace window has passed, or null. */
export function connectionNotice(
  state: { status: RemotePaneConnectionStatus; lastError: string | null },
  downForMs: number,
  machine: string,
): ConnectionNotice | null {
  const presence = connectionPresence(state.status, downForMs);
  if (presence === 'restoring') return { message: `Reconnecting to ${machine}…`, canRetry: false };
  if (presence !== 'unreachable') return null;
  if (state.status !== 'error') return { message: `Can't reach ${machine}. Retrying…`, canRetry: true };
  // Anything else, such as a rejected connection code, explains itself.
  const { lastError } = state;
  const gaveUp = !lastError || lastError.startsWith('Could not reconnect within five minutes');
  return { message: gaveUp ? `Can't reach ${machine}.` : lastError, canRetry: true };
}
