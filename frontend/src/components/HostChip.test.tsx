import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { HostChip } from './HostChip';
import type { ActiveHost } from '../utils/hostRepoActions';

describe('HostChip', () => {
  it.each<[ActiveHost, string]>([
    [{ id: null, remote: false, name: 'This computer', kindLabel: null, icon: 'local' }, 'On: This computer'],
    [{ id: 'devbox', remote: true, name: 'devbox', kindLabel: 'remote host', icon: 'server' }, 'On: devbox (remote host)'],
    [{ id: 'sandbox-1', remote: true, name: 'sandbox-1', kindLabel: 'cloud sandbox', icon: 'cloud' }, 'On: sandbox-1 (cloud sandbox)'],
  ])('says which host the dialog acts on: %s', (host, text) => {
    const markup = renderToStaticMarkup(<HostChip host={host} />);
    expect(markup).toContain(`>${text}<`);
    expect(markup).toContain(`data-host-icon="${host.icon}"`);
  });
});
