import * as Notifications from 'expo-notifications';
import * as TaskManager from 'expo-task-manager';
import { AppState, Platform } from 'react-native';

import { loadHosts } from '@/auth/hosts';
import { secureStore } from '@/auth/secureStore';
import { CLIENT_LABEL, DEVICE_LABEL, getRuntimeId, streamingFetch } from '@/daemon/createClient';
import { parseNotifyPush, type NotifyPush } from '@/features/links/links';
import { clearPaneNotifications, dismissNotifyAlerts } from '@/features/notifications/device';

import { commandForAction, IOS_BUTTONS_OPEN_APP, NOTIFY_CATEGORY, notifyCategories, optionsCategory, sendNotifyCommand, type NotifySendResult } from './notifyActions';

/**
 * Notify's alert buttons, loaded from the app entry (index.ts) before the router so a background
 * launch runs it too. A button press reaches this code through the response listener (iPhone, and
 * Android while Pane is open) or the background task (Android otherwise). The task also takes
 * Android's data-only question messages, which it draws as alerts, and both platforms' silent clears.
 */

const TASK = 'pane-notify-background';
const ANDROID_CHANNEL = 'pane-notify';
const opensApp = Platform.OS === 'ios' && IOS_BUTTONS_OPEN_APP;
// Presses already handled; declared before the launch response below is answered.
const answered = new Set<string>();

const setup = (async () => {
  // One at a time: each call rewrites the whole category set, so parallel calls drop each other's.
  for (const category of notifyCategories(opensApp)) await Notifications.setNotificationCategoryAsync(category.identifier, category.actions);
  if (Platform.OS === 'android') {
    await Notifications.setNotificationChannelAsync(ANDROID_CHANNEL, { name: 'Questions from agents', importance: Notifications.AndroidImportance.HIGH, sound: 'default' });
  }
})().catch(() => undefined);

TaskManager.defineTask<Notifications.NotificationTaskPayload>(TASK, async ({ data }) => {
  if ('actionIdentifier' in data) await answerFromAlert(data);
  else await receive(data);
});
void Notifications.registerTaskAsync(TASK).catch(() => undefined);

Notifications.addNotificationResponseReceivedListener(response => {
  // Android runs the task instead while Pane is in the background; answering twice would report "Already answered".
  if (Platform.OS === 'android' && AppState.currentState !== 'active') return;
  void answerFromAlert(response);
});
// iPhone: a button that launched Pane in the background arrives before any listener exists.
const launchResponse = Notifications.getLastNotificationResponse();
if (launchResponse) void answerFromAlert(launchResponse);

// iPhone while Pane is open: the alert itself arrives here, not in the task.
Notifications.addNotificationReceivedListener(notification => {
  if (Platform.OS === 'ios') void receive(notification.request);
});

async function answerFromAlert(response: Notifications.NotificationResponse): Promise<void> {
  if (response.actionIdentifier === Notifications.DEFAULT_ACTION_IDENTIFIER) return;
  const request = response.notification.request;
  const key = `${request.identifier}:${response.actionIdentifier}`;
  if (answered.has(key)) return;
  answered.add(key);
  const push = parseNotifyPush(request);
  const command = push && commandForAction(push, response.actionIdentifier, response.userText);
  if (!push || !command) return;
  const profile = (await loadHosts(secureStore).catch(() => null))?.profiles.find(candidate => candidate.id === push.host);
  const result: NotifySendResult = profile
    ? await sendNotifyCommand({ fetch: streamingFetch, runtimeId: await getRuntimeId(), clientLabel: CLIENT_LABEL, deviceLabel: DEVICE_LABEL }, profile, command)
    : { sent: false, retry: false, message: 'Not sent: this phone is no longer paired with that host. Pair with it again in Pane.' };
  // A question that may still be waiting keeps its alert, so it can be answered again.
  if (result.sent || !result.retry) await Notifications.dismissNotificationAsync(request.identifier).catch(() => undefined);
  if (!result.sent) await postNotice(push, request.content.title, result);
}

/** A short local alert, only when a button's answer didn't reach the agent. */
async function postNotice(push: NotifyPush, title: string | null, result: Extract<NotifySendResult, { sent: false }>): Promise<void> {
  // Tapping it opens the question while it can still be answered, otherwise the Pane.
  const data: Record<string, string> = { hostProfileId: push.host };
  if (result.retry) data.notifyId = push.notifyId;
  if (push.paneId) data.paneId = push.paneId;
  await Notifications.scheduleNotificationAsync({
    content: { title: title || 'Pane', body: result.message, data, sound: 'default' },
    trigger: Platform.OS === 'android' ? { channelId: ANDROID_CHANNEL } : null,
  }).catch(() => undefined);
}

async function receive(payload: unknown): Promise<void> {
  const push = parseNotifyPush(payload);
  if (!push) return;
  if (push.clear) {
    await dismissNotifyAlerts(alert => alert.host === push.host && alert.notifyId === push.notifyId);
    if (Platform.OS === 'android') await Notifications.deleteNotificationCategoryAsync(`${NOTIFY_CATEGORY.options}.${push.notifyId}`).catch(() => false);
    return;
  }
  // One alert per question replaces the Pane's "is blocked" alert, which the host can't remove.
  if (push.paneId) await clearPaneNotifications(push.paneId);
  if (Platform.OS === 'android' && push.title) await showAndroidAlert(push);
}

/** Android: draw the question's alert, with its buttons, from the data-only message. */
async function showAndroidAlert(push: NotifyPush): Promise<void> {
  await setup;
  let categoryIdentifier: string | undefined;
  if (push.ui === 'approve') categoryIdentifier = NOTIFY_CATEGORY.approve;
  if (push.ui === 'ask') categoryIdentifier = NOTIFY_CATEGORY.ask;
  if (push.ui === 'options' && push.choices.length > 0) {
    const category = optionsCategory(push.notifyId, push.choices, false);
    await Notifications.setNotificationCategoryAsync(category.identifier, category.actions);
    categoryIdentifier = category.identifier;
  }
  // The routing keys again, so a tap or a button finds the question.
  const data: Record<string, string | string[]> = { hostProfileId: push.host, notifyId: push.notifyId, notifyChoices: push.choices };
  if (push.ui) data.notifyUi = push.ui;
  if (push.paneId) data.paneId = push.paneId;
  if (push.sessionPaneId) data.sessionPaneId = push.sessionPaneId;
  if (push.panelId) data.panelId = push.panelId;
  await Notifications.scheduleNotificationAsync({
    // The host's tag, so a later alert for the same question replaces this one.
    identifier: push.tag ?? push.notifyId,
    content: { title: push.title, body: push.body, data, categoryIdentifier, sound: 'default' },
    trigger: { channelId: ANDROID_CHANNEL },
  });
}
