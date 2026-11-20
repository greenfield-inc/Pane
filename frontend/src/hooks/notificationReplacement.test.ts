import { describe, expect, it, vi, type Mock } from 'vitest';
import { NotificationsByTag, paneNotificationTag, type ReplaceableNotification } from './notificationReplacement';

interface FakeNotification extends ReplaceableNotification {
  close: Mock<() => void>;
}

function fakeNotification(): FakeNotification {
  return { close: vi.fn<() => void>(), onclose: null };
}

describe('NotificationsByTag', () => {
  it('closes the earlier notification of the same Pane when a new one is shown', () => {
    const notifications = new NotificationsByTag();
    const first = fakeNotification();
    const second = fakeNotification();

    notifications.replace(paneNotificationTag('pane-1'), first);
    notifications.replace(paneNotificationTag('pane-1'), second);

    expect(first.close).toHaveBeenCalledTimes(1);
    expect(second.close).not.toHaveBeenCalled();
    expect(notifications.size()).toBe(1);
  });

  it('leaves the notifications of other Panes alone', () => {
    const notifications = new NotificationsByTag();
    const first = fakeNotification();

    notifications.replace(paneNotificationTag('pane-1'), first);
    notifications.replace(paneNotificationTag('pane-2'), fakeNotification());

    expect(first.close).not.toHaveBeenCalled();
    expect(notifications.size()).toBe(2);
  });

  it('forgets a notification once it closes', () => {
    const notifications = new NotificationsByTag();
    const first = fakeNotification();

    notifications.replace(paneNotificationTag('pane-1'), first);
    first.onclose?.(new Event('close'));

    expect(notifications.size()).toBe(0);
  });

  it('keeps the newer notification when the replaced one reports its close late', () => {
    const notifications = new NotificationsByTag();
    const first = fakeNotification();
    const second = fakeNotification();

    notifications.replace(paneNotificationTag('pane-1'), first);
    notifications.replace(paneNotificationTag('pane-1'), second);
    first.onclose?.(new Event('close'));

    expect(notifications.size()).toBe(1);
    notifications.replace(paneNotificationTag('pane-1'), fakeNotification());
    expect(second.close).toHaveBeenCalledTimes(1);
  });

  it('tracks nothing for an untagged notification', () => {
    const notifications = new NotificationsByTag();
    notifications.replace(undefined, fakeNotification());
    expect(notifications.size()).toBe(0);
  });
});
