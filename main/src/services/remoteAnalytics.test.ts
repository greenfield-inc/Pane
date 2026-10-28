import { describe, expect, it } from 'vitest';
import { trackRemotePaneEvent, type RemotePaneAnalyticsProperties } from './remoteAnalytics';

function tracked(properties: RemotePaneAnalyticsProperties): object {
  const sent: object[] = [];
  trackRemotePaneEvent({ track: (_name, payload) => { sent.push(payload ?? {}); } }, 'remote_pane_client_connection_failed', properties);
  return sent[0];
}

describe('remote analytics failed_check', () => {
  it('keeps a known checklist stage and drops anything else', () => {
    expect(tracked({ failure_stage: 'connection_check', failed_check: 'pane_not_running' })).toMatchObject({ failed_check: 'pane_not_running' });
    // SAFETY: a value from outside the enum, as a caller with a stale type could send.
    expect(tracked({ failed_check: 'devbox.tail1.ts.net' as RemotePaneAnalyticsProperties['failed_check'] })).toMatchObject({ failed_check: undefined });
  });
});
