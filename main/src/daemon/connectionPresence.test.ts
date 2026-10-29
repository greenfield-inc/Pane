import { describe, expect, it } from 'vitest';
import { connectionNotice, connectionPresence } from '../../../shared/remoteClient';

describe('connectionPresence', () => {
  it('shows a short outage as reconnecting, without a message', () => {
    expect(connectionPresence('reconnecting', 9_999)).toBe('reconnecting');
    expect(connectionPresence('connecting', 0)).toBe('reconnecting');
    expect(connectionPresence('restoring', 2_000)).toBe('reconnecting');
    expect(connectionNotice({ status: 'reconnecting', lastError: 'socket closed' }, 9_999, 'Studio Mac')).toBeNull();
  });

  it("says it can't reach the machine once the outage reaches 10 seconds", () => {
    expect(connectionPresence('reconnecting', 10_000)).toBe('unreachable');
    expect(connectionNotice({ status: 'reconnecting', lastError: 'socket closed' }, 10_000, 'Studio Mac'))
      .toEqual({ message: "Can't reach Studio Mac. Retrying…", canRetry: true });
  });

  it('keeps saying reconnecting while a machine that answered is still restoring', () => {
    expect(connectionPresence('restoring', 25_000)).toBe('restoring');
    expect(connectionNotice({ status: 'restoring', lastError: null }, 25_000, 'Studio Mac'))
      .toEqual({ message: 'Reconnecting to Studio Mac…', canRetry: false });
  });

  it('reports a rejected connection code at once', () => {
    const rejected = 'This connection code is not accepted by the remote host. Create a new code in Pane Settings > Remote Access > Set Up Host, then reconnect.';
    expect(connectionPresence('error', 0)).toBe('unreachable');
    expect(connectionNotice({ status: 'error', lastError: rejected }, 0, 'Studio Mac'))
      .toEqual({ message: rejected, canRetry: true });
  });

  it('stops saying it is retrying after the client gave up', () => {
    expect(connectionNotice({
      status: 'error',
      lastError: 'Could not reconnect within five minutes. Your workspace is kept. Choose Retry now.',
    }, 300_000, 'Studio Mac')).toEqual({ message: "Can't reach Studio Mac.", canRetry: true });
  });

  it('shows nothing while connected', () => {
    expect(connectionPresence('connected', 0)).toBe('connected');
    expect(connectionNotice({ status: 'connected', lastError: null }, 0, 'Studio Mac')).toBeNull();
  });
});
