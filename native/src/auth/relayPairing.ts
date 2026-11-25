import {
  exchangeRelayPairing,
  linkWithSavedRelayComputers,
  type RelayConnectionProfile,
  type RelayPairingLink,
} from '@shared/remoteClient';
import type { LinkPreviewAnswer } from '@shared/remoteClient/relayLinkPreview';
import type { RemotePaneConnectionProfile } from '@shared/types/remoteDaemon';

import { CLIENT_LABEL, createDaemonClient, DEVICE_LABEL, getRuntimeId, streamingFetch } from '@/daemon/createClient';

import { isReadOnlyProfile } from './access';

/**
 * Trades a scanned code's one-time secret for this phone's token. Returns the computer first,
 * then each computer linked with it that `saved` doesn't already reach with full access, with its
 * own token: a watched one gets a fresh token. A Read only link's computer learns of no saved
 * computer but those `preview`, the answer the person agreed to, named; and it must answer Read only.
 */
export async function exchangeRelayLink(link: RelayPairingLink, saved: readonly RemotePaneConnectionProfile[], preview: LinkPreviewAnswer): Promise<RelayConnectionProfile[]> {
  const watching = preview?.access === 'read';
  const full = saved.flatMap(profile => (profile.relay && !isReadOnlyProfile(profile) ? [profile.relay.computerId] : []));
  const known = watching ? full.filter(id => preview.group.some(computer => computer.id === id)) : full;
  return exchangeRelayPairing(streamingFetch, link, { secret: link.secret, label: DEVICE_LABEL ?? CLIENT_LABEL, phoneId: await getRuntimeId(), known }, { watching });
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
  const failed = await linkWithSavedRelayComputers(added, alreadyLinked, saved, createDaemonClient);
  if (failed.length) console.info(`[relay] could not link ${added.label} with ${failed.join(', ')} yet`);
}
