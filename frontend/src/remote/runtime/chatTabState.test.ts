import { afterEach, expect, it, vi } from 'vitest';
import type { ChatTabView } from '../../../../shared/types/chatTab';
import type { RemotePaneConnectionProfile } from '../../../../shared/types/remoteDaemon';
import { RemoteRuntimeAdapter, type RemoteRuntimeEventListener } from './remoteRuntimeAdapter';

const profile: RemotePaneConnectionProfile = {
  id: 'My Mac:https://host.test:12345678', label: 'My Mac', baseUrl: 'https://host.test', token: 'token', transport: 'http+sse',
};

const view: ChatTabView = {
  panelId: 'panel', agent: 'opencode', generation: 1, status: 'idle', canAttachImages: false, controls: [], commands: [], permissions: [], questions: [], queue: [], messageCount: 0,
  transcript: { panelId: 'panel', generation: 1, revision: 0, start: 0, messages: [] },
};

afterEach(() => { vi.restoreAllMocks(); });

it('applies chat views from chat-tab:view and drops one it cannot decode without breaking the stream', () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  const adapter = new RemoteRuntimeAdapter(profile);
  let emit: RemoteRuntimeEventListener = () => undefined;
  vi.spyOn(adapter, 'onEvent').mockImplementation(listener => { emit = listener; return () => undefined; });
  const received: ChatTabView[] = [];
  adapter.chatTab.onState(next => received.push(next));

  const timestamp = '2026-11-12T00:00:00.000Z';
  emit({ channel: 'chat-tab:view', args: [{ panelId: 'panel', agent: 'opencode' }], timestamp });
  emit({ channel: 'chat-tab:state', args: [view], timestamp });
  emit({ channel: 'chat-tab:view', args: [view], timestamp });

  expect(received).toEqual([view]);
  expect(warn).toHaveBeenCalledTimes(1);
});
