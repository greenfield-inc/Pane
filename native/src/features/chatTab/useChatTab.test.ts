import { expect, it, vi } from 'vitest';

import type { RemoteDaemonClient } from '@shared/remoteClient';
import type { ChatTabClient, ChatTabView } from '@shared/types/chatTab';

vi.mock('react-native', () => ({ AppState: { addEventListener: () => ({ remove: () => undefined }) } }));
vi.mock('@/daemon', () => ({ useDaemon: () => { throw new Error('not rendered in this test'); } }));
const chats = vi.hoisted(() => new WeakMap<object, unknown>());
vi.mock('./chatTabClient', () => ({ chatTabClient: (client: object) => chats.get(client) }));

const { chatTabViewerFor } = await import('./useChatTab');

/** A daemon connection to one host, as DaemonProvider makes a new one per profile switch or credential change. */
function connection(lastMessage: string) {
  const view: ChatTabView = {
    panelId: 'panel', agent: 'claude', generation: 1, status: 'idle', canAttachImages: false, controls: [], commands: [], permissions: [], questions: [], queue: [], messageCount: 1,
    transcript: { panelId: 'panel', generation: 1, revision: 0, start: 0, messages: [{ id: lastMessage, role: 'assistant', parts: [{ type: 'text', text: lastMessage }] }] },
  };
  const get = vi.fn(async () => structuredClone(view));
  const unused = async (): Promise<never> => { throw new Error('Not used by the viewer'); };
  const chat: ChatTabClient = {
    get, history: async () => [], onEvent: () => () => undefined, onState: () => () => undefined,
    send: unused, receipt: unused, unqueue: unused, configure: unused, cancel: unused, permission: unused, answer: unused, restart: unused, signIn: unused,
    conversations: unused, resume: unused, dismissBanner: unused,
  };
  // SAFETY: the mocked chatTabClient above only uses this object as a WeakMap key; nothing reads its members.
  const client = {} as RemoteDaemonClient;
  chats.set(client, chat);
  return { client, chat, get };
}

const settle = () => new Promise(resolve => setTimeout(resolve, 0));

it('keeps the draft and unconfirmed send when the phone returns to a host on a new connection', async () => {
  const first = connection('a1');
  const { viewer } = chatTabViewerFor('host-A', 'panel', first.client);
  const detach = viewer.subscribe(() => undefined);
  await settle();
  viewer.setDraft('half typed');
  const pending = { operationId: 'op-1', text: 'accepted, response lost' };
  viewer.setPendingDelivery(pending);
  detach();

  const elsewhere = chatTabViewerFor('host-B', 'panel', connection('b1').client);
  expect(elsewhere.viewer.snapshot().draft).toBe('');

  const back = connection('a2');
  const returned = chatTabViewerFor('host-A', 'panel', back.client);
  expect(returned.viewer).toBe(viewer);
  expect(returned.chat).toBe(back.chat);
  expect(returned.viewer.snapshot().draft).toBe('half typed');
  expect(returned.viewer.snapshot().pendingDelivery).toEqual(pending);
  returned.viewer.subscribe(() => undefined);
  await settle();
  expect(back.get).toHaveBeenCalledTimes(1);
  expect(returned.viewer.snapshot().transcript?.messages[0].id).toBe('a2');
});
