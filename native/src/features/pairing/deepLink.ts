const PAIRING_SCHEME = 'pane-remote://';

/**
 * A scanned or tapped `pane-remote://` code opens the pairing screen with the
 * code filled in. It never connects on its own: the person confirms first.
 */
export function redirectPairingLink(path: string): string {
  return path.startsWith(PAIRING_SCHEME) ? `/pair?code=${encodeURIComponent(path)}` : path;
}
