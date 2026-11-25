import { EventEmitter } from 'events';
import type { IpcMainInvokeEvent, WebContents } from 'electron';
import { describe, expect, it } from 'vitest';
import { START_LINK_ANSWER_CHANNEL, START_LINK_PENDING_CHANNEL, START_LINK_REQUEST_CHANNEL, type StartLinkRequest } from '../../../shared/types/startLinks';
import type { JsonValue } from '../../../shared/validation/boundaryDecoder';
import { registerStartLinkConfirm } from './startLinkConfirm';

const REQUEST: Omit<StartLinkRequest, 'requestId'> = {
  prompt: 'hi',
  agents: [{ id: 'claude', label: 'Claude Code', installed: true }],
  agent: 'claude',
  linkAgent: null,
  targets: [{ kind: 'new-session' }],
};

function setup() {
  let handler: (event: IpcMainInvokeEvent, value: JsonValue) => void = () => undefined;
  let pendingHandler: (event: IpcMainInvokeEvent) => StartLinkRequest | null = () => null;
  const sent: Array<{ channel: string; request: StartLinkRequest }> = [];
  const contents = Object.assign(new EventEmitter(), {
    send: (channel: string, request: StartLinkRequest) => sent.push({ channel, request }),
  });
  const window = Object.assign(new EventEmitter(), { webContents: contents });
  const confirm = registerStartLinkConfirm(
    {
      handle: (channel: string, listener: typeof handler & typeof pendingHandler) => {
        if (channel === START_LINK_ANSWER_CHANNEL) handler = listener;
        if (channel === START_LINK_PENDING_CHANNEL) pendingHandler = listener;
      },
    },
    () => window,
  );
  const answer = (from: EventEmitter, value: JsonValue) => {
    // SAFETY: the confirmer reads only the event's sender, which it compares by identity.
    const event = { sender: from as WebContents } as IpcMainInvokeEvent;
    handler(event, value);
  };
  const askPending = (from: EventEmitter) => {
    // SAFETY: the confirmer reads only the event's sender, which it compares by identity.
    const event = { sender: from as WebContents } as IpcMainInvokeEvent;
    return pendingHandler(event);
  };
  return { confirm, sent, contents, window, answer, askPending };
}

describe('registerStartLinkConfirm', () => {
  it("shows the request in Pane's window and resolves with that window's answer", async () => {
    const { confirm, sent, contents, answer } = setup();

    const pending = confirm(REQUEST);
    expect(sent).toEqual([{ channel: START_LINK_REQUEST_CHANNEL, request: { ...REQUEST, requestId: expect.any(String) } }]);
    answer(contents, { requestId: sent[0].request.requestId, start: true, agent: 'claude', target: 0 });

    expect(await pending).toEqual({ start: true, agent: 'claude', target: 0 });
  });

  it('ignores an answer from anything but the main window, or for another request', async () => {
    const { confirm, sent, contents, answer, window } = setup();

    const pending = confirm(REQUEST);
    const { requestId } = sent[0].request;
    answer(new EventEmitter(), { requestId, start: true, agent: 'claude', target: 0 });
    answer(contents, { requestId: 'guessed', start: true, agent: 'claude', target: 0 });
    answer(contents, { requestId, start: 'yes' });
    window.emit('closed');

    expect(await pending).toEqual({ start: false });
  });

  it('hands the waiting request to the main window that asks, and to nothing else', async () => {
    const { confirm, sent, contents, askPending, answer } = setup();

    expect(askPending(contents)).toBeNull();
    const pending = confirm(REQUEST);
    expect(askPending(contents)).toEqual(sent[0].request);
    expect(askPending(new EventEmitter())).toBeNull();
    answer(contents, { requestId: sent[0].request.requestId, start: false });

    await pending;
    expect(askPending(contents)).toBeNull();
  });

  it('keeps asking while a frame inside the page loads', async () => {
    const { confirm, sent, contents, answer } = setup();

    const pending = confirm(REQUEST);
    contents.emit('did-start-navigation', {}, 'about:srcdoc', false, false);
    contents.emit('did-start-navigation', {}, 'pane://app#todos', true, true);
    answer(contents, { requestId: sent[0].request.requestId, start: true, agent: 'claude', target: 0 });

    expect(await pending).toEqual({ start: true, agent: 'claude', target: 0 });
  });

  it.each([
    ['the window reloads', (contents: EventEmitter) => contents.emit('did-start-navigation', {}, 'http://localhost/', false, true)],
    ['the renderer crashes', (contents: EventEmitter) => contents.emit('render-process-gone')],
  ])('counts it as Cancel when %s', async (_case, drop) => {
    const { confirm, contents } = setup();

    const pending = confirm(REQUEST);
    drop(contents);

    expect(await pending).toEqual({ start: false });
  });
});
