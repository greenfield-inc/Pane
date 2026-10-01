import type { RemoteDaemonClientRecord } from '../../../../shared/types/remoteDaemon';

/**
 * What the Runpane Cloud coordinator may call. Its always-on box holds a token for every Session,
 * so a `scope: 'coordinator'` client only asks whether it may stop the sandbox (and releases the stop
 * lease that answer took), and asks for the pinned upgrade (the Session decides what that is); with its
 * token `/health` also reports version and readiness. It never reaches panels, shells, the event stream
 * or WebSockets.
 */
const COORDINATOR_ALLOWED_CHANNELS: ReadonlySet<string> = new Set([
  'runpane:cloud:safe-to-stop',
  'runpane:cloud:stop-lease:release',
  'runpane:cloud:upgrade',
]);

export function isCoordinatorClient(client: Pick<RemoteDaemonClientRecord, 'scope'> | null | undefined): boolean {
  return client?.scope === 'coordinator';
}

export function isCoordinatorAllowedChannel(channel: string): boolean {
  return COORDINATOR_ALLOWED_CHANNELS.has(channel);
}
