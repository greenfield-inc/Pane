import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OrchestrationSessionRecord, OrchestrationSessionView } from '../../../shared/types/orchestrationSession';
import type { Session } from '../types/session';
import type { AppConfig } from '../types/config';

const peek = vi.fn();
const getPaneLayout = vi.fn();
/** The mirror's one-Session read, and another machine's reads (T-116 PR 6). */
const mirrorSession = vi.fn();
const machineRead = vi.fn();
const machineRun = vi.fn();
const followChat = vi.fn();

const records = ['a', 'b', 'c'].map(id => {
  // SAFETY: the cursor reads only these record fields.
  const record = { id, name: id, internalSessionId: `internal-${id}`, agent: 'claude', panelIds: { claude: `panel-${id}` } } as OrchestrationSessionRecord;
  return record;
});

function heldView(sessionId: string, type: 'chat' | 'terminal') {
  // SAFETY: the cursor reads only the agent tab's type of a held view.
  const view = { session: { id: sessionId }, internalSession: { id: `internal-${sessionId}` }, panel: { id: `panel-${sessionId}`, type } } as OrchestrationSessionView<Session>;
  return { view, panels: [], layout: null, remembered: null, opened: true, readAt: 0 };
}

async function setup(config: Partial<AppConfig> = {}) {
  vi.resetModules();
  vi.stubGlobal('window', { addEventListener: vi.fn(), electronAPI: {
    orchestrationSessions: { peek },
    uiState: { getPaneLayout },
    machineMirror: { list: vi.fn(async () => []), session: mirrorSession, onChanged: vi.fn(() => () => undefined), followChat, onChatEvent: vi.fn(() => () => undefined) },
    machines: { read: machineRead, run: machineRun },
  } });
  const cursor = await import('./sessionCursor');
  const { useOrchestrationSessionStore } = await import('../stores/orchestrationSessionStore');
  const { useConfigStore } = await import('../stores/configStore');
  const { useNavigationStore } = await import('../stores/navigationStore');
  const { useSessionViewCache } = await import('../stores/sessionViewCache');
  const settle = vi.fn().mockResolvedValue(undefined);
  // SAFETY: the cursor reads only remoteDaemon and arrowKeysOpenSessions of the config.
  const appConfig = { remoteDaemon: { client: { mode: 'local' } }, ...config } as AppConfig;
  useConfigStore.setState({ config: appConfig });
  useOrchestrationSessionStore.setState({ sessions: records, selectedSessionId: 'a', availability: 'ready', settle });
  useNavigationStore.setState({ activeView: 'pane-chat' });
  return { cursor, store: useOrchestrationSessionStore, cache: useSessionViewCache, settle, appConfig };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  peek.mockResolvedValue({ success: true, data: { view: null, panels: [], layout: null } });
  mirrorSession.mockResolvedValue(null);
  machineRead.mockReturnValue(new Promise(() => undefined));
  getPaneLayout.mockResolvedValue({ success: true, data: null });
});
afterEach(() => { vi.useRealTimers(); });

