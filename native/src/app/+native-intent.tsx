import { openHref, parseIncomingLink } from '@/features/links/links';
import { redirectPairingLink } from '@/features/pairing/deepLink';

/** Rewrites the OS links Pane handles before Expo Router matches them. */
export function redirectSystemPath({ path }: { path: string; initial: boolean }): string {
  const link = parseIncomingLink(path);
  if (link.type === 'glasses') return '/settings/glasses';
  return link.type === 'open' ? openHref(link.target) : redirectPairingLink(path);
}
