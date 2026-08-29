/**
 * One ordered classifier and one router for terminal HTTP(S) link activation.
 *
 * Every terminal URL source (xterm auto-detected links, OSC-8 hyperlinks, git
 * SHA/issue links) funnels a single activation through `routeUrlActivation`,
 * which invokes exactly one destination:
 *
 *   1. Primary+Shift  -> Pane's Browser panel when the session can host one,
 *                        otherwise the external browser exactly once.
 *   2. Primary        -> external browser.
 *   3. macOS Control  -> external browser only when Chromium delivered it as an
 *                        unconsumed primary-button click (native context-click
 *                        takes precedence and never reaches here).
 *   4. No gesture     -> the provider's plain-click policy (OSC-8 opens
 *                        externally; auto-detected and git links do nothing).
 *
 * Alt is never part of a qualifying gesture (Alt+click moves the cursor), and
 * only primary-button activations qualify.
 */

/** `rejected` = Alt or a non-primary button: never an activation, not even a plain click. */
export type LinkGesture = 'pane-browser' | 'external' | 'none' | 'rejected';
export type LinkDestination = 'pane-browser' | 'external' | 'none';
export type LinkProvider = 'osc8' | 'web-links' | 'git';

export interface LinkActivationEventLike {
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey?: boolean;
  /** MouseEvent.button; undefined is treated as the primary button. */
  button?: number;
}

export interface LinkRouterDeps {
  isMac: boolean;
  /** The current session can visibly host and activate a Browser panel. */
  browserAvailable: boolean;
  openExternal: (url: string) => Promise<void>;
  openInPaneBrowser: (url: string) => Promise<void>;
}

/** Providers whose plain (unmodified) click opens externally today. */
const PLAIN_CLICK_OPENS_EXTERNALLY = {
  'osc8': true,
  'web-links': false,
  'git': false,
} satisfies Record<LinkProvider, boolean>;

export function classifyLinkGesture(event: LinkActivationEventLike, isMac: boolean): LinkGesture {
  if (event.altKey || (event.button ?? 0) !== 0) return 'rejected';
  const primary = isMac ? event.metaKey : event.ctrlKey;
  if (primary && event.shiftKey) return 'pane-browser';
  if (primary) return 'external';
  // macOS Control-click alias: only when it arrives as a primary-button activation.
  if (isMac && event.ctrlKey && !event.shiftKey) return 'external';
  return 'none';
}

/**
 * Returns the canonical href when the input is an absolute, credential-free
 * HTTP(S) URL that the in-Pane Browser may load; null otherwise. Terminal
 * output is untrusted, so `file:`, `javascript:`, `data:`, `blob:`, and custom
 * schemes never reach the Browser panel through this gesture.
 */
export function validateBrowserUrl(raw: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  if (parsed.username || parsed.password) return null;
  if (!parsed.hostname) return null;
  return parsed.href;
}

export async function routeUrlActivation(
  url: string,
  event: LinkActivationEventLike,
  provider: LinkProvider,
  deps: LinkRouterDeps,
): Promise<LinkDestination> {
  const gesture = classifyLinkGesture(event, deps.isMac);
  if (gesture === 'rejected') return 'none';

  if (gesture === 'none') {
    // No qualifying gesture: the provider's plain-click policy. OSC-8 keeps
    // its pre-existing behavior of opening the hyperlink target as-is.
    if (!PLAIN_CLICK_OPENS_EXTERNALLY[provider]) return 'none';
    await deps.openExternal(url);
    return 'external';
  }

  // Every gesture-driven sink — internal or external — takes only a
  // validated, credential-free HTTP(S) URL; anything else opens nothing.
  const validated = validateBrowserUrl(url);
  if (!validated) {
    console.warn('[linkRouting] Rejected URL for modified-click routing:', url);
    return 'none';
  }

  if (gesture === 'pane-browser' && deps.browserAvailable) {
    // A failure after this point may have partially mutated panel state;
    // report it rather than also opening externally.
    try {
      await deps.openInPaneBrowser(validated);
    } catch (error) {
      console.error('[linkRouting] Failed to open link in Pane Browser:', error);
    }
    return 'pane-browser';
  }

  // Primary, the macOS Control alias, or Primary+Shift on a known-unavailable
  // surface: external, exactly once.
  await deps.openExternal(validated);
  return 'external';
}

/** Hover text advertising the gestures available for a URL link from the given provider. */
export function describeUrlGestures(isMac: boolean, browserAvailable: boolean, provider: LinkProvider): string {
  const primary = isMac ? '⌘+Click' : 'Ctrl+Click';
  const inPane = isMac ? '⇧⌘+Click' : 'Ctrl+Shift+Click';
  const externalLabel = PLAIN_CLICK_OPENS_EXTERNALLY[provider] ? 'Click' : primary;
  return browserAvailable
    ? `${externalLabel}: external · ${inPane}: Pane Browser`
    : `${externalLabel}: external (Pane Browser unavailable here)`;
}
