/**
 * True while Dictate's watcher is attached and shows Pane's alerts on its pill, so Pane
 * skips its own desktop notification. Anything uncertain keeps Pane's notification.
 */
export async function isDesktopAlertHandedOff(
  isHandedOff: (() => Promise<boolean>) | undefined,
): Promise<boolean> {
  if (!isHandedOff) return false;
  try {
    return await isHandedOff();
  } catch {
    return false;
  }
}
