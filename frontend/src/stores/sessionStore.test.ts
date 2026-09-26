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
    vi.unstubAllGlobals();
  });

  it('keeps main-repository updates when switching away and back', async () => {
    vi.stubGlobal('window', { dispatchEvent: vi.fn(), electronAPI: {
      invoke: async () => undefined,
      sessions: { markViewed: async () => ({success: true}) },
    } });
    const main = session({id: 'main', isMainRepo: true, name: 'Old name'});
    useSessionStore.setState({sessions: [main, session({id: 'other'})], activeMainRepoSession: main, activeSessionId: 'main'});
    useSessionStore.getState().updateSession({...main, name: 'Updated name', gitStatus: undefined});
    await useSessionStore.getState().setActiveSession('other');
    await useSessionStore.getState().setActiveSession('main');
    expect(useSessionStore.getState().activeMainRepoSession?.name).toBe('Updated name');
    expect(useSessionStore.getState().sessions.find(pane => pane.id === 'main')?.name).toBe('Updated name');
  });

  it('marks a fetched pane viewed when selecting it for the first time', async () => {
    const viewed = vi.fn(async () => ({success: true}));
    vi.stubGlobal('window', { dispatchEvent: vi.fn(), electronAPI: {
      invoke: async () => undefined,
      sessions: { get: async () => ({success: true, data: session({id: 'fetched'})}), markViewed: viewed },
    } });
    await useSessionStore.getState().setActiveSession('fetched');
    expect(viewed).toHaveBeenCalledWith('fetched');
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
