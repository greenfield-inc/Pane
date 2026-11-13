import { afterEach, expect, it, vi } from 'vitest';

import type { RemoteDaemonClient } from '@shared/remoteClient';
import type { ChatTabView } from '@shared/types/chatTab';

vi.mock('@/daemon/invoke', () => ({ invokeChannel: () => { throw new Error('not used in this test'); } }));
const { chatTabClient } = await import('./chatTabClient');

const view: ChatTabView = {
  panelId: 'panel', agent: 'opencode', generation: 1, status: 'idle', canAttachImages: false, controls: [], commands: [], permissions: [], questions: [], queue: [], messageCount: 0,
  transcript: { panelId: 'panel', generation: 1, revision: 0, start: 0, messages: [] },
};

afterEach(() => { vi.restoreAllMocks(); });

it('applies chat views from both channels and drops one it cannot decode without breaking the stream', () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  let emit: (event: unknown) => void = () => undefined;
  // SAFETY: chatTabClient's onState only calls onEvent; the other members are never read here.
  const client = { onEvent: (listener: (event: unknown) => void) => { emit = listener; return () => undefined; } } as unknown as RemoteDaemonClient;
  const received: ChatTabView[] = [];
  chatTabClient(client).onState(next => received.push(next));

  const event = (channel: string, payload: unknown) => ({ type: 'daemon-event', payload: { channel, args: [payload], timestamp: '2026-11-12T00:00:00.000Z' } });
  expect(() => emit(event('chat-tab:view', { panelId: 'panel', agent: 'opencode' }))).not.toThrow();
  emit(event('chat-tab:state', view));
  emit(event('chat-tab:view', view));

  // A host from before chat-tab:view sends only chat-tab:state; a newer one sends both for older agents.
  expect(received).toEqual([view, view]);
  expect(warn).toHaveBeenCalledTimes(1);
});
