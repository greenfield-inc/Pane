import { DEFAULT_RELAY_DOMAIN, relayComputerAddress, type RelayPairingLink, type RemoteFetch } from '@shared/remoteClient';
import { fetchWithin } from '@shared/remoteClient/relay';
import type { RelayLinkJoin } from '@shared/remoteClient/relayLinkPreview';
import { readOnlyMarkSchema } from '@shared/types/accessLevel';
import { boundary, decodeOptionalBoundary } from '@shared/validation/boundaryDecoder';

const previewSchema = boundary.object({ access: readOnlyMarkSchema, group: boundary.array(boundary.object({ name: boundary.nonEmptyString })) });

/**
 * What a Read only link lets a phone watch, read without spending it, for a link that would pair
 * without asking. Null for a full-access link, and when the computer can't say.
 */
export async function readOnlyLink(fetch: RemoteFetch, link: RelayPairingLink): Promise<RelayLinkJoin | null> {
  // A link through another relay domain waits for a tap before anything connects.
  if (link.domain !== DEFAULT_RELAY_DOMAIN) return null;
  try {
    const response = await fetchWithin(fetch, `${relayComputerAddress(link)}/pair/preview`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ secret: link.secret }),
      cache: 'no-store',
    });
    const preview = response.ok ? decodeOptionalBoundary(response.body, previewSchema) : undefined;
    const maker = preview?.group[0]?.name;
    return preview && maker ? { maker, makerGroup: preview.group.map(computer => computer.name), here: [], access: 'read' } : null;
  } catch {
    return null;
  }
}
