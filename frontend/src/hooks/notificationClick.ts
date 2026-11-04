export interface ClickableNotification {
  onclick: ((event: Event) => void) | null;
  close: () => void;
}

/**
 * Clicking the desktop notification opens its tab through the same path as a
 * pane:// link from the OS, which raises the window and selects the panel.
 */
export function openPanelOnClick(
  notification: ClickableNotification,
  target: { paneId: string; panelId: string },
  openPaneLink: (link: string) => Promise<void>,
): void {
  const link = `pane://open?${new URLSearchParams({ pane: target.paneId, panel: target.panelId })}`;
  notification.onclick = (event) => {
    // Chromium's default only focuses the page; the main process raises the window itself.
    event.preventDefault();
    notification.close();
    openPaneLink(link).catch((error: Error) => {
      console.warn(`[Notifications] Could not open ${link}:`, error);
    });
  };
}
