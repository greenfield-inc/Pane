export type LinkAction = 'pane' | 'browser' | 'copy';

/** The desktop link popover's labels, in its order. */
export const LINK_ACTION_LABELS: Readonly<Record<LinkAction, string>> = {
  pane: 'Open in Pane',
  browser: 'Open in browser',
  copy: 'Copy link',
};

/**
 * What a long press on a link offers. Open in Pane needs the Pane the link sits in and a URL
 * Pane's browser tab opens (http, https or file); Open in browser needs an absolute URL.
 */
export function linkActions(url: string, paneId: string | undefined): LinkAction[] {
  const inPane = paneId !== undefined && /^(?:https?|file):/i.test(url);
  const absolute = /^[a-z][a-z0-9+.-]*:/i.test(url);
  return [...(inPane ? ['pane' as const] : []), ...(absolute ? ['browser' as const] : []), 'copy'];
}
