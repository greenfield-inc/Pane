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
  /** The computer removed this device: only a new pairing helps. */
  pairAgain?: boolean;
}

/** What a computer reached through a relay adds: whether it is one, and when the relay says it went to sleep. */
export interface RelayNoticeContext {
  /** The time to show, already formatted, such as "9:40". */
  asleepSince: string | null;
}

/** The one-line bar shown under the header once the grace window has passed, or null. */
export function connectionNotice(
  state: { status: RemotePaneConnectionStatus; lastError: string | null },
  downForMs: number,
  machine: string,
  relay?: RelayNoticeContext,
): ConnectionNotice | null {
  const presence = connectionPresence(state.status, downForMs);
  if (presence === 'restoring') return { message: `Reconnecting to ${machine}…`, canRetry: false };
  if (presence !== 'unreachable') return null;
  // A relay client never gives up, so it stops only when the computer refused its token.
  if (relay && state.status === 'error') {
    return { message: `${machine} removed this device. To use it again, scan a new code on ${machine}.`, canRetry: false, pairAgain: true };
  }
  if (relay?.asleepSince) return { message: `${machine}: Asleep since ${relay.asleepSince}`, canRetry: true };
  if (state.status !== 'error') return { message: `Can't reach ${machine}. Retrying…`, canRetry: true };
  // Anything else, such as a rejected connection code, explains itself.
  const { lastError } = state;
  const gaveUp = !lastError || lastError.startsWith('Could not reconnect within five minutes');
  return { message: gaveUp ? `Can't reach ${machine}.` : lastError, canRetry: true };
}
