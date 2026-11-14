import {
  exchangeRelayPairing,
  RelayPairingError,
  type RelayConnectionProfile,
} from '../../../../shared/remoteClient/relay';
import type { RemoteFetch } from '../../../../shared/remoteClient/remoteDaemonClient';

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
 * `/pair/exchange`. Returns that computer first, then every computer linked with it.
 */
export async function pairThisBrowser(
  page: PairingPage,
  secret: string,
  request: { fetch: RemoteFetch; label: string; phoneId: string },
): Promise<RelayConnectionProfile[]> {
  // The page's host is `<id>.<domain>`. The computer's name arrives with the exchange.
  const [computerId = '', ...domain] = new URL(page.location.origin).host.split('.');
  const scanned = { computerId, domain: domain.join('.'), name: 'your computer' };
  return exchangeRelayPairing(request.fetch, scanned, { secret, label: request.label, phoneId: request.phoneId });
}

/** The pairing error as one line for the connection screen. */
export function pairingErrorText(error: Error): string {
  return error instanceof RelayPairingError ? `${error.message}. ${error.detail}` : error.message;
}
