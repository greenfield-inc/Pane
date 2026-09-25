import { decodeRemoteConnectionCode } from '@shared/remoteClient';

/**
 * The host a pane-remote:// code points at, decoded on the phone, so the
 * person can check it before connecting (a code from a link could name
 * someone else's host). Null while the input is not a valid code.
 */
export function describeConnectionCode(code: string): { label: string; baseUrl: string } | null {
  try {
    const { label, baseUrl } = decodeRemoteConnectionCode(code);
    return { label, baseUrl };
  } catch {
    return null;
  }
}
