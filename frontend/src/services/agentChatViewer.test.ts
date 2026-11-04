import { expect, it, vi } from 'vitest';
import { AgentChatViewer } from './agentChatViewer';
import type { AgentChatClient, AgentChatEvent, AgentChatView } from '../../../shared/types/agentChat';

it('repairs a viewer event gap and detaches without cancelling or stopping the host runtime', async () => {
  let event: ((event: AgentChatEvent) => void) | undefined;
  let host: AgentChatView = { panelId: 'a', available: true, setupRequired: false, running: true, permissions: [], transcript: { panelId: 'a', generation: 1, revision: 0, messages: [] } };
  const stopped = vi.fn();
  const client: AgentChatClient = {
    get: async () => structuredClone(host), setup: async () => ({ installed: true }),
    switch: async () => { throw Error('unused'); }, recover: async () => { throw Error('unused'); },
    send: async () => { throw Error('unused'); }, receipt: async () => undefined,
    cancel: stopped, permission: async () => undefined, stop: stopped,
    onEvent: callback => { event = callback; return () => { event = undefined; }; }, onState: () => () => undefined,
  };
  const viewer = new AgentChatViewer(client, 'a');
  const detach = viewer.subscribe(() => undefined);
  await viewer.refresh();
  viewer.setDraft('Keep this draft');
  host = { ...host, transcript: { panelId: 'a', generation: 1, revision: 2, messages: [{ id: 'm', role: 'assistant', parts: [{ type: 'text', text: 'Repaired answer' }] }] } };
  event?.({ panelId: 'a', generation: 1, revision: 2, change: { type: 'append', id: 'm', role: 'assistant', part: { type: 'text', text: 'answer' } } });
  await viewer.refresh();
  expect(viewer.snapshot().view?.transcript?.messages[0].parts).toEqual([{ type: 'text', text: 'Repaired answer' }]);
  detach();
  expect(stopped).not.toHaveBeenCalled();
  expect(viewer.snapshot().draft).toBe('Keep this draft');
  expect(event).toBeUndefined();
  const detachAgain = viewer.subscribe(() => undefined);
  const pendingRead = viewer.refresh();
  detachAgain();
  await pendingRead;
  expect(viewer.snapshot().view?.transcript).toBeUndefined();
});

it('preserves newer host state when a delayed refresh completes', async () => {
  const host: AgentChatView = { panelId: 'a', available: true, setupRequired: false, running: false, permissions: [], conversation: { panelId: 'a', workspaceId: 'p', provider: 'claude', nativeSessionId: 'exact', generation: 1, active: 'chat', preferred: 'chat' }, transcript: { panelId: 'a', generation: 1, revision: 0, messages: [] } };
  let receive: ((view: AgentChatView) => void) | undefined;
  const get = vi.fn(async () => structuredClone(host));
  const unused = async (): Promise<never> => { throw Error('unused'); };
  const client: AgentChatClient = { get, setup: unused, switch: unused, recover: unused, send: unused, receipt: unused, cancel: unused, permission: unused, stop: unused, onEvent: () => () => undefined, onState: callback => { receive = callback; return () => undefined; } };
  const viewer = new AgentChatViewer(client, 'a');
  const detach = viewer.subscribe(() => undefined);
  await viewer.refresh();
  let resolve: ((view: AgentChatView) => void) | undefined;
  get.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
  const refresh = viewer.refresh();
  receive?.({ ...host, running: true, transcript: undefined });
  resolve?.(structuredClone(host));
  await refresh;
  expect(viewer.snapshot().view?.running).toBe(true);
  detach();
});
