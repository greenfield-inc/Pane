import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { RemotePaneConnectionProfile } from '../../../../shared/types/remoteDaemon';
import { RelayConnectionBar } from './RelayConnectionBar';
import { RemoteStatusBar } from './RemoteStatusBar';

const RELAY: RemotePaneConnectionProfile = {
  id: 'relay:abc', label: 'Studio Mac', baseUrl: 'https://abc.runpane.net', token: 't', transport: 'http+sse',
  relay: { computerId: 'abc', fingerprint: 'fp' },
};
const noop = () => undefined;

describe('the browser app after its computer removed it', () => {
  // What a read in flight reports when the client stops on the refused token.
  const lastError = 'signal is aborted without reason';

  it('says the computer removed this device and to scan a new code there', () => {
    const markup = renderToStaticMarkup(<RelayConnectionBar profile={RELAY} status="error" lastError={lastError} />);
    expect(markup).toContain('Studio Mac removed this device. To use it again, scan a new code on Studio Mac.');
  });

  it('keeps the raw reason and Retry out of the header', () => {
    const markup = renderToStaticMarkup(
      <RemoteStatusBar profile={RELAY} openName="fix-login" status="error" lastError={lastError} lastSeenAt={null}
        onDisconnect={noop} onRetry={noop} onOpenSidebar={noop} />,
    );
    expect(markup).not.toContain(lastError);
    expect(markup).not.toContain('Retry now');
  });
});
