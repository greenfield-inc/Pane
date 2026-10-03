import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GitStatus, Session } from '../types/session';
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
