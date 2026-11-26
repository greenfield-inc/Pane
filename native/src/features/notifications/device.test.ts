import { beforeAll, describe, expect, it, vi } from 'vitest';

type Handler = { handleNotification: (notification: unknown) => Promise<Record<string, boolean>> };
const native = vi.hoisted(() => ({ handler: null as Handler | null }));

vi.mock('expo-notifications', () => ({ setNotificationHandler: (handler: Handler) => { native.handler = handler; } }));
vi.mock('react-native', () => ({ Platform: { OS: 'ios' } }));
vi.mock('@/auth/secureStore', () => ({ secureStore: {} }));
vi.mock('@/features/links/links', () => ({}));

beforeAll(async () => {
  await import('./device');
});

const arrive = (content: Record<string, unknown>) => native.handler?.handleNotification({ request: { content: { title: null, body: null, data: {}, ...content } } });

describe('alerts while Pane is open', () => {
  it('lists a host alert without a banner or sound', async () => {
    expect(await arrive({ title: 'App and fixes', body: 'is blocked' })).toMatchObject({ shouldShowBanner: false, shouldShowList: true, shouldPlaySound: false });
  });

  it('still slides in the notice that a button answer did not send', async () => {
    expect(await arrive({ title: 'Claude', body: 'Not sent: can’t reach studio.', data: { paneNotice: '1' } })).toMatchObject({ shouldShowBanner: true, shouldShowList: true, shouldPlaySound: true });
  });

  it('shows nothing for a data-only message', async () => {
    expect(await arrive({})).toMatchObject({ shouldShowBanner: false, shouldShowList: false });
  });
});
