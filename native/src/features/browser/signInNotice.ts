import * as SecureStore from 'expo-secure-store';

/** SecureStore keys allow letters, digits, ".", "-" and "_". */
const keyFor = (host: string) => `browser.signInNotice.${host.replace(/[^A-Za-z0-9._-]/g, '_')}`;

/** Each host's answer, read once: the stream renders per frame, and a Keychain read per frame is costly. */
const seen = new Map<string, boolean>();

/** Whether this phone already showed the one-time note about whose sign-ins a host's tabs use. */
export function signInNoticeSeen(host: string): boolean {
  const known = seen.get(host);
  if (known !== undefined) return known;
  let answer = false;
  try {
    answer = SecureStore.getItem(keyFor(host)) === 'seen';
  } catch {
    answer = false;
  }
  seen.set(host, answer);
  return answer;
}

export function markSignInNoticeSeen(host: string): void {
  seen.set(host, true);
  void SecureStore.setItemAsync(keyFor(host), 'seen').catch(() => undefined);
}

/** The note a screen shows the first time it streams a tab from `host`. */
export function signInNotice(host: string): string {
  return `This page runs on ${host}, signed in as ${host}. Sign in here once and every device sees it.`;
}