describe('Arrow keys open chat Sessions (T-87)', () => {
  it('is on by default on this machine, and off when turned off', async () => {
    const { cursor, appConfig } = await setup();
    expect(cursor.cursorFollowEnabled()).toBe(true);
    expect(cursor.cursorFollowEnabled({ ...appConfig, arrowKeysOpenSessions: false })).toBe(false);
  });

  it('shows at once and settles only after the cursor rests for a second', async () => {
    const { cursor, store, settle } = await setup();
    cursor.showSessionAtCursor('b');
    expect(store.getState().cursorSessionId).toBe('b');
    vi.advanceTimersByTime(400);
    cursor.showSessionAtCursor('c');
    vi.advanceTimersByTime(999);
    expect(settle).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(settle).toHaveBeenCalledTimes(1);
    expect(settle).toHaveBeenCalledWith('c', null, { resume: true, record: records[2] });
  });

  it('peeks each Session it does not hold once, and none it holds', async () => {
    const { cursor, cache } = await setup();
    cache.setState({ entries: { c: heldView('c', 'chat') } });
    cursor.showSessionAtCursor('b');
    cursor.showSessionAtCursor('c');
    cursor.showSessionAtCursor('b');
    expect(peek).toHaveBeenCalledTimes(1);
    expect(peek).toHaveBeenCalledWith({ sessionId: 'b' });
  });

  it('back on the selected Session clears the cursor and settles nothing', async () => {
    const { cursor, store, settle } = await setup();
    cursor.showSessionAtCursor('b');
    cursor.showSessionAtCursor('a');
    vi.advanceTimersByTime(2000);
    expect(store.getState().cursorSessionId).toBeUndefined();
    expect(settle).not.toHaveBeenCalled();
  });

  it('a row that is not a chat Session stops the timer and keeps what is shown', async () => {
    const { cursor, store, settle } = await setup();
    cursor.showSessionAtCursor('b');
    cursor.pauseSessionCursor();
    vi.advanceTimersByTime(2000);
    expect(settle).not.toHaveBeenCalled();
    expect(store.getState().cursorSessionId).toBe('b');
    cursor.settleSessionCursor();
    expect(settle).toHaveBeenCalledWith('b', null, { resume: true, record: records[1] });
  });

  it('skips a Session whose agent runs in a terminal', async () => {
    const { cursor, store, cache } = await setup();
    cache.setState({ entries: { b: heldView('b', 'terminal') } });
    cursor.showSessionAtCursor('b');
    expect(store.getState().cursorSessionId).toBeUndefined();
  });

  it('dropping the cursor (leaving the Sessions view) selects nothing', async () => {
    const { cursor, store, settle } = await setup();
    cursor.showSessionAtCursor('b');
    cursor.dropSessionCursor();
    vi.advanceTimersByTime(2000);
    expect(store.getState().cursorSessionId).toBeUndefined();
    expect(settle).not.toHaveBeenCalled();
  });
});

describe('settling from a click or Enter (T-87)', () => {
  it('opens nothing again for the Session already settled and shown', async () => {
    const { cursor, settle } = await setup();
    await cursor.settleOnSession('a');
    expect(settle).not.toHaveBeenCalled();
    await cursor.settleOnSession('b');
    expect(settle).toHaveBeenCalledWith('b', null, { record: records[1] });
  });
});

describe('the cursor never outlives its intent (T-87)', () => {
  it('a selection made another way cancels the pending settle', async () => {
    const { cursor, store, settle } = await setup();
    cursor.showSessionAtCursor('b');
    // A tile click, a restore or a host switch selects something else and clears the cursor.
    store.setState({ cursorSessionId: undefined, selectedSessionId: 'c' });
    vi.advanceTimersByTime(2000);
    expect(settle).not.toHaveBeenCalled();
  });

  it('turning the setting off drops what the cursor shows', async () => {
    const { cursor, store, settle, appConfig } = await setup();
    cursor.showSessionAtCursor('b');
    const { useConfigStore } = await import('../stores/configStore');
    useConfigStore.setState({ config: { ...appConfig, arrowKeysOpenSessions: false } });
    vi.advanceTimersByTime(2000);
    expect(store.getState().cursorSessionId).toBeUndefined();
    expect(settle).not.toHaveBeenCalled();
  });

  it('Enter on a Session settled by itself opens it again, so a paused chat resumes', async () => {
    const { cursor, store, settle } = await setup();
    store.setState({ quietSessionId: 'a' });
    await cursor.settleOnSession('a');
    expect(settle).toHaveBeenCalledWith('a', null, { record: records[0] });
  });
});

describe('a paused chat (T-87)', () => {
  it('a settle by itself on a paused Session asks main not to resume it', async () => {
    const { cursor, store, settle } = await setup();
    // SAFETY: the cursor reads only the record's paused mark.
    store.setState({ sessions: store.getState().sessions.map(session => (session.id === 'b' ? { ...session, paused: { at: '2026-11-25T00:00:00.000Z', by: 'manual' } } as OrchestrationSessionRecord : session)) });
    cursor.showSessionAtCursor('b');
    vi.advanceTimersByTime(1000);
    expect(settle).toHaveBeenCalledWith('b', null, { resume: false, record: store.getState().sessions[1] });
  });
});

