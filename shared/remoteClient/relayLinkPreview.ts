import type { RemotePaneConnectionProfile } from '../types/remoteDaemon';
import { boundary, decodeOptionalBoundary } from '../validation/boundaryDecoder';
import { isRelayProfile, relayComputerAddress, type RelayPairingLink } from './relay';
import type { RemoteFetch } from './remoteDaemonClient';

/** Both sides of a pairing link that would join two groups of computers, as the confirm names them. */
export interface RelayLinkJoin {
  /** The computer whose link this is. */
  maker: string;
  /** The maker and every computer already linked with it. */
  makerGroup: string[];
  /** The computers this device already reaches through a relay. */
  here: string[];
}

/** `/pair/preview`'s answer: the maker first, then every computer linked with it. */
const previewSchema = boundary.object({
  group: boundary.array(boundary.object({ id: boundary.nonEmptyString, name: boundary.nonEmptyString })),
});

/**
 * Whether opening a pairing link joins this device's computers with another group, which the
 * device confirms first (D-16 changed). Null when it pairs without asking: it reaches no relay
 * computer yet, or the link's group already holds one of its computers. Reads the group from
 * `POST https://<id>.<domain>/pair/preview`, which doesn't spend the secret. When the preview
 * can't be read (an older Pane, or no answer), it asks, naming only the link's computer.
 */
export async function relayLinkJoin(
  fetch: RemoteFetch,
  link: Pick<RelayPairingLink, 'secret' | 'computerId' | 'domain' | 'name'>,
  saved: readonly RemotePaneConnectionProfile[],
): Promise<RelayLinkJoin | null> {
  const mine = saved.filter(isRelayProfile);
  if (mine.length === 0 || mine.some(profile => profile.relay.computerId === link.computerId)) return null;
  const here = mine.map(profile => profile.label);
  const preview = await readPreview(fetch, link);
  if (!preview?.group.length) return { maker: link.name, makerGroup: [link.name], here };
  // A computer this device already reaches in the maker's group means it is one group already.
  const ids = new Set(mine.map(profile => profile.relay.computerId));
  if (preview.group.some(computer => ids.has(computer.id))) return null;
  return { maker: preview.group[0].name, makerGroup: preview.group.map(computer => computer.name), here };
}

async function readPreview(fetch: RemoteFetch, link: Pick<RelayPairingLink, 'secret' | 'computerId' | 'domain'>) {
  try {
    const response = await fetch(`${relayComputerAddress(link)}/pair/preview`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ secret: link.secret }),
      cache: 'no-store',
    });
    return response.ok ? decodeOptionalBoundary(await response.json(), previewSchema) ?? null : null;
  } catch {
    return null;
  }
}
