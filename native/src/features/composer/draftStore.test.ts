import { expect, it } from 'vitest';

import { DraftStore } from './draftStore';

it('confirms the original draft after navigation without clearing another tab or a newer revision', () => {
  const saved = new Map([['host/pane/A', 'send A'], ['host/pane/B', 'keep B']]);
  const store = new DraftStore({ read: key => saved.get(key) ?? '', write: (key, text) => { saved.set(key, text); } });
  const sent = store.read('host/pane/A');
  store.update('host/pane/B', 'edited B');
  store.confirm(sent);
  expect(saved.get('host/pane/A')).toBe('');
  expect(saved.get('host/pane/B')).toBe('edited B');
  store.update('host/pane/A', 'next A');
  const next = store.read('host/pane/A');
  store.update('host/pane/A', 'new text');
  store.update('host/pane/A', 'next A'); // Same text, newer user edit.
  store.confirm(next);
  expect(saved.get('host/pane/A')).toBe('next A');
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