describe('which rows the cursor shows at once (T-116)', () => {
  it("this machine's rows show at once; another machine's keep Enter", async () => {
    const { cursor, appConfig } = await setup();
    expect(cursor.rowShowsInstantly('local')).toBe(true);
    expect(cursor.rowShowsInstantly('build')).toBe(false);
    expect(cursor.rowShowsInstantly('local', { ...appConfig, arrowKeysOpenSessions: false })).toBe(false);
  });

  it('a window showing another machine shows no row at once, not even this computer\'s', async () => {
    const { cursor, appConfig } = await setup();
    // SAFETY: the cursor reads only remoteDaemon and arrowKeysOpenSessions of the config.
    const remote = { ...appConfig, remoteDaemon: { client: { mode: 'remote', activeProfileId: 'build', profiles: [{ id: 'build', label: 'build-box', baseUrl: 'https://build-box.example:8443', token: 'pairing-token', transport: 'http+sse' }] } } } as AppConfig;
    expect(cursor.cursorFollowEnabled(remote)).toBe(false);
    expect(cursor.rowShowsInstantly('local', remote)).toBe(false);
  });

  it("peeks a Session the Sessions list has not loaded from this machine's All machines rows", async () => {
    const { cursor, store } = await setup();
    const { useAllMachinesStore } = await import('../stores/allMachinesStore');
    store.setState({ sessions: [records[0]] });
    // SAFETY: the cursor reads only the local snapshot's Session records.
    useAllMachinesStore.setState({ snapshots: { local: { sessions: records } } as never });
    cursor.showSessionAtCursor('b');
    expect(store.getState().cursorSessionId).toBe('b');
    expect(peek).toHaveBeenCalledWith({ sessionId: 'b' });
  });
});

describe('a Session only the All machines read holds (T-116 review SF-1)', () => {
  it('a 1 s rest on a paused one keeps it paused, and settles with the record it peeked', async () => {
    const { cursor, store, settle } = await setup();
    const { useAllMachinesStore } = await import('../stores/allMachinesStore');
    // The Sessions list has not loaded yet (startup, or a failed load); the peek never answers.
    store.setState({ sessions: [] });
    const paused: OrchestrationSessionRecord = { ...records[1], paused: { at: '2026-11-25T00:00:00.000Z', by: 'manual' } };
    // SAFETY: the cursor reads only the local snapshot's Session records.
    useAllMachinesStore.setState({ snapshots: { local: { sessions: [records[0], paused, records[2]] } } as never });
    peek.mockReturnValue(new Promise(() => undefined));
    cursor.showSessionAtCursor('b');
    vi.advanceTimersByTime(1000);
    expect(settle).toHaveBeenCalledWith('b', null, { resume: false, record: paused });
  });
});

describe('a load never holds the cursor (D-6)', () => {
  it('a peek that never answers does not delay the next move, and its answer is dropped', async () => {
    const { cursor, store } = await setup();
    peek.mockReturnValue(new Promise(() => undefined));
    cursor.showSessionAtCursor('b');
    cursor.showSessionAtCursor('c');
    expect(store.getState().cursorSessionId).toBe('c');
    cursor.showSessionAtCursor('b');
    expect(store.getState().cursorSessionId).toBe('b');
    // b's first peek is still in flight: one peek per Session, not one per press.
    expect(peek.mock.calls.filter(([request]) => request.sessionId === 'b')).toHaveLength(1);
  });
});

/** The owner's machine `build`, mirrored with Sessions `b` and `c` (the same ids as this computer's). */
async function mirrored() {
  const { useMachineMirrorStore } = await import('../stores/machineMirrorStore');
  useMachineMirrorStore.setState({ listings: { build: { state: { machineId: 'build', sync: 'live', lastSeenAt: '2026-11-26T12:00:00.000Z', sessionCount: 2 }, sessions: { b: 4, c: 9 } } } });
  const { useAllMachinesStore } = await import('../stores/allMachinesStore');
  useAllMachinesStore.setState({ machines: [{ id: 'build', label: 'Build box', kind: 'remote', status: 'online', offlineSince: null, mine: true }] });
  const remote = await import('../stores/remoteSessionView');
  return { remote, target: () => remote.useRemoteSessionView.getState().target };
}

