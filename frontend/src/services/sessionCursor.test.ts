import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OrchestrationSessionRecord } from '../../../shared/types/orchestrationSession';
import type { AppConfig } from '../types/config';

const peekSessionView = vi.fn();
const cachedSessionView = vi.fn();
vi.mock('../stores/sessionViewCache', () => ({ peekSessionView, cachedSessionView }));

// SAFETY: the cursor reads only these record fields.
const records = ['a', 'b', 'c'].map(id => ({ id, name: id, internalSessionId: `internal-${id}`, agent: 'claude', panelIds: { claude: `panel-${id}` } } as unknown as OrchestrationSessionRecord));

async function setup(config: Partial<AppConfig> = {}) {
  vi.resetModules();
  const listeners: Array<(event: FocusEvent) => void> = [];
  vi.stubGlobal('window', { addEventListener: (_type: string, listener: (event: FocusEvent) => void) => listeners.push(listener), electronAPI: {} });
  const cursor = await import('./sessionCursor');
  const { useOrchestrationSessionStore } = await import('../stores/orchestrationSessionStore');
  const { useConfigStore } = await import('../stores/configStore');
  const { useNavigationStore } = await import('../stores/navigationStore');
  const settle = vi.fn().mockResolvedValue(undefined);
  // SAFETY: the cursor reads only remoteDaemon and arrowKeysOpenSessions of the config.
  useConfigStore.setState({ config: { remoteDaemon: { client: { mode: 'local' } }, ...config } as unknown as AppConfig });
  useOrchestrationSessionStore.setState({ sessions: records, selectedSessionId: 'a', availability: 'ready', settle });
  useNavigationStore.setState({ activeView: 'pane-chat' });
  return { cursor, store: useOrchestrationSessionStore, settle, listeners };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  peekSessionView.mockResolvedValue(null);
  cachedSessionView.mockReturnValue(undefined);
});
afterEach(() => { vi.useRealTimers(); });

describe('Arrow keys open chat Sessions (T-87)', () => {
  it('is on by default on this machine, and off when turned off', async () => {
    const { cursor } = await setup();
    expect(cursor.cursorFollowEnabled()).toBe(true);
    // SAFETY: as above.
    expect(cursor.cursorFollowEnabled({ remoteDaemon: { client: { mode: 'local' } }, arrowKeysOpenSessions: false } as unknown as AppConfig)).toBe(false);
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
    const { cursor } = await setup();
    cursor.showSessionAtCursor('b');
    // SAFETY: the cursor reads only the agent tab's type of a held entry.
    cachedSessionView.mockImplementation((id: string) => (id === 'c' ? { view: { panel: { type: 'chat' } } } : undefined));
    cursor.showSessionAtCursor('c');
    expect(peekSessionView).toHaveBeenCalledTimes(1);
    expect(peekSessionView).toHaveBeenCalledWith({ sessionId: 'b', internalSessionId: 'internal-b', hostId: null });
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
    const { cursor, store } = await setup();
    // SAFETY: as above.
    cachedSessionView.mockReturnValue({ view: { panel: { type: 'terminal' } } });
    cursor.showSessionAtCursor('b');
    expect(store.getState().cursorSessionId).toBeUndefined();
  });

  it('settles when focus leaves the sidebar, and not while it stays there', async () => {
    const { cursor, settle, listeners } = await setup();
    cursor.showSessionAtCursor('b');
    const inSidebar = { closest: () => ({}) };
    const inChat = { closest: () => null };
    vi.stubGlobal('Element', class {});
    Object.setPrototypeOf(inSidebar, Element.prototype);
    Object.setPrototypeOf(inChat, Element.prototype);
    // SAFETY: the listener reads only the event target.
    for (const listener of listeners) listener({ target: inSidebar } as unknown as FocusEvent);
    expect(settle).not.toHaveBeenCalled();
    // SAFETY: as above.
    for (const listener of listeners) listener({ target: inChat } as unknown as FocusEvent);
    expect(settle).toHaveBeenCalledWith('b', null);
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
