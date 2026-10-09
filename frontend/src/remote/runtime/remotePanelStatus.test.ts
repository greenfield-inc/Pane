import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RemoteDaemonEventEnvelope } from '../../../../shared/types/remoteDaemon';
import type { JsonValue } from '../../../../shared/validation/boundaryDecoder';
import { usePanelStore } from '../../stores/panelStore';
import { useRemoteSessionStore } from '../stores/remoteSessionStore';
import type { RemoteBrowserConnectionState } from './remoteDaemonBrowserClient';
import { subscribeRemotePanelStatus } from './remotePanelStatus';

type Reply = (value: JsonValue) => void;

let emit: (event: RemoteDaemonEventEnvelope) => void;
let setConnection: (status: RemoteBrowserConnectionState['status']) => void;
let replies: Reply[];
let cleanup: () => void;

const statusEvent = (panelId: string, sessionId: string, state: string): RemoteDaemonEventEnvelope => ({
  channel: 'panel:agentStatus',
  args: [{ panelId, sessionId, state, reason: null }],
  timestamp: '2026-10-08T00:00:00.000Z',
});
const flush = () => new Promise(resolve => setTimeout(resolve, 0));
const paneStatus = (sessionId: string) => usePanelStore.getState().getSessionAgentState(sessionId);
const isDone = (sessionId: string) => usePanelStore.getState().hasUnviewedCompletedActivity(sessionId);

// Like the real client, the adapter reports its current connection on subscribe.
function subscribe(initial: RemoteBrowserConnectionState['status']) {
  replies = [];
  const listeners: Array<typeof emit> = [];
  emit = event => listeners.forEach(listener => listener(event));
  const adapter = {
    onEvent: (listener: typeof emit) => { listeners.push(listener); return vi.fn(); },
    onStatus: (listener: (state: RemoteBrowserConnectionState) => void) => {
      setConnection = status => listener({ status, lastError: null, lastSeenAt: null });
      setConnection(initial);
      return vi.fn();
    },
    // The adapter unwraps the host's { success, data } envelope.
    invoke: vi.fn((): Promise<JsonValue> => new Promise(resolve => replies.push(resolve))),
  };
  cleanup = subscribeRemotePanelStatus(adapter);
}

beforeEach(() => {
  usePanelStore.setState({ agentStatus: {}, agentStatusSession: {}, activityStatus: {}, unviewedCompletedActivity: {} });
  useRemoteSessionStore.getState().reset();
  useRemoteSessionStore.getState().selectSession('P');
  subscribe('connected');
});

afterEach(() => cleanup());

describe('remote panel status', () => {
  it('shows a Pane that was already blocked before any status event arrives', async () => {
    replies[0]([{ sessionId: 'P', panelId: 'p1', state: 'blocked' }]);
    await flush();
    expect(paneStatus('P')).toBe('blocked');
  });

  it('keeps a live event that arrives while the baseline is being read', async () => {
    emit(statusEvent('p1', 'P', 'working'));
    replies[0]([{ sessionId: 'P', panelId: 'p1', state: 'blocked' }]);
    await flush();
    expect(paneStatus('P')).toBe('working');
  });

  it('rereads the baseline after the stream drops, so a missed change shows without a reload', async () => {
    setConnection('connected');
    replies[0]([{ sessionId: 'P', panelId: 'p1', state: 'blocked' }]);
    await flush();
    setConnection('reconnecting');
    setConnection('connected');
    replies[1]([{ sessionId: 'P', panelId: 'p1', state: 'idle' }]);
    await flush();
    expect(paneStatus('P')).toBe('idle');
  });

  it('rereads the baseline once the first stream opens, so a change before it opened shows', async () => {
    cleanup();
    subscribe('connecting');
    replies[0]([{ sessionId: 'P', panelId: 'p1', state: 'working' }]);
    await flush();
    setConnection('connected');
    replies[1]([{ sessionId: 'P', panelId: 'p1', state: 'blocked' }]);
    await flush();
    expect(paneStatus('P')).toBe('blocked');
  });

  it('marks a Pane done only on a client that was elsewhere, until that client opens it', async () => {
    replies[0]([]);
    await flush();
    emit(statusEvent('q1', 'Q', 'working'));
    emit(statusEvent('p1', 'P', 'working'));
    emit(statusEvent('q1', 'Q', 'idle'));
    emit(statusEvent('p1', 'P', 'idle'));
    expect(isDone('Q')).toBe(true);
    expect(isDone('P')).toBe(false);
    useRemoteSessionStore.getState().selectSession('Q');
    expect(isDone('Q')).toBe(false);
  });

  it('forgets the previous host when the client disconnects', async () => {
    replies[0]([{ sessionId: 'P', panelId: 'p1', state: 'working' }]);
    await flush();
    cleanup();
    expect(paneStatus('P')).toBe('unknown');
  });
});
