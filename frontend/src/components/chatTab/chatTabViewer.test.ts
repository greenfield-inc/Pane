import { describe, expect, it, vi } from 'vitest';
import type { AgentChatMessage } from '../../../../shared/types/agentChat';
import type { ChatTabClient, ChatTabEvent, ChatTabView } from '../../../../shared/types/chatTab';
import { ChatTabViewer, ChatTabViewerRegistry } from '../../../../shared/chatTabViewer';

const message = (index: number): AgentChatMessage => ({ id: `m${index}`, role: index % 2 ? 'assistant' : 'user', parts: [{ type: 'text', text: `message ${index}` }] });

/** A host conversation with the real chat-tab:get / chat-tab:history semantics. */
function host(count: number) {
  const state = { generation: 1, revision: 0, messages: Array.from({ length: count }, (_, index) => message(index)) };
  const events = new Set<(event: ChatTabEvent) => void>();
  const view = (limit = 200): ChatTabView => {
    const shown = Math.min(limit, state.messages.length);
    return {
      panelId: 'p', agent: 'claude', generation: state.generation, status: 'idle', canAttachImages: false, controls: [], commands: [], permissions: [], questions: [], queue: [], messageCount: state.messages.length,
      transcript: { panelId: 'p', generation: state.generation, revision: state.revision, start: state.messages.length - shown, messages: structuredClone(state.messages.slice(state.messages.length - shown)) },
    };
  };
  const gets: Array<(limit?: number) => Promise<ChatTabView>> = [];
  const get = vi.fn(async (_panelId: string, limit?: number) => { const next = gets.shift(); return next ? next(limit) : view(limit); });
  const unused = async (): Promise<never> => { throw new Error('Not used by the viewer'); };
  const client: ChatTabClient = {
    get,
    history: async (_panelId, before, limit) => {
      const end = Math.max(0, Math.min(before, state.messages.length));
      return structuredClone(state.messages.slice(Math.max(0, end - limit), end));
    },
    onEvent: callback => { events.add(callback); return () => events.delete(callback); },
    onState: () => () => undefined,
    send: unused, receipt: unused, unqueue: unused, sendNow: unused, editQueued: unused, clear: unused, stopTask: unused, configure: unused, cancel: unused, permission: unused, answer: unused, restart: unused, signIn: unused,
    conversations: unused, resume: unused, dismissBanner: unused,
  };
  /** Appends a message on the host; `deliver: false` loses the event on the way. */
  const append = (deliver = true) => {
    const index = state.messages.length;
    state.messages.push(message(index));
    state.revision++;
    const event: ChatTabEvent = { panelId: 'p', generation: state.generation, revision: state.revision, index, change: { type: 'replace', message: message(index) } };
    if (deliver) events.forEach(callback => callback(event));
    return event;
  };
  const deferGet = () => {
    let release!: () => void;
    // The host takes the snapshot when asked; the reply arrives when released.
    gets.push(limit => { const taken = view(limit); return new Promise(resolve => { release = () => resolve(taken); }); });
    return () => release();
  };
  return { state, client, get, append, deferGet, view };
}

const settle = () => new Promise(resolve => setTimeout(resolve, 0));
const ids = (viewer: ChatTabViewer) => viewer.snapshot().transcript?.messages.map(entry => entry.id) ?? [];

describe('chat tab viewer catch-up (F-4)', () => {
  it('refetches after a gap found while applying events that arrived during the snapshot load', async () => {
    const fake = host(3);
    const release = fake.deferGet();
    const viewer = new ChatTabViewer(fake.client, 'p');
    viewer.subscribe(() => undefined);
    // The snapshot is taken at revision 0; revision 1 is lost and revision 2 arrives while it loads.
    fake.append(false);
    fake.append(true);
    release();
    await settle(); await settle();
    expect(fake.get).toHaveBeenCalledTimes(2);
    expect(viewer.snapshot().transcript?.revision).toBe(2);
    expect(ids(viewer).slice(-2)).toEqual(['m3', 'm4']);
  });
});

