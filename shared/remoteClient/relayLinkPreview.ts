import { readOnlyMarkSchema, type ReadOnlyMark } from '../types/accessLevel';
import type { RemotePaneConnectionProfile } from '../types/remoteDaemon';
import { boundary, decodeOptionalBoundary } from '../validation/boundaryDecoder';
import { fetchWithin, isRelayProfile, relayComputerAddress, type RelayPairingLink } from './relay';
import type { RemoteFetch } from './remoteDaemonClient';

/** Both sides of a pairing link opened where other computers are reached already, as the confirm names them. */
export interface RelayLinkJoin {
  /** The computer whose link this is. */
  maker: string;
  /** The maker and every computer already linked with it. */
  makerGroup: string[];
  /** The computers this device already reaches through a relay. */
  here: string[];
  /**
   * "read" when the maker says the link is read-only: this device watches the maker's group and joins nothing.
   * It is the maker's claim, so whoever confirms it must also link nothing when the exchange answers otherwise.
   */
  access?: ReadOnlyMark;
}

/** `/pair/preview`'s answer: the maker first, then every computer linked with it. */
const previewSchema = boundary.object({
  group: boundary.array(boundary.object({ id: boundary.nonEmptyString, name: boundary.nonEmptyString })),
  access: boundary.optional(readOnlyMarkSchema),
});

/**
 * Whether opening a pairing link links this device's computers with the link's computer, which the
 * device confirms first (D-16 changed). Null when it pairs without asking: it reaches no relay
 * computer yet, or it reaches the link's computer already. Reads the maker's group from
 * `POST https://<id>.<domain>/pair/preview`, which doesn't spend the secret, only to name it: the
 * maker writes that answer, so it never skips the confirm. When the preview can't be read (an older
 * Pane, or no answer), it asks, naming only the link's computer.
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
  const join: RelayLinkJoin = { maker: preview.group[0].name, makerGroup: preview.group.map(computer => computer.name), here };
  if (preview.access) join.access = preview.access;
  return join;
}

async function readPreview(fetch: RemoteFetch, link: Pick<RelayPairingLink, 'secret' | 'computerId' | 'domain'>) {
  try {
    const response = await fetchWithin(fetch, `${relayComputerAddress(link)}/pair/preview`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ secret: link.secret }),
      cache: 'no-store',
    });
    return response.ok ? decodeOptionalBoundary(response.body, previewSchema) ?? null : null;
  } catch {
    return null;
  }
}
