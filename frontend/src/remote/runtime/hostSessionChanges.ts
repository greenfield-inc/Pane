import { boundary, decodeOptionalBoundary } from '../../../../shared/validation/boundaryDecoder';
import type { RemoteDaemonEventEnvelope } from '../../../../shared/types/remoteDaemon';

/** The host's Session events name the Session that changed. */
const sessionChangeSchema = boundary.object({ sessionId: boundary.nonEmptyString });
const SESSION_CHANNELS: ReadonlySet<string> = new Set(['orchestration-sessions:overview-updated', 'orchestration-sessions:changed']);

/** What the PWA hears from its host: its events, and its connection state (sent on subscribe and on every heartbeat). */
export interface HostSessionChangeSource {
  onEvent(listener: (event: RemoteDaemonEventEnvelope) => void): () => void;
  onStatus(listener: (state: { status: string }) => void): () => void;
}

/**
 * Calls back with the Session each host Session event names. Only a return to connected calls
 * back with none, since changes to any Session may have been missed while away; staying
 * connected (heartbeats, last-seen updates) doesn't (review F-3 follow-up on #1281).
 */
export function watchHostSessionChanges(host: HostSessionChangeSource, callback: (sessionId?: string) => void): () => void {
  const stopEvents = host.onEvent(event => {
    if (SESSION_CHANNELS.has(event.channel)) callback(decodeOptionalBoundary(event.args[0], sessionChangeSchema)?.sessionId);
  });
  let connected: boolean | undefined;
  const stopStatus = host.onStatus(state => {
    const now = state.status === 'connected';
    if (now && connected === false) callback();
    connected = now;
  });
  return () => { stopEvents(); stopStatus(); };
}
