import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PanelAgentStatusEvent } from '../../../shared/types/agentStatus';
import { usePanelStore } from '../stores/panelStore';
import { subscribePanelStatus } from './panelStatusSync';
import { useSessionStore } from '../stores/sessionStore';
import type { JsonValue } from '../../../shared/validation/boundaryDecoder';

let status: (event: PanelAgentStatusEvent) => void;
let deleted: (event: { panelId: string; sessionId: string }) => void;
let resync: () => void;
let replies: Array<(value: JsonValue) => void>;
let cleanup: () => void;

const snapshot = (state: string) => ({ success: true, data: [{ sessionId: 's', panelId: 'p', state }] });
const event = (state: PanelAgentStatusEvent['state']) => ({ panelId: 'p', sessionId: 's', state, reason: null });
const flush = () => new Promise(resolve => setTimeout(resolve, 0));

beforeEach(() => {
  usePanelStore.setState({ panels: {}, activityStatus: {}, agentStatus: {}, agentStatusSession: {}, unviewedCompletedActivity: {}, agentStatusSnapshotVersion: 0 });
  useSessionStore.setState({ activeSessionId: 'foreground' });
  replies = [];
  vi.stubGlobal('window', { electronAPI: {
    invoke: vi.fn(() => new Promise(resolve => replies.push(resolve))),
    events: {
      onPanelAgentStatus: (callback: typeof status) => { status = callback; return vi.fn(); },
      onPanelDeleted: (callback: typeof deleted) => { deleted = callback; return vi.fn(); },
      onRemoteDaemonResyncRequested: (callback: typeof resync) => { resync = callback; return vi.fn(); },
    },
  } });
  cleanup = subscribePanelStatus();
});

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('panel status synchronization', () => {
  it('hydrates an already-running background panel and repairs a missed transition on reconnect', async () => {
    replies[0](snapshot('working'));
    await flush();
    expect(usePanelStore.getState().getSessionAgentState('s')).toBe('working');
    expect(usePanelStore.getState().getPanelActivityStatus('p')).toBe('active');
    resync();
    replies[1](snapshot('idle'));
    await flush();
    expect(usePanelStore.getState().getPanelAgentState('p')).toBe('idle');
    expect(usePanelStore.getState().getSessionAgentState('s')).toBe('idle');
    expect(usePanelStore.getState().getPanelActivityStatus('p')).toBe('idle');
    expect(usePanelStore.getState().hasUnviewedCompletedActivity('s')).toBe(false);
    expect(usePanelStore.getState().agentStatusSnapshotVersion).toBe(2);
  });

  it('keeps newer events over an older snapshot, including repeated same-state events', async () => {
    status(event('working'));
    replies[0](snapshot('idle'));
    await flush();
    expect(usePanelStore.getState().getPanelAgentState('p')).toBe('working');
    resync();
    status(event('working'));
    replies[1](snapshot('blocked'));
    await flush();
    expect(usePanelStore.getState().getPanelAgentState('p')).toBe('working');
  });

  it('removes a background panel and ignores its late exit and pending snapshot', async () => {
    status(event('working'));
    deleted({ panelId: 'p', sessionId: 's' });
    status({ ...event('idle'), reason: 'exit' });
    replies[0](snapshot('working'));
    await flush();
    expect(usePanelStore.getState().getPanelAgentState('p')).toBeUndefined();
    expect(usePanelStore.getState().getSessionAgentState('s')).toBe('unknown');
    expect(usePanelStore.getState().hasUnviewedCompletedActivity('s')).toBe(false);
  });

  it('prunes statuses missing from a successful snapshot', async () => {
    replies[0](snapshot('working'));
    await flush();
    resync();
    replies[1]({ success: true, data: [] });
    await flush();
    expect(usePanelStore.getState().getPanelAgentState('p')).toBeUndefined();
  });

  it('ignores obsolete requests and replies after unsubscription', async () => {
    resync();
    replies[1](snapshot('idle'));
    await flush();
    replies[0](snapshot('working'));
    await flush();
    expect(usePanelStore.getState().getPanelAgentState('p')).toBe('idle');
    resync();
    cleanup();
    replies[2](snapshot('working'));
    await flush();
    expect(usePanelStore.getState().getPanelAgentState('p')).toBe('idle');
  });

  it('allows a new snapshot to restore an ID recreated while disconnected', async () => {
    deleted({ panelId: 'p', sessionId: 's' });
    replies[0](snapshot('working'));
    await flush();
    resync();
    replies[1](snapshot('idle'));
    await flush();
    status(event('working'));
    expect(usePanelStore.getState().getPanelAgentState('p')).toBe('working');
  });

  it('keeps known status if snapshot validation fails', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    status(event('working'));
    replies[0]({ ok: false });
    await flush();
    expect(usePanelStore.getState().getPanelAgentState('p')).toBe('working');
    expect(error).toHaveBeenCalledOnce();
    error.mockRestore();
  });

  it.each(['exit', 'destroyed'])('silently clears working state on %s before panel deletion', async reason => {
    replies[0](snapshot('working'));
    await flush();
    const baseline = usePanelStore.getState().agentStatusSnapshotVersion;
    status({ ...event('idle'), reason });
    expect(usePanelStore.getState().getPanelAgentState('p')).toBe('idle');
    expect(usePanelStore.getState().hasUnviewedCompletedActivity('s')).toBe(false);
    expect(usePanelStore.getState().agentStatusSnapshotVersion).toBe(baseline + 1);
    // The next lifetime can still produce a real completion.
    status(event('working'));
    status(event('idle'));
    expect(usePanelStore.getState().hasUnviewedCompletedActivity('s')).toBe(true);
  });

  it('marks real live completion unseen after hydration', async () => {
    replies[0](snapshot('idle'));
    await flush();
    status(event('working'));
    status(event('idle'));
    expect(usePanelStore.getState().hasUnviewedCompletedActivity('s')).toBe(true);
  });
});
