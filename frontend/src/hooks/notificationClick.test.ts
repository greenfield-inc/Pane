import { describe, expect, it, vi } from 'vitest';
import { openPanelOnClick, type ClickableNotification } from './notificationClick';

function fakeNotification(): ClickableNotification {
  return { onclick: null, close: vi.fn() };
}

describe('openPanelOnClick', () => {
  it('opens the pane link for that tab when the notification is clicked', () => {
    const notification = fakeNotification();
    const openPaneLink = vi.fn().mockResolvedValue(undefined);

    openPanelOnClick(notification, { paneId: 'pane-1', panelId: 'panel-2' }, openPaneLink);
    expect(openPaneLink).not.toHaveBeenCalled();

    notification.onclick?.(new Event('click'));

    expect(openPaneLink).toHaveBeenCalledWith('pane://open?pane=pane-1&panel=panel-2');
    expect(notification.close).toHaveBeenCalled();
  });

  it('keeps the click from also focusing the window on its own', () => {
    const notification = fakeNotification();
    openPanelOnClick(notification, { paneId: 'pane-1', panelId: 'panel-2' }, vi.fn().mockResolvedValue(undefined));
    const click = new Event('click', { cancelable: true });

    notification.onclick?.(click);

    expect(click.defaultPrevented).toBe(true);
  });

  it('logs instead of throwing when Pane cannot open the link', async () => {
    const notification = fakeNotification();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const failure = new Error('Panel panel-2 does not belong to Pane pane-1');

    openPanelOnClick(notification, { paneId: 'pane-1', panelId: 'panel-2' }, vi.fn().mockRejectedValue(failure));
    notification.onclick?.(new Event('click'));
    await vi.waitFor(() => expect(warn).toHaveBeenCalledWith(expect.stringContaining('pane://open?pane=pane-1&panel=panel-2'), failure));
    warn.mockRestore();
  });
});
