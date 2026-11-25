const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
/** A start link's query is URL-encoded, so it ends at the first space, quote or bracket. */
const START_LINK = 'pane://new\\?[^\\s"\'<>()\\[\\]]+';
export const PANE_LINK_REGEX = new RegExp(`pane://open\\?pane=${UUID}(?:&panel=${UUID})?|${START_LINK}`, 'i');

/** `pane://new?…` asks to start an agent; only main may act on it, after the person confirms. */
export function isPaneStartLink(uri: string): boolean {
  return /^pane:\/\/new\?/i.test(uri);
}

export function parsePaneLink(uri: string): { paneId: string; panelId?: string } | null {
  if (!PANE_LINK_REGEX.test(uri) || isPaneStartLink(uri)) return null;
  try {
    const url = new URL(uri);
    if (url.protocol !== 'pane:' || url.hostname !== 'open' || url.pathname) return null;
    const paneId = url.searchParams.get('pane');
    const panelId = url.searchParams.get('panel');
    if (!paneId || !new RegExp(`^${UUID}$`, 'i').test(paneId)) return null;
    if (panelId && !new RegExp(`^${UUID}$`, 'i').test(panelId)) return null;
    return { paneId, panelId: panelId ?? undefined };
  } catch {
    return null;
  }
}

