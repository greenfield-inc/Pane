import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GitStatus, Session, SessionOutput } from '../types/session';
import { useSessionStore } from './sessionStore';

function session(overrides: Partial<Session> = {}): Session {
  return {
    id: 'session-new',
    name: 'New pane',
    worktreePath: '/repo/worktrees/new-pane',
    prompt: '',
    status: 'stopped',
    createdAt: '2026-01-01T00:00:00.000Z',
    output: [],
    jsonMessages: [],
    ...overrides,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

describe('session selection ordering', () => {
  const invoke = vi.fn();
  const getSession = vi.fn();
  const markViewed = vi.fn();

  beforeEach(() => {
    invoke.mockReset().mockResolvedValue({ success: true });
    getSession.mockReset();
    markViewed.mockReset().mockResolvedValue({ success: true });
    vi.stubGlobal('window', {
      dispatchEvent: vi.fn(),
      electronAPI: { invoke, sessions: { get: getSession, markViewed } },
    });
    useSessionStore.setState({
      sessions: [session({ id: 'a' }), session({ id: 'b' })],
      activeSessionId: null,
      activeMainRepoSession: null,
    });
  });

  afterEach(() => vi.unstubAllGlobals());

  it('keeps the last selection when IPC replies arrive in reverse order', async () => {
    const first = deferred<unknown>();
    const second = deferred<unknown>();
    invoke.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const selectA = useSessionStore.getState().setActiveSession('a');
    const selectB = useSessionStore.getState().setActiveSession('b');

    second.resolve({ success: true });
    await selectB;
    expect(useSessionStore.getState().getActiveSession()?.id).toBe('b');
    first.resolve({ success: true });
    await selectA;
    expect(useSessionStore.getState().getActiveSession()?.id).toBe('b');
  });

  it('selects immediately and preserves a clear while a notification is pending', async () => {
    const reply = deferred<unknown>();
    invoke.mockReturnValueOnce(reply.promise);
    const selecting = useSessionStore.getState().setActiveSession('a');
    expect(useSessionStore.getState().getActiveSession()?.id).toBe('a');
    await useSessionStore.getState().setActiveSession(null);
    reply.resolve({ success: true });
    await selecting;
    expect(useSessionStore.getState().activeSessionId).toBeNull();
  });

  it.each(['b', null])('ignores an uncached main-repo fetch after selecting %s', async (next) => {
    const reply = deferred<{ success: boolean; data: Session }>();
    getSession.mockReturnValueOnce(reply.promise);
    const selecting = useSessionStore.getState().setActiveSession('missing');
    await useSessionStore.getState().setActiveSession(next);
    reply.resolve({ success: true, data: session({ id: 'missing', isMainRepo: true }) });
    await selecting;
    expect(useSessionStore.getState().activeSessionId).toBe(next);
    expect(useSessionStore.getState().activeMainRepoSession).toBeNull();
    expect(useSessionStore.getState().sessions.map(item => item.id)).toEqual(['a', 'b']);
    expect(markViewed).not.toHaveBeenCalledWith('missing');
  });

  it('does not restore a selection after its fetch fails', async () => {
    const reply = deferred<Session>();
    getSession.mockImplementationOnce(async () => {
      await reply.promise;
      throw new Error('Disconnected');
    });
    const selecting = useSessionStore.getState().setActiveSession('missing');
    await useSessionStore.getState().setActiveSession('b');
    reply.resolve(session());
    await selecting;
    expect(useSessionStore.getState().getActiveSession()?.id).toBe('b');
  });

  it('marks a fetched main-repo session viewed once, with initialized output', async () => {
    getSession.mockResolvedValueOnce({ success: true, data: session({ id: 'main', isMainRepo: true }) });
    await useSessionStore.getState().setActiveSession('main');
    expect(useSessionStore.getState().getActiveSession()).toMatchObject({ id: 'main', output: [], jsonMessages: [] });
    await useSessionStore.getState().setActiveSession('main');
    expect(markViewed).toHaveBeenCalledExactlyOnceWith('main');
  });

  it('marks an uncached session viewed when reselected before its data arrives', async () => {
    const first = deferred<{ success: boolean; data: Session }>();
    const second = deferred<{ success: boolean; data: Session }>();
    getSession.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const selecting = useSessionStore.getState().setActiveSession('missing');
    const reselecting = useSessionStore.getState().setActiveSession('missing');
    second.resolve({ success: true, data: session({ id: 'missing', name: 'Current data' }) });
    await reselecting;
    first.resolve({ success: true, data: session({ id: 'missing', name: 'Old data' }) });
    await selecting;
    expect(useSessionStore.getState().getActiveSession()?.name).toBe('Current data');
    expect(markViewed).toHaveBeenCalledExactlyOnceWith('missing');
  });
});

describe('sessionStore', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    useSessionStore.setState({
      sessions: [],
      activeSessionId: null,
      activeMainRepoSession: null,
      isLoaded: false,
      terminalOutput: {},
      deletingSessionIds: new Set(),
      gitStatusLoading: new Set(),
      pendingGitStatusLoading: new Map(),
      pendingGitStatusUpdates: new Map(),
      gitStatusBatchTimer: null,
      activeSpotlights: new Map(),
    });
  });

  afterEach(() => {
    const timer = useSessionStore.getState().gitStatusBatchTimer;
    if (timer) clearTimeout(timer);
    vi.useRealTimers();
  });

  it('keeps the current active pane when a background-created session arrives', () => {
    useSessionStore.setState({ activeSessionId: 'session-existing' });

    useSessionStore.getState().addSession(session({
      id: 'session-background',
      activateOnCreate: false,
    }));

    const state = useSessionStore.getState();
    expect(state.sessions[0].id).toBe('session-background');
    expect(state.activeSessionId).toBe('session-existing');
  });

  it('activates newly created sessions by default', () => {
    useSessionStore.setState({ activeSessionId: 'session-existing' });

    useSessionStore.getState().addSession(session({
      id: 'session-foreground',
    }));

    expect(useSessionStore.getState().activeSessionId).toBe('session-foreground');
  });

  it('retains the latest output and JSON messages independently in chronological order', () => {
    const target = session();
    const other = session({ id: 'other' });
    useSessionStore.setState({ sessions: [target, other], activeMainRepoSession: target });
    const outputs: SessionOutput[] = [];
    for (let i = 0; i < 1000; i++) {
      outputs.push({ sessionId: target.id, type: i % 2 ? 'stderr' : 'stdout', data: `line-${i}`, timestamp: '' });
      outputs.push({ sessionId: target.id, type: 'json', data: { type: 'assistant', text: `message-${i}`, timestamp: '' }, timestamp: '2026-09-06T00:00:00.000Z' });
    }
    const original = outputs.slice();

    useSessionStore.getState().setSessionOutputs(target.id, outputs);

    const state = useSessionStore.getState();
    const updated = state.sessions[0];
    expect(updated.output).toEqual(Array.from({ length: 300 }, (_, i) => `line-${i + 700}`));
    expect(updated.jsonMessages.map(message => message.text)).toEqual(Array.from({ length: 100 }, (_, i) => `message-${i + 900}`));
    expect(updated.jsonMessages[99].timestamp).toBe('2026-09-06T00:00:00.000Z');
    expect(state.activeMainRepoSession?.output).toEqual(updated.output);
    expect(state.activeMainRepoSession?.jsonMessages).toEqual(updated.jsonMessages);
    expect(state.sessions[1]).toBe(other);
    expect(target.output).toEqual([]);
    expect(outputs).toEqual(original);
  });

  it('keeps sparse message categories even when the other category fills first', () => {
    useSessionStore.setState({ activeMainRepoSession: session() });
    const outputs: SessionOutput[] = [{
      sessionId: 'session-new', type: 'json', data: { type: 'user', text: 'initial prompt', timestamp: '' }, timestamp: '',
    }];
    for (let i = 0; i < 1000; i++) {
      outputs.push({ sessionId: 'session-new', type: 'stdout', data: `line-${i}`, timestamp: '' });
    }

    useSessionStore.getState().setSessionOutputs('session-new', outputs);

    const updated = useSessionStore.getState().activeMainRepoSession;
    expect(updated?.output).toEqual(Array.from({ length: 300 }, (_, i) => `line-${i + 700}`));
    expect(updated?.jsonMessages.map(message => message.text)).toEqual(['initial prompt']);
    useSessionStore.getState().setSessionOutputs('session-new', []);
    expect(useSessionStore.getState().activeMainRepoSession?.output).toEqual([]);
    expect(useSessionStore.getState().activeMainRepoSession?.jsonMessages).toEqual([]);
  });

  it('ignores history that arrives after its session has been deleted', () => {
    const before = useSessionStore.getState();
    const listener = vi.fn();
    const unsubscribe = useSessionStore.subscribe(listener);
    try {
      before.setSessionOutputs('deleted-session', [{ sessionId: 'deleted-session', type: 'stdout', data: 'late output', timestamp: '' }]);
      expect(useSessionStore.getState()).toBe(before);
      expect(listener).not.toHaveBeenCalled();
    } finally {
      unsubscribe();
    }
  });

  it('queues and flushes git status updates without mutating map snapshots', () => {
    const originalQueue = useSessionStore.getState().pendingGitStatusUpdates;
    const gitStatus: GitStatus = { state: 'modified', filesChanged: 2 };
    useSessionStore.setState({ sessions: [session({ id: 'session-status' })] });

    useSessionStore.getState().updateSessionGitStatus('session-status', gitStatus);

    const queuedState = useSessionStore.getState();
    expect(originalQueue.size).toBe(0);
    expect(queuedState.pendingGitStatusUpdates).not.toBe(originalQueue);
    expect(queuedState.pendingGitStatusUpdates.get('session-status')).toBe(gitStatus);

    const queuedSnapshot = queuedState.pendingGitStatusUpdates;
    vi.advanceTimersByTime(50);

    const flushedState = useSessionStore.getState();
    expect(queuedSnapshot.get('session-status')).toBe(gitStatus);
    expect(flushedState.pendingGitStatusUpdates).not.toBe(queuedSnapshot);
    expect(flushedState.pendingGitStatusUpdates.size).toBe(0);
    expect(flushedState.sessions[0].gitStatus).toEqual(gitStatus);
  });

  it('queues and flushes loading updates without mutating map snapshots', () => {
    const originalQueue = useSessionStore.getState().pendingGitStatusLoading;

    useSessionStore.getState().setGitStatusLoading('session-loading', true);

    const queuedState = useSessionStore.getState();
    expect(originalQueue.size).toBe(0);
    expect(queuedState.pendingGitStatusLoading).not.toBe(originalQueue);
    expect(queuedState.pendingGitStatusLoading.get('session-loading')).toBe(true);

    const queuedSnapshot = queuedState.pendingGitStatusLoading;
    vi.advanceTimersByTime(50);

    const flushedState = useSessionStore.getState();
    expect(queuedSnapshot.get('session-loading')).toBe(true);
    expect(flushedState.pendingGitStatusLoading).not.toBe(queuedSnapshot);
    expect(flushedState.pendingGitStatusLoading.size).toBe(0);
    expect(flushedState.gitStatusLoading.has('session-loading')).toBe(true);
  });
});
