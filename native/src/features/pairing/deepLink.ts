const PAIRING_SCHEME = 'pane-remote://';

// The code holds a bearer token, so it waits here in memory instead of in
// the route (route params show up in navigation state and dev logs).
let pendingCode: string | null = null;

/**
 * A scanned or tapped `pane-remote://` code opens the pairing screen with the
 * code filled in. It never connects on its own: the person confirms first.
 */
export function redirectPairingLink(path: string): string {
  if (!path.startsWith(PAIRING_SCHEME)) return path;
  pendingCode = path;
  return '/pair';
}

/** The code from the last pairing link, once. */
export function takePendingPairingCode(): string | null {
  const code = pendingCode;
  pendingCode = null;
  return code;
}
