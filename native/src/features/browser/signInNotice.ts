import * as SecureStore from 'expo-secure-store';

/** SecureStore keys allow letters, digits, ".", "-" and "_". */
const keyFor = (host: string) => `browser.signInNotice.${host.replace(/[^A-Za-z0-9._-]/g, '_')}`;

/** Whether this phone already showed the one-time note about whose sign-ins a host's tabs use. */
export function signInNoticeSeen(host: string): boolean {
  try {
    return SecureStore.getItem(keyFor(host)) === 'seen';
  } catch {
    return false;
  }
}

export function markSignInNoticeSeen(host: string): void {
  void SecureStore.setItemAsync(keyFor(host), 'seen').catch(() => undefined);
}

/** The note a screen shows the first time it streams a tab from `host`. */
export function signInNotice(host: string): string {
  return `This page runs on ${host}, signed in as ${host}. Sign in here once and every device sees it.`;
}
