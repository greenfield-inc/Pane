import { describe, expect, it, vi } from 'vitest';

import type { RemoteFetch } from '@shared/remoteClient';
import type { RemotePaneConnectionProfile } from '@shared/types/remoteDaemon';

import type { NotifyPush } from '@/features/links/links';

import { commandForAction, notifyCategories, optionsCategory, sendNotifyCommand, type NotifySender } from './notifyActions';

const work: RemotePaneConnectionProfile = { id: 'Work Mac:http://127.0.0.1:42157:abcd1234', label: 'Work Mac', baseUrl: 'http://127.0.0.1:42157', token: 'secret', transport: 'http+sse' };
const options: NotifyPush = { host: work.id, notifyId: 'q1', ui: 'options', choices: ['Ship it', 'Wait', 'Cancel'], clear: false };

describe('notifyCategories', () => {
  it('offers Approve and Deny, with Deny destructive, and Reply with a text field; none needs an unlock', () => {
    expect(notifyCategories(false)).toEqual([
      {
        identifier: 'pane.notify.approve',
        actions: [
          { identifier: 'approve', buttonTitle: 'Approve', options: { opensAppToForeground: false, isAuthenticationRequired: false } },
          { identifier: 'deny', buttonTitle: 'Deny', options: { opensAppToForeground: false, isAuthenticationRequired: false, isDestructive: true } },
        ],
      },
      {
        identifier: 'pane.notify.ask',
        actions: [{
          identifier: 'reply', buttonTitle: 'Reply', textInput: { submitButtonTitle: 'Send', placeholder: 'Your answer' },
          options: { opensAppToForeground: false, isAuthenticationRequired: false },
        }],
      },
    ]);
  });

  it('opens the app from every button under the D-13 fallback', () => {
    const actions = notifyCategories(true).flatMap(category => category.actions);
    expect(actions.every(action => action.options?.opensAppToForeground === true)).toBe(true);
  });
});

describe('optionsCategory', () => {
  it('labels one button per choice, at most three, under the question\'s own category', () => {
    expect(optionsCategory('q1', ['Ship it', 'Wait', 'Cancel', 'Later'], false)).toEqual({
      identifier: 'pane.notify.options.q1',
      actions: [
        { identifier: 'choice.0', buttonTitle: 'Ship it', options: { opensAppToForeground: false, isAuthenticationRequired: false } },
        { identifier: 'choice.1', buttonTitle: 'Wait', options: { opensAppToForeground: false, isAuthenticationRequired: false } },
        { identifier: 'choice.2', buttonTitle: 'Cancel', options: { opensAppToForeground: false, isAuthenticationRequired: false } },
      ],
    });
  });
});

describe('commandForAction', () => {
  const approve: NotifyPush = { host: work.id, notifyId: 'q2', ui: 'approve', choices: [], clear: false };
  const ask: NotifyPush = { host: work.id, notifyId: 'q3', ui: 'ask', choices: [], clear: false };

  it('turns Approve and Deny into an approval answer', () => {
    expect(commandForAction(approve, 'approve')).toEqual({ type: 'answer', id: 'q2', answer: { approved: true } });
    expect(commandForAction(approve, 'deny')).toEqual({ type: 'answer', id: 'q2', answer: { approved: false } });
  });

  it('sends the label of the choice pressed', () => {
    expect(commandForAction(options, 'choice.1')).toEqual({ type: 'answer', id: 'q1', answer: { choice: 'Wait' } });
    expect(commandForAction(options, 'choice.7')).toBeNull();
  });

  it('sends a typed reply, trimmed, and nothing for an empty one', () => {
    expect(commandForAction(ask, 'reply', '  use main  ')).toEqual({ type: 'answer', id: 'q3', answer: { text: 'use main' } });
    expect(commandForAction(ask, 'reply', '   ')).toBeNull();
  });

  it('leaves a plain tap to the sheet', () => {
    expect(commandForAction(approve, 'expo.modules.notifications.actions.DEFAULT')).toBeNull();
  });
});

describe('sendNotifyCommand', () => {
  const sender = (fetch: RemoteFetch): NotifySender => ({ fetch, runtimeId: 'pane-native-1', clientLabel: 'Pane for iOS', deviceLabel: 'Parsa’s iPhone' });
  const reply = (status: number, body: unknown): RemoteFetch => vi.fn(async () => ({ ok: status < 300, status, body: null, json: async () => body as never }));

  it('posts the command to /invoke with this phone\'s identity and the token in a header', async () => {
    const fetch = reply(200, { ok: true, result: null });
    await expect(sendNotifyCommand(sender(fetch), work, { type: 'answer', id: 'q1', answer: { choice: 'Wait' } })).resolves.toEqual({ sent: true });
    expect(fetch).toHaveBeenCalledWith('http://127.0.0.1:42157/invoke', expect.objectContaining({
      method: 'POST',
      headers: {
        Authorization: 'Bearer secret',
        'X-Pane-Remote-Runtime-Id': 'pane-native-1',
        'X-Pane-Client-Label': 'Pane for iOS',
        'X-Pane-Client-Device-Label': 'Parsa%E2%80%99s%20iPhone',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ channel: 'notify:remote-command', args: [{ type: 'answer', id: 'q1', answer: { choice: 'Wait' } }], runtimeId: 'pane-native-1', clientLabel: 'Pane for iOS' }),
    }));
  });

  it('passes on the host\'s refusal, such as an answer from another screen', async () => {
    const fetch = reply(409, { ok: false, error: { code: 'ERR_NOTIFY_ANSWERED', message: 'Already answered on Parsa’s MacBook. Nothing was sent.' } });
    await expect(sendNotifyCommand(sender(fetch), work, { type: 'answer', id: 'q1', answer: { approved: true } }))
      .resolves.toEqual({ sent: false, retry: false, message: 'Already answered on Parsa’s MacBook. Nothing was sent.' });
  });

  it('says the host is unreachable when the request fails', async () => {
    const fetch: RemoteFetch = vi.fn(async () => { throw new TypeError('Network request failed'); });
    await expect(sendNotifyCommand(sender(fetch), work, { type: 'answer', id: 'q1', answer: { approved: true } }))
      .resolves.toEqual({ sent: false, retry: true, message: 'Not sent: can\'t reach Work Mac. Try again when it reconnects.' });
  });

  it('asks to reconnect when the host no longer accepts the token', async () => {
    const fetch = reply(401, { ok: false, error: { code: 'ERR_REMOTE_AUTH', message: 'Unauthorized' } });
    await expect(sendNotifyCommand(sender(fetch), work, { type: 'answer', id: 'q1', answer: { approved: true } }))
      .resolves.toEqual({ sent: false, retry: false, message: 'Not sent: Work Mac no longer accepts this phone. Open Pane and connect to it again.' });
  });
});
