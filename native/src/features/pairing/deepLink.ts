import { parseRelayPairingLink } from '@shared/remoteClient';

const PAIRING_SCHEME = 'pane-remote://';

// The code holds a bearer token or a one-time secret, so it waits here in memory instead of in
// the route (route params show up in navigation state and dev logs).
let pendingCode: string | null = null;

/**
 * A scanned or tapped pairing link opens the pairing screen with it filled in: a
 * `pane-remote://` code, or a pairing QR's `https://<domain>/pair#…` (a universal link) or
 * `pane://pair#…` (the browser landing's "Open in Pane app"). It never pairs on its own: the
 * person confirms first.
 */
export function redirectPairingLink(path: string): string {
  if (!path.startsWith(PAIRING_SCHEME) && !parseRelayPairingLink(path)) return path;
  pendingCode = path;
  return '/pair';
}

/** The code from the last pairing link, once. */
export function takePendingPairingCode(): string | null {
  const code = pendingCode;
  pendingCode = null;
  return code;
}
