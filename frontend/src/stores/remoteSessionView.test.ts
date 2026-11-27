import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mirrorSession = vi.fn();
const machineRead = vi.fn();
let chatListener: ((event: { machineId: string; channel: string; payload: unknown }) => void) | undefined;

const msg = (i: number) => ({ id: `m${i}`, role: 'user', parts: [{ type: 'text', text: `t${i}` }] });
const snap = (revision: number, count: number) => ({
  sessionId: 'b', revision, session: { id: 'b', name: 'b' }, tabs: [], layout: null,
  chat: { panelId: 'rp', agent: 'claude', generation: 1, status: 'working', permissions: [], questions: [], queue: [], messageCount: count, controls: [], commands: [], canAttachImages: false,
    transcript: { panelId: 'rp', generation: 1, revision, start: 0, messages: Array.from({ length: count }, (_, i) => msg(i)) } },
});

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  machineRead.mockReturnValue(new Promise(() => undefined));
  vi.stubGlobal('window', { addEventListener: vi.fn(), electronAPI: {
    machineMirror: { list: vi.fn(async () => []), session: mirrorSession, onChanged: vi.fn(() => () => undefined), followChat: vi.fn(),
      onChatEvent: vi.fn((cb: typeof chatListener) => { chatListener = cb; return () => { chatListener = undefined; }; }) },
    machines: { read: machineRead },
  } });
});
afterEach(() => { vi.unstubAllGlobals(); });

describe('a shown remote chat stays current (T-116 PR 6)', () => {
  it('after a gap the shown chat reads the host once, and takes the mirror\'s newer copy when it arrives (review SF-1)', async () => {
    const { useMachineMirrorStore } = await import('./machineMirrorStore');
    const { useAllMachinesStore } = await import('./allMachinesStore');
    const remote = await import('./remoteSessionView');
    const { ChatTabViewer } = await import('../../../shared/chatTabViewer');
    useAllMachinesStore.setState({ machines: [{ id: 'build', label: 'Build', kind: 'remote', status: 'online', offlineSince: null, mine: true }] });
    useMachineMirrorStore.setState({ listings: { build: { state: { machineId: 'build', sync: 'live', lastSeenAt: null, sessionCount: 1 }, sessions: { b: 5 } } } });
    mirrorSession.mockResolvedValue(snap(5, 3));
    remote.showRemoteSession({ machineId: 'build', sessionId: 'b' });
    await new Promise(r => setTimeout(r, 0));
    remote.showFullRemoteChat('build', 'rp', true);

    const viewer = new ChatTabViewer(remote.remoteChatClient('build', 'Build'), 'rp');
    viewer.subscribe(() => undefined);
    await new Promise(r => setTimeout(r, 0));
    expect(viewer.snapshot().transcript?.revision).toBe(5);

    // The host is ahead of the mirror: its next event is revision 7 -> gap -> refresh -> held (5).
    chatListener?.({ machineId: 'build', channel: 'chat-tab:event', payload: { panelId: 'rp', generation: 1, revision: 7, index: 3, change: { type: 'append', id: 'm3', role: 'assistant', part: { type: 'text', text: 'x' } } } });
    await new Promise(r => setTimeout(r, 0));
    // The gap is one the held copy can't close: the host is read once (the cursor stayed on the chat).
    expect(machineRead).toHaveBeenCalledTimes(1);
    expect(machineRead).toHaveBeenCalledWith('build', 'orchestration-sessions:peek', [{ sessionId: 'b' }, { chatTabs: true, chatAgents: true }]);

    // The mirror catches up to revision 8 (4 messages); no further event comes (the turn ended).
    mirrorSession.mockResolvedValue(snap(8, 4));
    useMachineMirrorStore.setState({ listings: { build: { state: { machineId: 'build', sync: 'live', lastSeenAt: null, sessionCount: 1 }, sessions: { b: 8 } } } });
    await new Promise(r => setTimeout(r, 20));
    expect(remote.cachedRemoteSession('build', 'b')?.snapshot?.revision).toBe(8);
    // The newer copy draws, with the turn's last message.
    expect(viewer.snapshot().transcript?.revision).toBe(8);
    expect(viewer.snapshot().transcript?.messages).toHaveLength(4);
  });
});
