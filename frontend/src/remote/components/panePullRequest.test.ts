import { describe, expect, it, vi } from 'vitest';
import type { RemoteDaemonEventEnvelope } from '../../../../shared/types/remoteDaemon';
import type { JsonValue } from '../../../../shared/validation/boundaryDecoder';
import { watchPanePullRequest, type PanePullRequestSource } from './panePullRequest';

function fakeHost() {
  const listeners = new Set<(event: RemoteDaemonEventEnvelope) => void>();
  const source: PanePullRequestSource = {
    invoke: vi.fn(async () => undefined),
    onEvent: listener => { listeners.add(listener); return () => listeners.delete(listener); },
  };
  const emit = (channel: string, payload: JsonValue) => listeners.forEach(listener => listener({ channel, args: [payload], timestamp: '2026-11-08T23:40:00.000Z' }));
  return { source, emit, listeners };
}

describe('watchPanePullRequest (review F-3)', () => {
  it('asks the host for the Pane\'s git status now, then follows its PR from git-status-updated', () => {
    const host = fakeHost();
    const seen: unknown[] = [];
    const stop = watchPanePullRequest(host.source, 'pane-1', pr => seen.push(pr));
    expect(host.source.invoke).toHaveBeenCalledWith('sessions:get-git-status', ['pane-1', true]);
    host.emit('git-status-updated', { sessionId: 'pane-2', gitStatus: { prNumber: 9 } });
    host.emit('git-status-loading', { sessionId: 'pane-1' });
    host.emit('git-status-updated', { sessionId: 'pane-1', gitStatus: { state: 'clean', prNumber: 1277, prUrl: 'https://github.com/greenfield-inc/Pane/pull/1277', prState: 'OPEN', prIsDraft: false } });
    host.emit('git-status-updated', { sessionId: 'pane-1', gitStatus: { state: 'clean' } });
    expect(seen).toEqual([{ number: 1277, url: 'https://github.com/greenfield-inc/Pane/pull/1277', state: 'OPEN', draft: false }, undefined]);
    stop();
    expect(host.listeners.size).toBe(0);
  });

  it('ignores a malformed event and survives a refused status read', async () => {
    const host = fakeHost();
    host.source.invoke = vi.fn(async () => { throw new Error('offline'); });
    const seen: unknown[] = [];
    watchPanePullRequest(host.source, 'pane-1', pr => seen.push(pr));
    host.emit('git-status-updated', { gitStatus: { prNumber: 1 } });
    await Promise.resolve();
    expect(seen).toEqual([]);
  });
});
