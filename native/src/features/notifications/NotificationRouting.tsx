import * as Notifications from 'expo-notifications';
import { router } from 'expo-router';
import { useEffect } from 'react';

import { openHref, parsePushTarget } from '@/features/links/links';
import { useClearResolvedNotifyAlerts } from '@/features/notify/hooks';

let handledResponseId: string | null = null;

/**
 * Opens the pane a tapped notification is about, or the Notify question's
 * sheet, including the tap that launched the app. Render it once, after saved
 * hosts have loaded. Alert buttons are handled in features/notify/notifyBackground.
 */
export function NotificationTapRouter() {
  const response = Notifications.useLastNotificationResponse();

  useEffect(() => {
    if (!response || response.actionIdentifier !== Notifications.DEFAULT_ACTION_IDENTIFIER) return;
    const id = response.notification.request.identifier;
    if (id === handledResponseId) return;
    handledResponseId = id;
    const target = parsePushTarget(response.notification.request);
    if (target) router.push(openHref(target) as never);
  }, [response]);

  return null;
}

/** Removes the active host's alerts for questions answered elsewhere. Render it inside `DaemonProvider`. */
export function NotifyAlertCleanup() {
  useClearResolvedNotifyAlerts();
  return null;
}
