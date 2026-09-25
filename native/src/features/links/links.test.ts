import { describe, expect, it } from 'vitest';

import type { RemotePaneConnectionProfile } from '@shared/types/remoteDaemon';

import { openHref, parseIncomingLink, parsePushTarget, resolveOpenTarget } from './links';

const work: RemotePaneConnectionProfile = { id: 'Work Mac:http://127.0.0.1:42157:abcd1234', label: 'Work Mac', baseUrl: 'http://127.0.0.1:42157', token: 't', transport: 'http+sse' };
const home: RemotePaneConnectionProfile = { id: 'Home:https://home.tail.ts.net:efgh5678', label: 'Home', baseUrl: 'https://home.tail.ts.net', token: 't', transport: 'http+sse' };

describe('parsePushTarget', () => {
  // Shape of an APNs alert sent by main/src/daemon/mobilePushSender.ts. The
  // routing keys sit beside `aps`, so expo-notifications only exposes them in
  // trigger.payload (content.data is userInfo.body, which Pane never sends).
  it('reads the routing keys of an iOS remote notification', () => {
    const request = {
      content: { title: 'Pane needs attention', data: null },
      trigger: {
        type: 'push',
        payload: {
          eventId: 'pane:s1:p1:needs-input:3', hostProfileId: work.id, paneId: 's1', panelId: 'p1',
          aps: { alert: { title: 'Pane needs attention', body: 'Open Pane to continue.' }, sound: 'default' },
        },
      },
    };
    expect(parsePushTarget(request)).toEqual({ host: work.id, paneId: 's1', panelId: 'p1' });
  });

  it('reads the data of an Android FCM notification', () => {
    const request = {
      content: { title: 'Pane finished a turn', data: {} },
      trigger: { type: 'push', remoteMessage: { data: { eventId: 'e', hostProfileId: home.id, paneId: 's2', panelId: 'p2' } } },
    };
    expect(parsePushTarget(request)).toEqual({ host: home.id, paneId: 's2', panelId: 'p2' });
  });

  it('falls back to content.data', () => {
    const request = { content: { data: { eventId: 'e', hostProfileId: home.id, paneId: 's2' } }, trigger: null };
    expect(parsePushTarget(request)).toEqual({ host: home.id, paneId: 's2' });
  });

  it('ignores notifications that are not from a Pane host', () => {
    expect(parsePushTarget({ content: { data: { url: 'https://example.com' } }, trigger: { type: 'push', payload: { aps: {} } } })).toBeNull();
    expect(parsePushTarget({ content: { data: { hostProfileId: 42 } }, trigger: null })).toBeNull();
    expect(parsePushTarget(null)).toBeNull();
  });

  it('opens the host when the notification names no pane', () => {
    expect(parsePushTarget({ content: { data: { hostProfileId: work.id } }, trigger: null })).toEqual({ host: work.id });
  });
});

describe('parseIncomingLink', () => {
  it('opens a pane on a named host', () => {
    expect(parseIncomingLink('pane://pane/s1?host=https%3A%2F%2Fhome.tail.ts.net&panel=p1'))
      .toEqual({ type: 'open', target: { host: 'https://home.tail.ts.net', paneId: 's1', panelId: 'p1' } });
  });

  it('leaves a pane link without a host to the router', () => {
    expect(parseIncomingLink('pane://pane/s1')).toEqual({ type: 'route' });
    expect(parseIncomingLink('/pane/s1')).toEqual({ type: 'route' });
  });

  it('leaves a malformed pane link to the router instead of throwing', () => {
    expect(parseIncomingLink('pane://pane/%E0?host=x')).toEqual({ type: 'route' });
  });

  it('leaves other links alone', () => {
    expect(parseIncomingLink('pane-remote://eyJhIjoxfQ')).toEqual({ type: 'route' });
    expect(parseIncomingLink('pane://settings')).toEqual({ type: 'route' });
    expect(parseIncomingLink('exp+pane://expo-development-client/?url=http%3A%2F%2F127.0.0.1%3A8143')).toEqual({ type: 'route' });
  });
});

describe('resolveOpenTarget', () => {
  const hosts = { profiles: [work, home], activeId: work.id };

  it('opens a pane on the active host in place', () => {
    expect(resolveOpenTarget({ host: work.id, paneId: 's1' }, hosts)).toEqual({ type: 'open', hostId: work.id, switchHost: false, paneId: 's1' });
  });

  it('switches to the saved host the target names, by profile id or URL', () => {
    expect(resolveOpenTarget({ host: home.id, paneId: 's2', panelId: 'p2' }, hosts))
      .toEqual({ type: 'open', hostId: home.id, switchHost: true, paneId: 's2', panelId: 'p2' });
    expect(resolveOpenTarget({ host: 'https://home.tail.ts.net/', paneId: 's2' }, hosts))
      .toEqual({ type: 'open', hostId: home.id, switchHost: true, paneId: 's2' });
  });

  it('never connects to a host this phone has not paired with', () => {
    expect(resolveOpenTarget({ host: 'Other:https://evil.example:zzzz', paneId: 's1' }, hosts)).toEqual({ type: 'unknown-host' });
    expect(resolveOpenTarget({ host: work.id, paneId: 's1' }, { profiles: [], activeId: null })).toEqual({ type: 'unknown-host' });
  });
});

describe('openHref', () => {
  it('encodes a profile id, which holds a label and a URL', () => {
    expect(openHref({ host: work.id, paneId: 's1', panelId: 'p1' }))
      .toBe('/open?host=Work%20Mac%3Ahttp%3A%2F%2F127.0.0.1%3A42157%3Aabcd1234&paneId=s1&panelId=p1');
    expect(openHref({ host: home.id })).toBe('/open?host=Home%3Ahttps%3A%2F%2Fhome.tail.ts.net%3Aefgh5678');
  });
});
