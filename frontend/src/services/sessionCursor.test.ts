import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OrchestrationSessionRecord, OrchestrationSessionView } from '../../../shared/types/orchestrationSession';
import type { Session } from '../types/session';
import type { AppConfig } from '../types/config';
import type { TerminalPausedMark, ToolPanel } from '../../../shared/types/panels';

const peek = vi.fn();
const getPaneLayout = vi.fn();

const records = ['a', 'b', 'c'].map(id => {
  // SAFETY: the cursor reads only these record fields.
  const record = { id, name: id, internalSessionId: `internal-${id}`, agent: 'claude', panelIds: { claude: `panel-${id}` } } as OrchestrationSessionRecord;
  return record;
});

/** A Session's chat tab as this window holds it; `paused` is the mark ChatTabManager.pause leaves (idle auto-pause). */
function chatPanel(sessionId: string, paused?: TerminalPausedMark): ToolPanel {
  // SAFETY: the cursor reads only a tab's id, type and its chat state's paused mark.
  return { id: `panel-${sessionId}`, sessionId: `internal-${sessionId}`, type: 'chat', state: { customState: { status: paused ? 'stopped' : 'idle', paused } } } as ToolPanel;
}

function heldView(sessionId: string, type: 'chat' | 'terminal') {
  // SAFETY: the cursor reads only the agent tab's type of a held view.
  const view = { session: { id: sessionId }, internalSession: { id: `internal-${sessionId}` }, panel: { id: `panel-${sessionId}`, type } } as OrchestrationSessionView<Session>;
  return { view, panels: [], layout: null, remembered: null, opened: true, readAt: 0 };
}

async function setup(config: Partial<AppConfig> = {}) {
  vi.resetModules();
  vi.stubGlobal('window', { addEventListener: vi.fn(), electronAPI: { orchestrationSessions: { peek }, uiState: { getPaneLayout } } });
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
  // This window holds each Session's chat tab, running (not paused).
  const { usePanelStore } = await import('../stores/panelStore');
  usePanelStore.setState({ panels: Object.fromEntries(records.map(record => [record.internalSessionId, [chatPanel(record.id)]])) });
  return { cursor, store: useOrchestrationSessionStore, cache: useSessionViewCache, settle, appConfig, panelStore: usePanelStore };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  peek.mockResolvedValue({ success: true, data: { view: null, panels: [], layout: null } });
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

describe('a chat paused by idle auto-pause (T-134 QA F-1)', () => {
  const AUTO = { at: '2026-11-26T22:00:00.000Z', by: 'auto' as const };

  it('a 1 s rest keeps it paused: the chat tab\'s own mark counts, not only the Session\'s', async () => {
    const { cursor, settle, panelStore } = await setup();
    // Auto-pause marks only the chat tab; the Session record reads as running.
    panelStore.setState({ panels: { ...panelStore.getState().panels, 'internal-b': [chatPanel('b', AUTO)] } });
    cursor.showSessionAtCursor('b');
    vi.advanceTimersByTime(1000);
    expect(settle).toHaveBeenCalledWith('b', null, { resume: false, record: records[1] });
  });

  it('the same when only the cursor\'s peek holds the chat tab', async () => {
    const { cursor, settle, panelStore, cache } = await setup();
    panelStore.setState({ panels: {} });
    const held = heldView('b', 'chat');
    cache.setState({ entries: { b: { ...held, view: { ...held.view, panel: chatPanel('b', AUTO) }, panels: [chatPanel('b', AUTO)] } } });
    cursor.showSessionAtCursor('b');
    vi.advanceTimersByTime(1000);
    expect(settle).toHaveBeenCalledWith('b', null, { resume: false, record: records[1] });
  });

  it('when this window cannot tell yet, the settle asks main not to resume, and main decides', async () => {
    const { cursor, settle, panelStore } = await setup();
    panelStore.setState({ panels: {} });
    peek.mockReturnValue(new Promise(() => undefined));
    cursor.showSessionAtCursor('b');
    vi.advanceTimersByTime(1000);
    expect(settle).toHaveBeenCalledWith('b', null, { resume: false, record: records[1] });
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
