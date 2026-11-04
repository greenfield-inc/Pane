import { SHARED_BROWSER_PARTITION } from '../../../../../shared/constants/browserPartitions';

export { normalizeUrl } from '../../../../../shared/utils/browserUrl';

/**
 * The store a tab's webview loads in: the isolated one main prepared for a remote
 * host file preview, otherwise the store every project and Session shares.
 */
export function webviewPartition(fileSession: { partition: string | null } | null): string {
  return fileSession?.partition ?? SHARED_BROWSER_PARTITION;
}

/**
 * Lets a tab open sign-in popups. React drops a boolean `true` on webview's
 * `allowpopups`, which leaves Electron blocking every window.open, so the
 * attribute goes out as the string Electron checks for.
 */
export const WEBVIEW_ALLOW_POPUPS = {
  // SAFETY: Electron reads only the attribute's presence; React's typings say boolean but only a string reaches the DOM.
  allowpopups: 'true' as never,
};
