import type { LocalTarget } from '../../../../../shared/utils/browserUrl';
import { normalizeUrl } from './browserUrl';

/** Asks one browser tab to show a URL and take focus. Other tabs ignore it. */
export const BROWSER_NAVIGATE_EVENT = 'browser-panel:navigate';

export interface BrowserNavigateRequest {
  url: string;
  sessionId: string;
  panelId: string;
}

export function requestBrowserNavigation(request: BrowserNavigateRequest): void {
  window.dispatchEvent(new CustomEvent<BrowserNavigateRequest>(BROWSER_NAVIGATE_EVENT, { detail: request }));
}

/**
 * What a tab does with a navigate request: only the named tab acts, and it reloads
 * only when it is already showing that page. A tab whose page came from a link is
 * not showing its original URL, so it loads the requested one instead.
 */
export function navigateRequestAction(
  request: BrowserNavigateRequest,
  tab: { panelId: string; sessionId: string; shownUrl: string | undefined },
): 'ignore' | 'reload' | 'navigate' {
  if (request.panelId !== tab.panelId || request.sessionId !== tab.sessionId) return 'ignore';
  return tab.shownUrl !== undefined && normalizeUrl(request.url) === tab.shownUrl ? 'reload' : 'navigate';
}

/**
 * Whether a changed saved URL is a new request for this tab. The tab saves the
 * pages it reaches; those saves come back as panel updates and must not send the
 * person back to a page they have since left. Consumes the echo it matches.
 */
export function isSavedUrlRequest(
  savedUrl: string | undefined,
  tab: { shownUrl: string | undefined; pendingEchoes: Set<string> },
): savedUrl is string {
  if (!savedUrl) return false;
  if (tab.pendingEchoes.delete(savedUrl)) return false;
  return savedUrl !== tab.shownUrl;
}

/**
 * The webview's src for `url`. It is fixed once the tab starts loading `url`, so a
 * later ports or remote-mode update that remaps the address doesn't navigate.
 */
export function webviewSrcFor(url: string, target: LocalTarget, previous: { url: string; src: string } | null): { url: string; src: string } | null {
  if (target.kind !== 'load') return null;
  return previous?.url === url ? previous : { url, src: target.url };
}

/**
 * The worktree-relative path of the file a tab shows, or null when the page is not a
 * file inside the worktree (a web page, or a file elsewhere on disk).
 */
export function worktreeFileOf(pageUrl: string | undefined, worktreePath: string | undefined): string | null {
  if (!pageUrl || !worktreePath) return null;
  let filePath: string;
  try {
    const parsed = new URL(pageUrl);
    if (parsed.protocol !== 'file:') return null;
    // A UNC path (\\wsl.localhost\Ubuntu\repo) becomes file://wsl.localhost/Ubuntu/repo:
    // its host is part of the path.
    const host = parsed.hostname ? `//${parsed.hostname}` : '';
    filePath = host + decodeURIComponent(parsed.pathname);
  } catch {
    return null;
  }
  // file:///C:/repo/a.html has the pathname /C:/repo/a.html.
  if (/^\/[A-Za-z]:\//.test(filePath)) filePath = filePath.slice(1);
  const root = worktreePath.replace(/\\/g, '/').replace(/\/+$/, '');
  // Windows paths, drive or UNC, ignore case; the URL also lowercases a UNC host.
  const caseInsensitive = /^([A-Za-z]:|\/\/[^/])/.test(root);
  const inside = caseInsensitive ? filePath.toLowerCase().startsWith(`${root.toLowerCase()}/`) : filePath.startsWith(`${root}/`);
  return inside ? filePath.slice(root.length + 1) : null;
}
