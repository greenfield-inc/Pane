import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentState } from '../../../shared/types/agentStatus';
import type { Session } from '../types/session';
import { usePanelStore } from './panelStore';
import { useSessionStore } from './sessionStore';
import { ATTENTION_INBOX_HOLD_MS, subscribeAttentionInbox, useAttentionInboxStore } from './attentionInboxStore';

const pane = (id: string, status: Session['status'] = 'running'): Session => ({
  id, name: id, worktreePath: `/tmp/${id}`, prompt: '', status, createdAt: '2026-10-09T00:00:00Z', output: [], jsonMessages: [],
});

const agent = (sessionId: string, state: AgentState) => usePanelStore.getState().setAgentStatus(`${sessionId}-panel`, sessionId, state);
const inbox = () => [...useAttentionInboxStore.getState().members].sort();
const settle = () => vi.advanceTimersByTime(ATTENTION_INBOX_HOLD_MS);

let stop: () => void;

beforeEach(() => {
  vi.useFakeTimers();
  usePanelStore.setState({ agentStatus: {}, agentStatusSession: {}, agentStatusSnapshotVersion: 0 });
  useSessionStore.setState({ sessions: [pane('a'), pane('b'), pane('c')], activeSessionId: null });
  useAttentionInboxStore.setState({ members: new Set(), marks: {} });
  stop = subscribeAttentionInbox();
});

afterEach(() => {
  stop();
  vi.useRealTimers();
});

describe('attention inbox', () => {
  it('holds a Pane whose agent finished until its agent works again, even after it is opened', () => {
    agent('a', 'working');
    agent('b', 'working');
    settle();
    expect(inbox()).toEqual([]);

    agent('a', 'idle');
    settle();
    expect(inbox()).toEqual(['a']);

    useSessionStore.setState({ activeSessionId: 'a' });
    settle();
    expect(inbox()).toEqual(['a']);

    agent('a', 'working');
    settle();
    expect(inbox()).toEqual([]);
  });

  it('shows Panes waiting on the user and Panes that errored, but not Panes idle since launch', () => {
    agent('a', 'blocked');
    agent('b', 'idle');
    useSessionStore.setState({ sessions: [pane('a'), pane('b'), pane('c', 'error')] });
    settle();
    expect(inbox()).toEqual(['a', 'c']);
  });

  it('ignores a waiting state shorter than the hold', () => {
    agent('a', 'working');
    settle();
    agent('a', 'blocked');
    vi.advanceTimersByTime(ATTENTION_INBOX_HOLD_MS - 100);
    expect(inbox()).toEqual([]);
    agent('a', 'working');
    settle();
    expect(inbox()).toEqual([]);
  });

  it('counts a turn that waited on the user midway as finished', () => {
    agent('a', 'working');
    agent('a', 'blocked');
    settle();
    agent('a', 'idle');
    settle();
    expect(inbox()).toEqual(['a']);
  });

  it('brings back a dismissed Pane when a second agent in it finishes a turn', () => {
    usePanelStore.getState().setAgentStatus('a-first', 'a', 'blocked');
    settle();
    useAttentionInboxStore.getState().dismiss('a');
    usePanelStore.getState().setAgentStatus('a-second', 'a', 'working');
    usePanelStore.getState().setAgentStatus('a-second', 'a', 'idle');
    settle();
    expect(inbox()).toEqual(['a']);
  });

  it('removes a dismissed Pane at once and brings it back when its agent finishes another turn', () => {
    agent('a', 'working');
    agent('a', 'idle');
    settle();
    expect(inbox()).toEqual(['a']);

    useAttentionInboxStore.getState().dismiss('a');
    expect(inbox()).toEqual([]);

    agent('a', 'working');
    settle();
    agent('a', 'idle');
    settle();
    expect(inbox()).toEqual(['a']);
  });
});
