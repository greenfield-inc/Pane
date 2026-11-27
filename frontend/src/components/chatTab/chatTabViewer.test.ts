import { describe, expect, it, vi } from 'vitest';
import type { AgentChatMessage } from '../../../../shared/types/agentChat';
import type { ChatTabClient, ChatTabEvent, ChatTabView } from '../../../../shared/types/chatTab';
import { ChatTabViewer, ChatTabViewerRegistry } from '../../../../shared/chatTabViewer';
import { STREAM_FRAME_MS } from '../../../../shared/constants/streamCadence';

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
      // The host returns at most 500 messages from one read.
      return structuredClone(state.messages.slice(Math.max(0, end - Math.min(500, limit)), end));
    },
    onEvent: callback => { events.add(callback); return () => events.delete(callback); },
    onState: () => () => undefined,
    send: unused, receipt: unused, unqueue: unused, sendNow: unused, editQueued: unused, clear: unused, stopTask: unused, configure: unused, cancel: unused, permission: unused, answer: unused, restart: unused, signIn: unused,
    conversations: unused, resume: unused, dismissBanner: unused, agents: unused, files: unused,
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

describe('chat tab viewer streaming', () => {
  it('redraws a burst of live events once per stream frame, showing the first at once and losing none', async () => {
    vi.useFakeTimers();
    try {
      const fake = host(1);
      const viewer = new ChatTabViewer(fake.client, 'p');
      let redraws = 0;
      viewer.subscribe(() => { redraws++; });
      await vi.advanceTimersByTimeAsync(1000);
      const before = redraws;
      for (let index = 0; index < 5; index++) fake.append();
      expect(redraws).toBe(before + 1);
      expect(ids(viewer)).toEqual(['m0', 'm1', 'm2', 'm3', 'm4', 'm5']);
      await vi.advanceTimersByTimeAsync(STREAM_FRAME_MS);
      expect(redraws).toBe(before + 2);
      await vi.advanceTimersByTimeAsync(1000);
      expect(redraws).toBe(before + 2);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('chat tab viewer whole conversation', () => {
  it('returns every message of a long chat, from the newest window or while scrolled back, without moving the window', async () => {
    const fake = host(1234);
    const viewer = new ChatTabViewer(fake.client, 'p');
    viewer.subscribe(() => undefined);
    await settle();
    const everyId = Array.from({ length: 1234 }, (_, index) => `m${index}`);
    const shown = ids(viewer);
    expect((await viewer.allMessages()).map(entry => entry.id)).toEqual(everyId);
    expect(ids(viewer)).toEqual(shown);

    for (let page = 0; page < 8; page++) await viewer.loadEarlier();
    expect(viewer.snapshot().hasNewer).toBe(true);
    fake.append();
    expect((await viewer.allMessages()).map(entry => entry.id)).toEqual([...everyId, 'm1234']);
  });

  it('rejects instead of returning part of the chat when a page fails', async () => {
    const fake = host(1234);
    const viewer = new ChatTabViewer(fake.client, 'p');
    viewer.subscribe(() => undefined);
    await settle();
    fake.client.history = async () => { throw new Error('host went away'); };
    await expect(viewer.allMessages()).rejects.toThrow('host went away');
  });
});

describe('chat tab viewer reopen', () => {
  it('paints a reopened chat’s last messages at once, then refreshes them from the host', async () => {
    const fake = host(3);
    const viewer = new ChatTabViewer(fake.client, 'p');
    const close = viewer.subscribe(() => undefined);
    await settle();
    close();
    fake.append();
    const release = fake.deferGet();
    viewer.subscribe(() => undefined);
    expect(ids(viewer)).toEqual(['m0', 'm1', 'm2']);
    release();
    await settle();
    expect(ids(viewer)).toEqual(['m0', 'm1', 'm2', 'm3']);
  });

  it('keeps the messages of the five chats closed most recently', async () => {
    const fake = host(3);
    const viewers = ['a', 'b', 'c', 'd', 'e', 'f'].map(panel => new ChatTabViewer(fake.client, panel));
    const closers = viewers.map(viewer => viewer.subscribe(() => undefined));
    await settle();
    closers.forEach(close => close());
    expect(viewers.map(viewer => ids(viewer).length)).toEqual([0, 3, 3, 3, 3, 3]);
  });

  it('a closed chat shown again keeps its messages when the chat it replaces closes in the same switch (T-116 PR 6)', async () => {
    const fake = host(3);
    const [shownAgain, ...rest] = ['a', 'b', 'c', 'd', 'e'].map(panel => new ChatTabViewer(fake.client, panel));
    const closers = [shownAgain, ...rest].map(viewer => viewer.subscribe(() => undefined));
    const leaving = new ChatTabViewer(fake.client, 'f');
    const closeLeaving = leaving.subscribe(() => undefined);
    await settle();
    closers.forEach(close => close());
    expect(ids(shownAgain), 'held while closed').toHaveLength(3);

    // The next chat renders (and is primed) before the one it replaces unmounts, then subscribes.
    shownAgain.prime({ ...fake.view(), panelId: 'a' }, performance.now());
    closeLeaving();
    shownAgain.subscribe(() => undefined);

    expect(ids(shownAgain)).toHaveLength(3);
    expect(rest.map(viewer => ids(viewer).length)).toEqual([3, 3, 3, 3]);
  });

  it('chats primed by renders that were thrown away keep their messages for only the newest few (review SF-4)', async () => {
    const fake = host(3);
    const kept = ['k1', 'k2', 'k3', 'k4', 'k5'].map(panel => new ChatTabViewer(fake.client, panel));
    kept.map(viewer => viewer.subscribe(() => undefined)).forEach(close => close());
    await settle();
    const primed = Array.from({ length: 10 }, (_, index) => new ChatTabViewer(fake.client, `x${index}`));
    for (const viewer of primed) viewer.prime({ ...fake.view(), panelId: viewer.panelId }, performance.now());

    expect(primed.map(viewer => ids(viewer).length)).toEqual([0, 0, 0, 0, 0, 0, 0, 3, 3, 3]);
    // The five closed chats are not pushed out by them.
    expect(kept.map(viewer => ids(viewer).length)).toEqual([3, 3, 3, 3, 3]);
  });

  it('a chat that is not kept on close holds nothing once closed, and pushes none of the five out (review suggestion)', async () => {
    const fake = host(3);
    const kept = ['k1', 'k2', 'k3', 'k4', 'k5'].map(panel => new ChatTabViewer(fake.client, panel));
    kept.map(viewer => viewer.subscribe(() => undefined)).forEach(close => close());
    const passing = new ChatTabViewer(fake.client, 'remote');
    passing.setKeepOnClose(false);
    passing.subscribe(() => undefined)();
    await settle();

    expect(ids(passing)).toEqual([]);
    expect(kept.map(viewer => ids(viewer).length)).toEqual([3, 3, 3, 3, 3]);
  });

  it('a read answering an older copy of the same conversation never replaces the newer window shown (review follow-up SF)', async () => {
    const fake = host(3);
    const viewer = new ChatTabViewer(fake.client, 'p');
    viewer.subscribe(() => undefined);
    await settle();
    fake.append();
    await settle();
    expect(ids(viewer)).toEqual(['m0', 'm1', 'm2', 'm3']);

    // A held client answers a copy from before the last event.
    const older = fake.view();
    older.transcript = { ...older.transcript!, revision: older.transcript!.revision - 1, messages: older.transcript!.messages.slice(0, 3) };
    fake.get.mockResolvedValueOnce(older);
    await viewer.refresh();
    expect(ids(viewer)).toEqual(['m0', 'm1', 'm2', 'm3']);
  });

  it('a read answering an older copy while events arrive keeps the newer window and reads no more (CI smoke loop)', async () => {
    const fake = host(3);
    const viewer = new ChatTabViewer(fake.client, 'p');
    viewer.subscribe(() => undefined);
    await settle();
    fake.append();
    await settle();
    // Every read from now on answers the copy from before the last event (a held copy, or a host that lags).
    const older = fake.view();
    older.transcript = { ...older.transcript!, revision: older.transcript!.revision - 1, messages: older.transcript!.messages.slice(0, 3) };
    fake.get.mockClear();
    fake.get.mockResolvedValue(older);
    const reading = viewer.refresh();
    fake.append();
    await reading;
    await settle();
    await settle();

    expect(ids(viewer)).toEqual(['m0', 'm1', 'm2', 'm3', 'm4']);
    expect(fake.get.mock.calls.length).toBeLessThanOrEqual(2);
  });

  it('jump to latest from a scrolled-back window shows the newest window even when the read answers an older copy (review quick check suggestion)', async () => {
    // A 900-message chat whose reads answer a held copy at revision 1000.
    const view = (): ChatTabView => ({
      panelId: 'p', agent: 'claude', generation: 1, status: 'idle', canAttachImages: false, controls: [], commands: [], permissions: [], questions: [], queue: [], messageCount: 900,
      transcript: { panelId: 'p', generation: 1, revision: 1000, start: 700, messages: Array.from({ length: 200 }, (_, index) => message(700 + index)) },
    });
    let onEvent: ((event: ChatTabEvent) => void) | undefined;
    const unused = async (): Promise<never> => { throw new Error('Not used by the viewer'); };
    const client: ChatTabClient = {
      get: async () => view(),
      history: async (_panelId, before, limit) => Array.from({ length: Math.min(limit, before) }, (_, index) => message(before - Math.min(limit, before) + index)),
      onEvent: callback => { onEvent = callback; return () => undefined; },
      onState: () => () => undefined,
      send: unused, receipt: unused, unqueue: unused, sendNow: unused, editQueued: unused, clear: unused, stopTask: unused, configure: unused, cancel: unused, permission: unused, answer: unused, restart: unused, signIn: unused,
      conversations: unused, resume: unused, dismissBanner: unused, agents: unused, files: unused,
    };
    const viewer = new ChatTabViewer(client, 'p');
    viewer.subscribe(() => undefined);
    await settle();
    for (let page = 0; page < 6; page++) await viewer.loadEarlier();
    expect(viewer.snapshot().hasNewer).toBe(true);
    // A live event past the scrolled-back window's end moves its revision to 1001.
    onEvent?.({ panelId: 'p', generation: 1, revision: 1001, index: 900, change: { type: 'append', id: 'm900', role: 'assistant', part: { type: 'text', text: 'x' } } });

    await viewer.jumpToLatest();
    const shown = viewer.snapshot().transcript!;
    expect(shown.start + shown.messages.length).toBe(900);
    expect(viewer.snapshot().hasNewer).toBe(false);
  });

  it('counts a chat closed before its first read lands toward the five', async () => {
    const fake = host(3);
    const viewers = ['a', 'b', 'c', 'd', 'e', 'f'].map(panel => new ChatTabViewer(fake.client, panel));
    viewers.map(viewer => viewer.subscribe(() => undefined)).forEach(close => close());
    await settle();
    expect(viewers.map(viewer => ids(viewer).length)).toEqual([0, 3, 3, 3, 3, 3]);
  });

  it('keeps the newest 200 messages of a long chat, and nothing of a chat closed while scrolled back', async () => {
    const fake = host(1000);
    const following = new ChatTabViewer(fake.client, 'p');
    const close = following.subscribe(() => undefined);
    await settle();
    close();
    expect(ids(following)).toHaveLength(200);
    expect(ids(following).at(-1)).toBe('m999');

    const scrolled = new ChatTabViewer(fake.client, 'p');
    const closeScrolled = scrolled.subscribe(() => undefined);
    await settle();
    for (let page = 0; page < 6; page++) await scrolled.loadEarlier();
    expect(scrolled.snapshot().hasNewer).toBe(true);
    closeScrolled();
    expect(ids(scrolled)).toEqual([]);
  });
});

describe('a Session shown by the sidebar cursor (T-87)', () => {
  it('reads without starting the agent while the cursor only shows it', async () => {
    const fake = host(3);
    const viewer = new ChatTabViewer(fake.client, 'p');
    viewer.setStartOnRead(false);
    const off = viewer.subscribe(() => undefined);
    await settle();
    expect(fake.get).toHaveBeenLastCalledWith('p', 200, { start: false });
    off();
  });

  it('paints a window read just now, reads it again only after the paint, and reads an older one at once', async () => {
    const fake = host(3);
    const viewer = new ChatTabViewer(fake.client, 'p');
    viewer.prime(fake.view(), performance.now());
    expect(ids(viewer)).toEqual(['m0', 'm1', 'm2']);
    // A message the agent finished between that read and this subscription: no event will say so.
    fake.append(false);
    const off = viewer.subscribe(() => undefined);
    await settle();
    expect(fake.get).not.toHaveBeenCalled();
    await new Promise(resolve => setTimeout(resolve, 200));
    expect(fake.get).toHaveBeenCalledTimes(1);
    expect(ids(viewer)).toEqual(['m0', 'm1', 'm2', 'm3']);
    off();
    fake.get.mockClear();

    const stale = new ChatTabViewer(fake.client, 'p');
    stale.prime(fake.view(), performance.now() - 60_000);
    const offStale = stale.subscribe(() => undefined);
    await settle();
    expect(fake.get).toHaveBeenCalledTimes(1);
    offStale();
  });
});
