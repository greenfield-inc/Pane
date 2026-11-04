import { describe, expect, it } from 'vitest';

import type { RemotePaneConnectionProfile } from '@shared/types/remoteDaemon';

import { isPushForPane, openHref, parseIncomingLink, parseNotifyPush, parsePushTarget, resolveOpenTarget } from './links';

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

  it('carries a Notify question id so the tap opens its sheet', () => {
    const request = {
      content: { title: 'api-fix', data: null },
      trigger: { type: 'push', payload: { eventId: 'notify:q1:ask:1', hostProfileId: work.id, notifyId: 'q1', paneId: 's1', sessionPaneId: 's1', panelId: 'p1', notifyUi: 'approve', aps: {} } },
    };
    expect(parsePushTarget(request)).toEqual({ host: work.id, notifyId: 'q1', paneId: 's1', panelId: 'p1' });
  });

  it('opens the host when the notification names no pane', () => {
    expect(parsePushTarget({ content: { data: { hostProfileId: work.id } }, trigger: null })).toEqual({ host: work.id });
  });
});

describe('parseNotifyPush', () => {
  it('reads an iPhone options alert with its choice labels', () => {
    const request = {
      content: { title: 'api-fix', body: 'api-fix has a question', data: null, categoryIdentifier: 'pane.notify.options' },
      trigger: {
        type: 'push',
        payload: {
          eventId: 'notify:q1:ask:1', hostProfileId: work.id, notifyId: 'q1', paneId: 's1', sessionPaneId: 's1', panelId: 'p1',
          notifyUi: 'options', notifyChoices: ['Ship it', 'Wait'],
          aps: { alert: { title: 'api-fix', body: 'api-fix has a question' }, sound: 'default', 'thread-id': 's1', category: 'pane.notify.options', 'mutable-content': 1 },
        },
      },
    };
    expect(parseNotifyPush(request)).toEqual({
      host: work.id, notifyId: 'q1', paneId: 's1', sessionPaneId: 's1', panelId: 'p1', ui: 'options', choices: ['Ship it', 'Wait'], clear: false,
    });
  });

  it('reads an Android data-only message from the background task', () => {
    const payload = {
      notification: null,
      data: {
        eventId: 'notify:q2:ask:1', hostProfileId: home.id, notifyId: 'q2', notifyUi: 'options', notifyTitle: 'docs', notifyBody: 'docs has a question',
        notifyTag: 'abc123', notifyChoices: '["Yes","No","Later"]',
      },
    };
    expect(parseNotifyPush(payload)).toEqual({
      host: home.id, notifyId: 'q2', ui: 'options', choices: ['Yes', 'No', 'Later'], title: 'docs', body: 'docs has a question', tag: 'abc123', clear: false,
    });
  });

  it('reads both platforms\' silent clear', () => {
    const ios = { data: { eventId: 'notify:q1:clear', hostProfileId: work.id, notifyId: 'q1', notifyClear: true, dataString: null }, aps: { 'content-available': 1 } };
    const android = { data: { eventId: 'notify:q2:clear', hostProfileId: home.id, notifyId: 'q2', notifyClear: '1', notifyTag: 'abc123' } };
    expect(parseNotifyPush(ios)).toMatchObject({ notifyId: 'q1', clear: true });
    expect(parseNotifyPush(android)).toMatchObject({ notifyId: 'q2', clear: true, tag: 'abc123' });
  });

  it('reads the alert behind a button press', () => {
    const response = {
      actionIdentifier: 'pane.notify.approve',
      notification: { request: { content: { data: null }, trigger: { type: 'push', payload: { hostProfileId: work.id, notifyId: 'q3', notifyUi: 'approve', aps: {} } } } },
    };
    expect(parseNotifyPush(response)).toEqual({ host: work.id, notifyId: 'q3', ui: 'approve', choices: [], clear: false });
  });

  it('reads an Android button press from the background task, whose data arrives as a JSON string', () => {
    const response = {
      actionIdentifier: 'choice.1',
      notification: { request: { identifier: 'q4', content: {
        title: 'Which table?',
        dataString: `{"hostProfileId":"${work.id}","notifyId":"q4","notifyUi":"options","notifyChoices":["users","orders"],"paneId":"s1"}`,
      } } },
    };
    expect(parseNotifyPush(response)).toEqual({ host: work.id, notifyId: 'q4', ui: 'options', choices: ['users', 'orders'], paneId: 's1', clear: false });
    expect(parsePushTarget(response.notification.request)).toEqual({ host: work.id, notifyId: 'q4', paneId: 's1' });
    expect(parseNotifyPush({ actionIdentifier: 'approve', userText: 'x', notification: { request: { identifier: 'q5', content: { dataString: '{oops' } } } })).toBeNull();
  });

  it('ignores alerts that are not Notify questions', () => {
    expect(parseNotifyPush({ content: { data: { hostProfileId: work.id, paneId: 's1' } }, trigger: null })).toBeNull();
    expect(parseNotifyPush({ data: { notifyId: 'q1' } })).toBeNull();
  });

  it('drops a malformed choice list instead of throwing', () => {
    expect(parseNotifyPush({ data: { hostProfileId: work.id, notifyId: 'q1', notifyChoices: '[oops' } })?.choices).toEqual([]);
  });
});

describe('isPushForPane', () => {
  const worker = { trigger: { type: 'push', payload: { hostProfileId: work.id, paneId: 'worker', sessionPaneId: 'session', aps: {} } } };

  it('matches an alert to its own Pane and to the Session it stacks under', () => {
    expect(isPushForPane(worker, 'worker')).toBe(true);
    expect(isPushForPane(worker, 'session')).toBe(true);
    expect(isPushForPane(worker, 'other')).toBe(false);
  });

  it('ignores notifications that are not from a Pane host', () => {
    expect(isPushForPane({ content: { data: { paneId: 'worker' } }, trigger: null }, 'worker')).toBe(false);
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

  it('keeps the Notify question the target names', () => {
    expect(resolveOpenTarget({ host: work.id, notifyId: 'q1', paneId: 's1' }, hosts)).toEqual({ type: 'open', hostId: work.id, switchHost: false, notifyId: 'q1', paneId: 's1' });
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
    expect(openHref({ host: home.id, notifyId: 'q1' })).toBe('/open?host=Home%3Ahttps%3A%2F%2Fhome.tail.ts.net%3Aefgh5678&notifyId=q1');
  });
});
