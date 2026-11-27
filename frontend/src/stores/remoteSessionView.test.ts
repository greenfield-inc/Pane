import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mirrorSession = vi.fn();
const machineRead = vi.fn();
const chatListeners: Array<(event: { machineId: string; channel: string; payload: unknown }) => void> = [];

const msg = (index: number) => ({ id: `m${index}`, role: 'user', parts: [{ type: 'text', text: `t${index}` }] });
const snap = (sessionId: string, panelId: string, revision: number, count: number) => ({
  sessionId, revision, session: { id: sessionId, name: sessionId }, tabs: [], layout: null,
  chat: { panelId, agent: 'claude', generation: 1, status: 'working', permissions: [], questions: [], queue: [], messageCount: count, controls: [], commands: [], canAttachImages: false,
    transcript: { panelId, generation: 1, revision, start: 0, messages: Array.from({ length: count }, (_, index) => msg(index)) } },
});
const listing = (sessions: Record<string, number>) => ({ build: { state: { machineId: 'build', sync: 'live' as const, lastSeenAt: null, sessionCount: Object.keys(sessions).length }, sessions } });
/** The host's live event for message `index` of chat `rp`, at `revision`. */
const event = (index: number, revision: number) => ({ machineId: 'build', channel: 'chat-tab:event', payload: { panelId: 'rp', generation: 1, revision, index, change: { type: 'append', id: `m${index}`, role: 'assistant', part: { type: 'text', text: 'x' } } } });
const tick = (ms = 0) => vi.advanceTimersByTimeAsync(ms);

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  vi.useFakeTimers();
  chatListeners.length = 0;
  // The host answers each read, with nothing beyond the mirror's copy.
  machineRead.mockImplementation(async (machineId: string) => ({ machineId, data: { success: true, data: { view: null, panels: [], layout: null } } }));
  vi.stubGlobal('window', { addEventListener: vi.fn(), electronAPI: {
    machineMirror: { list: vi.fn(async () => []), session: mirrorSession, onChanged: vi.fn(() => () => undefined), followChat: vi.fn(),
      onChatEvent: vi.fn((callback: (typeof chatListeners)[number]) => { chatListeners.push(callback); return () => { chatListeners.splice(chatListeners.indexOf(callback), 1); }; }) },
    machines: { read: machineRead },
  } });
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

/** Machine `build` online and mirroring Session `b` (chat `rp`) at `revision` with `count` messages, shown, the cursor resting on it, and a viewer on its chat. */
async function shown(revision: number, count: number, settleMs = 2500) {
  const { useMachineMirrorStore } = await import('./machineMirrorStore');
  const { useAllMachinesStore } = await import('./allMachinesStore');
  const remote = await import('./remoteSessionView');
  const { ChatTabViewer } = await import('../../../shared/chatTabViewer');
  useAllMachinesStore.setState({ machines: [{ id: 'build', label: 'Build', kind: 'remote', status: 'online', offlineSince: null, mine: true }] });
  useMachineMirrorStore.setState({ listings: listing({ b: revision }) });
  mirrorSession.mockResolvedValue(snap('b', 'rp', revision, count));
  remote.showRemoteSession({ machineId: 'build', sessionId: 'b' });
  await tick();
  remote.showFullRemoteChat('build', 'rp', true);
  const viewer = new ChatTabViewer(remote.remoteChatClient('build', 'Build'), 'rp');
  viewer.subscribe(() => undefined);
  await tick();
  // The rest's own read (the 200-message fill) is not what these tests count.
  await tick(settleMs);
  machineRead.mockClear();
  const mirrorTo = async (next: number, nextCount: number) => {
    mirrorSession.mockResolvedValue(snap('b', 'rp', next, nextCount));
    useMachineMirrorStore.setState({ listings: listing({ b: next }) });
    await tick(20);
  };
  return { remote, viewer, mirrorTo, useMachineMirrorStore };
}

