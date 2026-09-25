import { redirectPairingLink } from '@/features/pairing/deepLink';

export function redirectSystemPath({ path }: { path: string; initial: boolean }): string {
  return redirectPairingLink(path);
}
