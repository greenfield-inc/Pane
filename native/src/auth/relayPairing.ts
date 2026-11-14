import {
  exchangeRelayPairing,
  linkWithSavedRelayComputers,
  type RelayConnectionProfile,
  type RelayPairingLink,
} from '@shared/remoteClient';
import type { RemotePaneConnectionProfile } from '@shared/types/remoteDaemon';

import { CLIENT_LABEL, createDaemonClient, DEVICE_LABEL, getRuntimeId, streamingFetch } from '@/daemon/createClient';

/**
 * Trades a scanned code's one-time secret for this phone's token. Returns the computer first,
 * then every computer linked with it, each with its own token.
 */
export async function exchangeRelayLink(link: RelayPairingLink): Promise<RelayConnectionProfile[]> {
  return exchangeRelayPairing(streamingFetch, link, { secret: link.secret, label: DEVICE_LABEL ?? CLIENT_LABEL, phoneId: await getRuntimeId() });
}

/**
 * Links a newly paired computer with this phone's other relay computers (D-16), in the
 * background: a computer that is off links the next time the phone pairs again.
 */
export async function linkWithSavedComputers(
  added: RelayConnectionProfile,
  alreadyLinked: readonly RelayConnectionProfile[],
  saved: readonly RemotePaneConnectionProfile[],
): Promise<void> {
  const failed = await linkWithSavedRelayComputers(added, alreadyLinked, saved, createDaemonClient);
  if (failed.length) console.info(`[relay] could not link ${added.label} with ${failed.join(', ')} yet`);
}
