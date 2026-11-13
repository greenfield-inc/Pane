import { describe, expect, it, vi } from 'vitest';
import type { RemoteDaemonEventEnvelope } from '../../../../shared/types/remoteDaemon';
import type { JsonValue } from '../../../../shared/validation/boundaryDecoder';
import { watchPanePullRequest, type PanePullRequestSource } from './panePullRequest';

function fakeHost() {
  const listeners = new Set<(event: RemoteDaemonEventEnvelope) => void>();
  const source: PanePullRequestSource = {
    gitStatus: vi.fn(async (): Promise<JsonValue | undefined> => undefined),
    onEvent: listener => { listeners.add(listener); return () => listeners.delete(listener); },
  };
  const emit = (channel: string, payload: JsonValue) => listeners.forEach(listener => listener({ channel, args: [payload], timestamp: '2026-11-08T23:40:00.000Z' }));
  return { source, emit, listeners };
}

describe('watchPanePullRequest (review F-3)', () => {
  it('shows the PR from the status read\'s reply on first load, without waiting for an event (QA of F-3)', async () => {
    const host = fakeHost();
    host.source.gitStatus = vi.fn(async (): Promise<JsonValue | undefined> => ({ state: 'clean', prNumber: 42, prUrl: 'https://example.invalid/demo/pull/42', prState: 'OPEN' }));
    const seen: unknown[] = [];
    watchPanePullRequest(host.source, 'pane-1', pr => seen.push(pr));
    await vi.waitFor(() => expect(seen).toEqual([{ number: 42, url: 'https://example.invalid/demo/pull/42', state: 'OPEN' }]));
  });

  it('drops a reply that arrives after a newer event', async () => {
    const host = fakeHost();
    let reply: (status: JsonValue | undefined) => void = () => {};
    host.source.gitStatus = vi.fn(() => new Promise<JsonValue | undefined>(resolve => { reply = resolve; }));
    const seen: unknown[] = [];
    watchPanePullRequest(host.source, 'pane-1', pr => seen.push(pr));
    host.emit('git-status-updated', { sessionId: 'pane-1', gitStatus: { prNumber: 7 } });
    reply({ prNumber: 3 });
    await Promise.resolve();
    expect(seen).toEqual([{ number: 7 }]);
  });

  it('asks the host for the Pane\'s git status now, then follows its PR from git-status-updated', () => {
    const host = fakeHost();
    const seen: unknown[] = [];
    const stop = watchPanePullRequest(host.source, 'pane-1', pr => seen.push(pr));
    expect(host.source.gitStatus).toHaveBeenCalledWith('pane-1');
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
    host.source.gitStatus = vi.fn(async (): Promise<JsonValue | undefined> => { throw new Error('offline'); });
    const seen: unknown[] = [];
    watchPanePullRequest(host.source, 'pane-1', pr => seen.push(pr));
    host.emit('git-status-updated', { gitStatus: { prNumber: 1 } });
    await Promise.resolve();
    expect(seen).toEqual([]);
  });
});