describe('a shown remote chat stays current (T-116 PR 6)', () => {
  it('after a gap the shown chat reads the host once, and takes the mirror\'s newer copy when it arrives (review SF-1)', async () => {
    const { remote, viewer, mirrorTo } = await shown(5, 3);
    expect(viewer.snapshot().transcript?.revision).toBe(5);

    // The host is ahead of the mirror: its next event is revision 7, a gap the held copy can't close.
    chatListeners.forEach(listener => listener(event(3, 7)));
    await tick();
    expect(machineRead).toHaveBeenCalledTimes(1);
    expect(machineRead).toHaveBeenCalledWith('build', 'orchestration-sessions:peek', [{ sessionId: 'b' }, { chatTabs: true, chatAgents: true }]);

    // The mirror catches up to revision 8 (4 messages); no further event comes (the turn ended).
    await mirrorTo(8, 4);
    expect(remote.cachedRemoteSession('build', 'b')?.snapshot?.revision).toBe(8);
    expect(viewer.snapshot().transcript?.revision).toBe(8);
    expect(viewer.snapshot().transcript?.messages).toHaveLength(4);
  });

  it("the host's first message after the cursor rests shows at once, even when it starts a new conversation run (QA F-1)", async () => {
    // The rest's own read landed 1.35 s ago; the chat's agent wasn't running on the host.
    const { viewer } = await shown(5, 3, 1350);
    const fresh = { panelId: 'rp', generation: 2, revision: 2, start: 0, messages: [msg(0), msg(1)] };
    machineRead.mockImplementation(async (machineId: string) => ({ machineId, data: { success: true, data: { view: null, panels: [], layout: null, chat: { ...snap('b', 'rp', 2, 2).chat, generation: 2, transcript: fresh } } } }));

    // A message on the host starts its agent: a new generation, then its events.
    chatListeners.forEach(listener => listener({ machineId: 'build', channel: 'chat-tab:view', payload: { ...snap('b', 'rp', 2, 2).chat, generation: 2, transcript: undefined } }));
    chatListeners.forEach(listener => listener({ machineId: 'build', channel: 'chat-tab:event', payload: { panelId: 'rp', generation: 2, revision: 2, index: 1, change: { type: 'append', id: 'm1', role: 'assistant', part: { type: 'text', text: 'x' } } } }));
    await tick(50);

    expect(machineRead).toHaveBeenCalledTimes(1);
    expect(viewer.snapshot().transcript?.generation).toBe(2);
    expect(viewer.snapshot().transcript?.messages.map(message => message.id)).toEqual(['m0', 'm1']);
  });

  it('a mirror copy that lags the live events never replaces them (review follow-up SF)', async () => {
    const { viewer, mirrorTo } = await shown(5, 3);
    // Live events: messages 3..6 arrive in order (revisions 6..9), no gap.
    for (let index = 3; index <= 6; index++) chatListeners.forEach(listener => listener(event(index, index + 3)));
    await tick(50);
    expect(viewer.snapshot().transcript?.revision).toBe(9);
    expect(viewer.snapshot().transcript?.messages).toHaveLength(7);

    // The mirror's batch catches up only to revision 6 (4 messages): the chat stays where the events took it.
    await mirrorTo(6, 4);
    expect(viewer.snapshot().transcript?.revision).toBe(9);
    expect(viewer.snapshot().transcript?.messages).toHaveLength(7);
    // No gap, so no host read.
    expect(machineRead).not.toHaveBeenCalled();
  });

  it('reads the host only on a gap: a shown chat whose copies keep changing with no gap is never polled (review follow-up suggestion)', async () => {
    const { remote, viewer } = await shown(5, 3);
    for (let second = 0; second < 20; second++) {
      // Another Session on that machine changes in the cache, and so does this chat's own copy, in step with its events.
      // SAFETY: the store reads only the chat of a held snapshot; this fixture has it.
      remote.useRemoteSessionView.setState(state => ({ entries: { ...state.entries, [remote.remoteSessionKey('build', 'other')]: { readAt: 0, snapshot: snap('other', 'po', second + 1, 1) as never } } }));
      await tick(1000);
    }
    expect(viewer.snapshot().transcript?.revision).toBe(5);
    expect(machineRead).not.toHaveBeenCalled();
  });

  it('a chat entered mid-turn catches the live tail with one host read, and follows the stream with no more (review quick check SF)', async () => {
    const { viewer } = await shown(5, 3);
    // The host: message i lands at revision i + 3; a read takes 300 ms and answers what the host has when it arrives.
    let hostCount = 10;
    machineRead.mockImplementation((machineId: string) => {
      const count = hostCount;
      return new Promise(resolve => setTimeout(() => resolve({ machineId, data: { success: true, data: { view: null, panels: [], layout: null, chat: snap('b', 'rp', count + 2, count).chat } } }), 300));
    });
    const end = () => (viewer.snapshot().transcript?.start ?? 0) + (viewer.snapshot().transcript?.messages.length ?? 0);

    // One message every 100 ms for 5 s; the first is 7 messages past what is held.
    for (let step = 0; step < 50; step++) {
      const index = hostCount;
      hostCount += 1;
      chatListeners.forEach(listener => listener(event(index, index + 3)));
      await tick(100);
    }

    expect(machineRead).toHaveBeenCalledTimes(1);
    expect(end()).toBe(hostCount);
    expect(viewer.snapshot().transcript?.revision).toBe(hostCount + 2);
  });

  it('a host that fails every read is read once per gap the events open, and not at all once they stop', async () => {
    const { viewer } = await shown(5, 3);
    machineRead.mockImplementation((machineId: string) => new Promise(resolve => setTimeout(() => resolve({ machineId, data: { success: false, error: 'nope' } }), 50)));
    for (let step = 0; step < 20; step++) {
      chatListeners.forEach(listener => listener(event(10 + step, 13 + step)));
      await tick(100);
    }
    const during = machineRead.mock.calls.length;
    await tick(10_000);
    expect(during).toBeLessThanOrEqual(20);
    expect(machineRead.mock.calls.length).toBe(during);
    expect(viewer.snapshot().transcript?.revision).toBe(5);
  });
});
