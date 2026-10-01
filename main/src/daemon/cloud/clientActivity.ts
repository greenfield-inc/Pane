import type { RemoteDaemonClientRecord } from '../../../../shared/types/remoteDaemon';
import { boundary, decodeOptionalBoundary } from '../../../../shared/validation/boundaryDecoder';
import type { PaneCommandOrigin } from '../commandRegistry';

/** The coordinator's own calls must never keep a sandbox awake. */
const CLOUD_CHANNEL_PREFIX = 'runpane:cloud:';

const clientScopeSchema = boundary.object({
  scope: boundary.optional(boundary.string),
});

/**
 * Peer daemons are paired client records with `scope: 'peer'` (m3). Read structurally so this
 * works before and after that field lands on RemoteDaemonClientRecord.
 */
export function isPeerClientRecord(record: RemoteDaemonClientRecord | undefined): boolean {
  return decodeOptionalBoundary(record, clientScopeSchema)?.scope === 'peer';
}

export function commandOriginForClient(record: RemoteDaemonClientRecord | undefined): PaneCommandOrigin {
  return isPeerClientRecord(record) ? 'remote-peer' : 'remote-user';
}

export interface RecentUserInvoke {
  clientId: string | null;
  label: string | null;
  at: number;
}

/**
 * Remembers when each paired user client last called `/invoke`, for safe-to-stop's
 * "user client attached" condition. Peers and `runpane:cloud:*` calls are not recorded.
 */
export class UserClientActivityTracker {
  private readonly lastInvokes = new Map<string, RecentUserInvoke>();

  recordInvoke(input: {
    record: RemoteDaemonClientRecord | undefined;
    clientId: string | null;
    label: string | null;
    channel: string;
    at: number;
  }): void {
    if (input.channel.startsWith(CLOUD_CHANNEL_PREFIX) || isPeerClientRecord(input.record)) {
      return;
    }
    const key = input.clientId ?? 'unpaired';
    this.lastInvokes.set(key, { clientId: input.clientId, label: input.label, at: input.at });
  }

  /** User clients that invoked at or after `since`, most recent first. */
  invokedSince(since: number): RecentUserInvoke[] {
    return [...this.lastInvokes.values()]
      .filter(entry => entry.at >= since)
      .sort((left, right) => right.at - left.at);
  }

  reset(): void {
    this.lastInvokes.clear();
  }
}

export const userClientActivity = new UserClientActivityTracker();
