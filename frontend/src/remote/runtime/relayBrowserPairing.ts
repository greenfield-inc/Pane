import {
  exchangeRelayPairing,
  RelayPairingError,
  type RelayConnectionProfile,
} from '../../../../shared/remoteClient/relay';
import { fullAccessRefusal, readLinkPreview, relayLinkJoin, type RelayLinkJoin } from '../../../../shared/remoteClient/relayLinkPreview';
import type { RemoteFetch } from '../../../../shared/remoteClient/remoteDaemonClient';
import type { RemotePaneConnectionProfile } from '../../../../shared/types/remoteDaemon';

/** Where the browser app is opened from the relay landing's "Continue in browser": `/app/#pair=<secret>`. */
export interface PairingPage {
  location: Pick<Location, 'origin' | 'pathname' | 'search' | 'hash'>;
  history: Pick<History, 'replaceState'>;
}

/** The one-time secret in `#pair=<secret>`, removed from the address bar so it isn't kept or shared. */
export function takePairingSecret({ location, history }: PairingPage): string | null {
  const secret = new URLSearchParams(location.hash.replace(/^#/u, '')).get('pair');
  if (!secret) return null;
  history.replaceState(null, '', `${location.pathname}${location.search}`);
  return secret;
}

/**
 * Pairs this browser with the computer that served it: trades the secret at its own
 * `/pair/exchange`. A link shown as read-only, by the confirm (`watching`) or its preview, pairs only read-only, and one to
 * a computer in `saved` with full access is refused unspent. Returns that computer first, then every computer linked with it.
 */
export async function pairThisBrowser(
  page: PairingPage,
  secret: string,
  request: { fetch: RemoteFetch; label: string; phoneId: string; saved?: readonly RemotePaneConnectionProfile[]; watching?: boolean },
): Promise<RelayConnectionProfile[]> {
  const { computerId } = servedBy(page);
  const preview = await readLinkPreview(request.fetch, { ...servedBy(page), secret });
  const refusal = fullAccessRefusal('browser', computerId, preview?.access, request.saved ?? []);
  if (refusal) throw refusal;
  const watching = request.watching === true || preview?.access === 'read';
  return exchangeRelayPairing(request.fetch, servedBy(page), { secret, label: request.label, phoneId: request.phoneId }, { watching });
}

/**
 * Whether pairing would join this browser's saved computers with another group, which it confirms
 * first; null when it pairs at once. Reading it doesn't spend the secret.
 */
export function browserPairingJoin(
  page: PairingPage,
  secret: string,
  fetch: RemoteFetch,
  saved: readonly RemotePaneConnectionProfile[],
): Promise<RelayLinkJoin | null> {
  return relayLinkJoin(fetch, { ...servedBy(page), secret }, saved);
}

/** The computer that served the page, whose host is `<id>.<domain>`. Its name arrives with the exchange. */
function servedBy(page: PairingPage) {
  const [computerId = '', ...domain] = new URL(page.location.origin).host.split('.');
  return { computerId, domain: domain.join('.'), name: 'your computer' };
}

/** The pairing error as one line for the connection screen. */
export function pairingErrorText(error: Error): string {
  return error instanceof RelayPairingError ? `${error.message}. ${error.detail}` : error.message;
}
