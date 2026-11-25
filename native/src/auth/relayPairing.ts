import {
  exchangeRelayPairing,
  linkWithSavedRelayComputers,
  type RelayConnectionProfile,
  type RelayPairingLink,
} from '@shared/remoteClient';
import type { RemotePaneConnectionProfile } from '@shared/types/remoteDaemon';

import { isReadOnlyProfile } from './access';
import { CLIENT_LABEL, createDaemonClient, DEVICE_LABEL, getRuntimeId, streamingFetch } from '@/daemon/createClient';

/**
 * Trades a scanned code's one-time secret for this phone's token. Returns the computer first,
 * then each computer linked with it that `saved` doesn't already reach, with its own token.
 */
export async function exchangeRelayLink(link: RelayPairingLink, saved: readonly RemotePaneConnectionProfile[]): Promise<RelayConnectionProfile[]> {
  const known = saved.flatMap(profile => (profile.relay ? [profile.relay.computerId] : []));
  return exchangeRelayPairing(streamingFetch, link, { secret: link.secret, label: DEVICE_LABEL ?? CLIENT_LABEL, phoneId: await getRuntimeId(), known });
}

/**
 * Links a newly paired computer with this phone's other relay computers (D-16), in the
 * background: a computer that is off links the next time the phone pairs again. A computer this
 * phone is paired Read only with, the new one or another, is never linked.
 */
export async function linkWithSavedComputers(
  added: RelayConnectionProfile,
  alreadyLinked: readonly RelayConnectionProfile[],
  saved: readonly RemotePaneConnectionProfile[],
): Promise<void> {
  if (isReadOnlyProfile(added)) return;
  const peers = saved.filter(profile => !isReadOnlyProfile(profile));
  const failed = await linkWithSavedRelayComputers(added, alreadyLinked, peers, createDaemonClient);
  if (failed.length) console.info(`[relay] could not link ${added.label} with ${failed.join(', ')} yet`);
}
