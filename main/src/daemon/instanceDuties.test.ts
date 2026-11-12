import { describe, expect, it } from 'vitest';
import { decideInstanceDuties } from './instanceDuties';

describe('decideInstanceDuties', () => {
  it('lets the installed Pane, or a headless daemon, that owns its data directory do everything', () => {
    expect(decideInstanceDuties({ ownsDataDirectory: true, isPackaged: true, mode: 'desktop' }))
      .toEqual({ housekeeping: true, remoteTransport: true, serveRefusal: null });
    expect(decideInstanceDuties({ ownsDataDirectory: true, isPackaged: false, mode: 'headless' }))
      .toEqual({ housekeeping: true, remoteTransport: true, serveRefusal: null });
  });

  it('keeps a development desktop build off Tailscale Serve, but lets it tidy its own data', () => {
    expect(decideInstanceDuties({ ownsDataDirectory: true, isPackaged: false, mode: 'desktop' }))
      .toEqual({ housekeeping: true, remoteTransport: true, serveRefusal: 'a development build never changes Tailscale Serve' });
  });

  it('gives a second Pane on a data directory another Pane serves no cleanup and no machine-wide changes', () => {
    for (const isPackaged of [true, false]) {
      expect(decideInstanceDuties({ ownsDataDirectory: false, isPackaged, mode: 'desktop' }))
        .toEqual({ housekeeping: false, remoteTransport: false, serveRefusal: 'another Pane already serves this data directory' });
    }
  });
});