describe("another machine's Sessions under the cursor (T-116 PR 6)", () => {
  it("a mirrored machine's rows show at once; one not mirrored keeps Enter, and so does the setting off", async () => {
    const { cursor, appConfig } = await setup();
    await mirrored();
    expect(cursor.rowShowsInstantly('build')).toBe(true);
    expect(cursor.rowShowsInstantly('teammate')).toBe(false);
    expect(cursor.rowShowsInstantly('build', { ...appConfig, arrowKeysOpenSessions: false })).toBe(false);
  });

  it('shows the Session from the mirror by machine and id, reads nothing of this computer, and a 1 s rest does nothing more', async () => {
    const { cursor, store, settle } = await setup();
    const { target } = await mirrored();
    cursor.showSessionAtCursor('b');
    cursor.showSessionAtCursor('b', 'build');

    expect(target()).toEqual({ machineId: 'build', sessionId: 'b' });
    // This computer's own `b` is not what the cursor shows any more.
    expect(store.getState().cursorSessionId).toBeUndefined();
    expect(mirrorSession).toHaveBeenCalledWith('build', 'b');
    vi.advanceTimersByTime(5000);
    expect(settle).not.toHaveBeenCalled();
    expect(machineRun).not.toHaveBeenCalled();
    expect(target()).toEqual({ machineId: 'build', sessionId: 'b' });
  });

  it('moving back to a row of this computer shows it there, and the remote one goes', async () => {
    const { cursor, store } = await setup();
    const { target } = await mirrored();
    cursor.showSessionAtCursor('b', 'build');
    cursor.showSessionAtCursor('c');
    expect(target()).toBeUndefined();
    expect(store.getState().cursorSessionId).toBe('c');
  });

  it('a mirror read and a host read that never answer delay no move, and the cursor ends where it was moved (D-6)', async () => {
    const { cursor, store } = await setup();
    const { target } = await mirrored();
    mirrorSession.mockReturnValue(new Promise(() => undefined));
    for (const id of ['b', 'c', 'x', 'b']) cursor.showSessionAtCursor(id, 'build');
    expect(target()).toEqual({ machineId: 'build', sessionId: 'b' });
    vi.advanceTimersByTime(1000);
    cursor.showSessionAtCursor('c');
    expect(target()).toBeUndefined();
    expect(store.getState().cursorSessionId).toBe('c');
  });

  it("reads a Session the mirror lacks with one call, only for the row the cursor stays on (alternative b)", async () => {
    const { cursor } = await setup();
    await mirrored();
    cursor.showSessionAtCursor('x', 'build');
    vi.advanceTimersByTime(50);
    cursor.showSessionAtCursor('y', 'build');
    vi.advanceTimersByTime(1000);
    expect(machineRead).toHaveBeenCalledTimes(1);
    expect(machineRead).toHaveBeenCalledWith('build', 'orchestration-sessions:peek', [{ sessionId: 'y' }, { chatTabs: true, chatAgents: true }]);
  });

  it("fills a mirrored Session's newest 200 messages with one host read once the cursor rests, and none for rows passed over", async () => {
    const { cursor } = await setup();
    await mirrored();
    cursor.showSessionAtCursor('b', 'build');
    vi.advanceTimersByTime(30);
    cursor.showSessionAtCursor('c', 'build');
    vi.advanceTimersByTime(1000);
    expect(machineRead).toHaveBeenCalledTimes(1);
    expect(machineRead).toHaveBeenCalledWith('build', 'orchestration-sessions:peek', [{ sessionId: 'c' }, { chatTabs: true, chatAgents: true }]);
  });

  it('reads nothing from a machine that is offline: it shows what the mirror last had', async () => {
    const { cursor } = await setup();
    await mirrored();
    const { useAllMachinesStore } = await import('../stores/allMachinesStore');
    useAllMachinesStore.setState({ machines: [{ id: 'build', label: 'Build box', kind: 'remote', status: 'offline', offlineSince: '2026-11-26T12:00:00.000Z', mine: true }] });
    cursor.showSessionAtCursor('x', 'build');
    cursor.showSessionAtCursor('b', 'build');
    vi.advanceTimersByTime(1000);
    expect(machineRead).not.toHaveBeenCalled();
    expect(mirrorSession).toHaveBeenCalledWith('build', 'b');
  });

  it('keeps one remote Session apart from this computer\'s Session of the same id', async () => {
    const { cursor, cache } = await setup();
    const { remote } = await mirrored();
    cache.setState({ entries: { b: heldView('b', 'chat') } });
    const snapshot = { sessionId: 'b', revision: 4, session: { id: 'b', name: 'Remote b' }, chat: { panelId: 'remote-panel' }, tabs: [], layout: null };
    mirrorSession.mockResolvedValue(snapshot);
    cursor.showSessionAtCursor('b', 'build');
    await vi.advanceTimersByTimeAsync(0);
    expect(remote.cachedRemoteSession('build', 'b')?.snapshot).toEqual(snapshot);
    expect(remote.cachedRemoteSession('local', 'b')).toBeUndefined();
    expect(cache.getState().entries.b?.view.panel.id).toBe('panel-b');
  });
});
