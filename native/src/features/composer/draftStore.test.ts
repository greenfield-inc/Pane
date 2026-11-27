import { expect, it } from 'vitest';

import { DraftStore } from './draftStore';

function storeWith(drafts: Record<string, string>) {
  const saved = new Map(Object.entries(drafts));
  const store = new DraftStore({ read: key => saved.get(key) ?? '', write: (key, text) => { saved.set(key, text); } });
  return { store, saved };
}

/** A host write that stays in flight until the test answers it. */
function pendingWrite() {
  const sent: string[] = [];
  let answer: { resolve: () => void; reject: (error: Error) => void } = { resolve: () => undefined, reject: () => undefined };
  const deliver = (text: string) => {
    sent.push(text);
    return new Promise<void>((resolve, reject) => { answer = { resolve, reject }; });
  };
  return { sent, deliver, confirm: () => answer.resolve(), fail: (error: Error) => answer.reject(error) };
}

it('keeps the text until the host confirms it, and a second tap meanwhile sends nothing', async () => {
  const { store, saved } = storeWith({ 'host/pane/A': 'fix the build' });
  const write = pendingWrite();

  const first = store.send('host/pane/A', write.deliver);
  const second = store.send('host/pane/A', write.deliver);
  await second;
  expect(store.read('host/pane/A')).toMatchObject({ text: 'fix the build', sending: true });

  write.confirm();
  await first;
  expect(write.sent).toEqual(['fix the build']);
  expect(store.read('host/pane/A')).toMatchObject({ text: '', sending: false });
  expect(saved.get('host/pane/A')).toBe('');
});

it('keeps the text when the send fails, and sends it on the next tap', async () => {
  const { store } = storeWith({ 'host/pane/A': 'fix the build' });
  const write = pendingWrite();

  const failed = store.send('host/pane/A', write.deliver);
  write.fail(new Error('offline'));
  await expect(failed).rejects.toThrow('offline');
  expect(store.read('host/pane/A')).toMatchObject({ text: 'fix the build', sending: false });

  const retried = store.send('host/pane/A', write.deliver);
  write.confirm();
  await retried;
  expect(write.sent).toEqual(['fix the build', 'fix the build']);
  expect(store.read('host/pane/A').text).toBe('');
});

it('clears only the sent draft: an edit made while sending and other tabs stay', async () => {
  const { store, saved } = storeWith({ 'host/pane/A': 'send A', 'host/pane/B': 'keep B' });
  const write = pendingWrite();

  const sending = store.send('host/pane/A', write.deliver);
  store.update('host/pane/A', 'send A, then this');
  write.confirm();
  await sending;

  expect(saved.get('host/pane/A')).toBe('send A, then this');
  expect(saved.get('host/pane/B')).toBe('keep B');
});

it('publishes only to subscribers of the changed draft and keeps host keys separate', () => {
  const store = new DraftStore({ read: () => '', write: () => undefined });
  let a = 0, b = 0;
  const off = store.subscribe('host-A/pane/panel', () => { a++; });
  store.subscribe('host-B/pane/panel', () => { b++; });
  store.update('host-A/pane/panel', 'private to A');
  expect([a, b]).toEqual([1, 0]);
  off();
  store.update('host-A/pane/panel', 'retained while away');
  expect(a).toBe(1);
  expect(store.read('host-B/pane/panel').text).toBe('');
});
