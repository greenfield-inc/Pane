import * as Notifications from 'expo-notifications';
import { router } from 'expo-router';
import { useEffect } from 'react';

import { openHref, parsePushTarget } from '@/features/links/links';

import { usePushSetup } from './usePushSetup';

let handledResponseId: string | null = null;

/**
 * Opens the pane a tapped notification is about, including the tap that
 * launched the app. Render it once, after saved hosts have loaded.
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

/** Registers this phone for the active host's alerts. Render it inside `DaemonProvider`. */
export function PushRegistration() {
  usePushSetup();
  return null;
}
