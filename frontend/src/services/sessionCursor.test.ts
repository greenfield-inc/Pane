import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OrchestrationSessionRecord, OrchestrationSessionView } from '../../../shared/types/orchestrationSession';
import type { Session } from '../types/session';
import type { AppConfig } from '../types/config';

const peek = vi.fn();
const getPaneLayout = vi.fn();

const records = ['a', 'b', 'c'].map(id => {
  // SAFETY: the cursor reads only these record fields.
  const record = { id, name: id, internalSessionId: `internal-${id}`, agent: 'claude', panelIds: { claude: `panel-${id}` } } as OrchestrationSessionRecord;
  return record;
});

function heldView(sessionId: string, type: 'chat' | 'terminal') {
  // SAFETY: the cursor reads only the agent tab's type of a held view.
  const view = { session: { id: sessionId }, internalSession: { id: `internal-${sessionId}` }, panel: { id: `panel-${sessionId}`, type } } as OrchestrationSessionView<Session>;
  return { view, panels: [], layout: null, remembered: null, opened: true };
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
  return { cursor, store: useOrchestrationSessionStore, cache: useSessionViewCache, settle, appConfig };
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
    expect(settle).toHaveBeenCalledWith('c', null);
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
    expect(settle).toHaveBeenCalledWith('b', null);
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
