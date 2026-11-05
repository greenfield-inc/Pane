import { beforeAll, describe, expect, it, vi } from 'vitest';

// Android draws a question's alert from a data-only push in the background task; capture both ends.
const native = vi.hoisted(() => ({
  task: undefined as undefined | ((body: { data: unknown }) => Promise<void>),
  schedule: vi.fn((_request: { content: { categoryIdentifier?: string } }) => Promise.resolve('alert-id')),
}));

vi.mock('react-native', () => ({ Platform: { OS: 'android' }, AppState: { currentState: 'background' } }));
vi.mock('expo-task-manager', () => ({
  defineTask: (_name: string, task: typeof native.task) => { native.task = task; },
}));
vi.mock('expo-notifications', () => ({
  AndroidImportance: { HIGH: 4 },
  DEFAULT_ACTION_IDENTIFIER: 'expo.modules.notifications.actions.DEFAULT',
  setNotificationCategoryAsync: () => Promise.resolve(null),
  setNotificationChannelAsync: () => Promise.resolve(null),
  deleteNotificationCategoryAsync: () => Promise.resolve(true),
  registerTaskAsync: () => Promise.resolve(),
  addNotificationResponseReceivedListener: () => ({ remove: () => undefined }),
  addNotificationReceivedListener: () => ({ remove: () => undefined }),
  getLastNotificationResponse: () => null,
  dismissNotificationAsync: () => Promise.resolve(),
  scheduleNotificationAsync: native.schedule,
}));
vi.mock('@/auth/hosts', () => ({ loadHosts: () => Promise.resolve({ profiles: [] }) }));
vi.mock('@/auth/secureStore', () => ({ secureStore: {} }));
vi.mock('@/daemon/createClient', () => ({ CLIENT_LABEL: 'Pane', DEVICE_LABEL: 'Phone', getRuntimeId: () => Promise.resolve('runtime'), streamingFetch: fetch }));
vi.mock('@/features/notifications/device', () => ({ clearPaneNotifications: () => Promise.resolve(), dismissNotifyAlerts: () => Promise.resolve() }));

beforeAll(async () => {
  await import('./notifyBackground');
});

async function alertFor(notifyUi: string) {
  native.schedule.mockClear();
  await native.task?.({ data: { data: { hostProfileId: 'host-1', notifyId: `q-${notifyUi}`, notifyUi, notifyTitle: 'Claude asks', notifyBody: 'auth-refactor' } } });
  expect(native.schedule).toHaveBeenCalledTimes(1);
  return native.schedule.mock.calls[0][0].content;
}

describe('Android question alerts', () => {
  it('give an approval its Approve and Deny buttons, and a question its Reply field', async () => {
    expect((await alertFor('approve')).categoryIdentifier).toBe('pane.notify.approve');
    expect((await alertFor('ask')).categoryIdentifier).toBe('pane.notify.ask');
  });

  it('give a secret request no buttons, so its value is never typed into a notification reply', async () => {
    const content = await alertFor('secret');
    expect(content.categoryIdentifier).toBeUndefined();
  });
});
