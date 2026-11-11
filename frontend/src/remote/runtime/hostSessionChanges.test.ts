import { describe, expect, it } from 'vitest';
import type { RemoteDaemonEventEnvelope } from '../../../../shared/types/remoteDaemon';
import { watchHostSessionChanges, type HostSessionChangeSource } from './hostSessionChanges';

function fakeHost(initial: string) {
  const events = new Set<(event: RemoteDaemonEventEnvelope) => void>();
  const statuses = new Set<(state: { status: string }) => void>();
  const host: HostSessionChangeSource = {
    onEvent: listener => { events.add(listener); return () => events.delete(listener); },
    // Like the client, the status is sent at once on subscribe.
    onStatus: listener => { statuses.add(listener); listener({ status: initial }); return () => statuses.delete(listener); },
  };
  return {
    host,
    event: (channel: string, detail: Record<string, string>) => events.forEach(listener => listener({ channel, args: [detail], timestamp: '2026-11-10T00:00:00.000Z' })),
    status: (status: string) => statuses.forEach(listener => listener({ status })),
    size: () => events.size + statuses.size,
  };
}

describe('watchHostSessionChanges (review F-3 follow-up on #1281)', () => {
  it('names the changed Session, and heartbeats while connected call back with nothing', () => {
    const fake = fakeHost('connected');
    const seen: Array<string | undefined> = [];
    const stop = watchHostSessionChanges(fake.host, sessionId => seen.push(sessionId));
    fake.event('orchestration-sessions:overview-updated', { panelId: 'p1', sessionId: 's2', state: 'working' });
    // The client re-sends "connected" for every heartbeat and last-seen update.
    fake.status('connected'); fake.status('connected');
    fake.event('orchestration-sessions:changed', { sessionId: 's1', kind: 'report' });
    fake.event('panel:agentStatus', { panelId: 'p1', sessionId: 'pane', state: 'idle' });
    expect(seen).toEqual(['s2', 's1']);
    stop();
    expect(fake.size()).toBe(0);
  });

  it('calls back for every Session only on a return to connected', () => {
    const fake = fakeHost('connecting');
    const seen: Array<string | undefined> = [];
    watchHostSessionChanges(fake.host, sessionId => seen.push(sessionId));
    fake.status('connected');
    fake.status('connected');
    fake.status('reconnecting');
    fake.status('connected');
    expect(seen).toEqual([undefined, undefined]);
  });
});