describe('chat tab viewer window (F-8)', () => {
  it('keeps a bounded window while paging back through a long chat, and pages forward to follow live again', async () => {
    const fake = host(6000);
    const viewer = new ChatTabViewer(fake.client, 'p');
    viewer.subscribe(() => undefined);
    await settle();
    while ((viewer.snapshot().transcript?.start ?? 0) > 0) {
      await viewer.loadEarlier();
      expect(viewer.snapshot().transcript!.messages.length).toBeLessThanOrEqual(700);
    }
    expect(viewer.snapshot().transcript?.start).toBe(0);
    expect(viewer.snapshot().hasNewer).toBe(true);

    // Live messages while scrolled back do not grow the window.
    const before = viewer.snapshot().transcript!.messages.length;
    for (let index = 0; index < 50; index++) fake.append();
    expect(viewer.snapshot().transcript!.messages.length).toBe(before);
    expect(viewer.snapshot().transcript!.revision).toBe(50);

    // Paging forward stays bounded and reaches the newest message, then follows live events again.
    let pages = 0;
    while (viewer.snapshot().hasNewer) {
      await viewer.loadNewer();
      expect(viewer.snapshot().transcript!.messages.length).toBeLessThanOrEqual(700);
      expect(++pages).toBeLessThan(100);
    }
    const transcript = viewer.snapshot().transcript!;
    expect(transcript.start + transcript.messages.length).toBe(6050);
    expect(transcript.messages.map(entry => entry.id)).toEqual(Array.from({ length: transcript.messages.length }, (_, offset) => `m${transcript.start + offset}`));
    fake.append();
    expect(ids(viewer).at(-1)).toBe('m6050');
  });

  it('returns to the newest window on jump to latest', async () => {
    const fake = host(2000);
    const viewer = new ChatTabViewer(fake.client, 'p');
    viewer.subscribe(() => undefined);
    await settle();
    for (let page = 0; page < 8; page++) await viewer.loadEarlier();
    expect(viewer.snapshot().hasNewer).toBe(true);
    fake.append();
    await viewer.jumpToLatest();
    expect(viewer.snapshot().hasNewer).toBe(false);
    expect(ids(viewer).at(-1)).toBe('m2000');
  });
});

describe('chat tab viewer registry (F-2)', () => {
  it('keeps the draft and the unconfirmed send per saved host and panel across replaced clients, and refreshes against the new one', async () => {
    const registry = new ChatTabViewerRegistry();
    const first = host(3);
    const viewer = registry.forPanel('host-A', 'p', first.client);
    const detach = viewer.subscribe(() => undefined);
    await settle();
    viewer.setDraft('half typed');
    const pending = { operationId: 'op', text: 'sent, response lost' };
    viewer.setPendingDelivery(pending);
    detach();
    const other = registry.forPanel('host-B', 'p', host(1).client);
    expect(other).not.toBe(viewer);
    expect(other.snapshot().draft).toBe('');

    const second = host(5);
    const returned = registry.forPanel('host-A', 'p', second.client);
    expect(returned).toBe(viewer);
    expect(returned.snapshot().draft).toBe('half typed');
    expect(returned.snapshot().pendingDelivery).toEqual(pending);
    returned.subscribe(() => undefined);
    await settle();
    expect(second.get).toHaveBeenCalled();
    expect(ids(returned).at(-1)).toBe('m4');

    // Credential replacement while subscribed: the stream moves to the new client.
    const third = host(7);
    expect(registry.forPanel('host-A', 'p', third.client)).toBe(viewer);
    await settle();
    expect(third.get).toHaveBeenCalled();
    expect(ids(viewer).at(-1)).toBe('m6');
    second.append();
    expect(ids(viewer).at(-1)).toBe('m6');
    third.append();
    expect(ids(viewer).at(-1)).toBe('m7');
    expect(viewer.snapshot().pendingDelivery).toEqual(pending);
  });

  it('ignores a snapshot from the replaced client that lands after rebinding', async () => {
    const registry = new ChatTabViewerRegistry();
    const first = host(3);
    const release = first.deferGet();
    const viewer = registry.forPanel('host-A', 'p', first.client);
    viewer.subscribe(() => undefined);
    const second = host(9);
    registry.forPanel('host-A', 'p', second.client);
    await settle();
    release();
    await settle();
    expect(ids(viewer).at(-1)).toBe('m8');
  });
});
