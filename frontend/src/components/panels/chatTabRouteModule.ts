import type { ChatTabRoute } from '../chatTab/ChatTabRoute';

let loaded: typeof ChatTabRoute | null = null;
let loading: Promise<typeof ChatTabRoute> | null = null;

/**
 * Loads the chat tab's code. A launch that reopens a chat starts this as soon as
 * it knows (restoreLaunchChat), so the tab renders without suspending: a Suspense
 * fallback holds the content back for React's 300 ms reveal throttle.
 */
export function loadChatTabRoute(): Promise<typeof ChatTabRoute> {
  const attempt = loading ?? import('../chatTab/ChatTabRoute').then(module => (loaded = module.ChatTabRoute));
  // A failed load is tried again next time, not remembered.
  loading = attempt;
  attempt.catch(() => { if (loading === attempt) loading = null; });
  return attempt;
}

/** The chat tab's component once its code has loaded, or null before. */
export function loadedChatTabRoute(): typeof ChatTabRoute | null {
  return loaded;
}
