/** The 96px app icon Vite copies from `frontend/public` next to index.html. */
const NOTIFICATION_ICON_FILE = 'favicon-96x96.png';

/**
 * The desktop notification icon, resolved against the page rather than the
 * server root: the dev server serves the page from http://localhost, while a
 * packaged build loads index.html from file://, where '/favicon.ico' points at
 * the root of the disk.
 */
export function notificationIconUrl(baseUri: string = document.baseURI): string {
  return new URL(NOTIFICATION_ICON_FILE, baseUri).href;
}
