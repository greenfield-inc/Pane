/** How many terminals keep their last screen for a revisit. */
const KEPT_SCREENS = 20;

/**
 * Each terminal's last visible rows this run, by computer and panel, the most recently seen last.
 * Memory only: they go when the app quits, or with their computer when it is removed or signed out.
 */
const screens = new Map<string, string>();

const key = (profileId: string, panelId: string) => `${profileId}:${panelId}`;

/** The rows a terminal showed when it was last seen at its bottom, or null. */
export function keptScreen(profileId: string, panelId: string): string | null {
  return screens.get(key(profileId, panelId)) ?? null;
}

/** Keeps a terminal's visible rows; `null` drops them (a screen scrolled back would paint the wrong place). */
export function keepScreen(profileId: string, panelId: string, text: string | null): void {
  const id = key(profileId, panelId);
  screens.delete(id);
  if (text === null) return;
  screens.set(id, text);
  for (const oldest of screens.keys()) {
    if (screens.size <= KEPT_SCREENS) break;
    screens.delete(oldest);
  }
}

/** Drops every kept screen of a computer that was removed or signed out. */
export function forgetKeptScreens(profileId: string): void {
  for (const id of screens.keys()) if (id.startsWith(`${profileId}:`)) screens.delete(id);
}
