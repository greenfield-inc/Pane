import { QueryClient } from '@tanstack/react-query';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { createSavedState } from './savedState';

let files: Map<string, string>;
const store = {
  read: (name: string) => files.get(name) ?? null,
  write: (name: string, text: string) => void files.set(name, text),
  remove: (name: string) => void files.delete(name),
  list: () => [...files.keys()],
};

// Profile ids end with a piece of the computer's token.
const MAC = 'Studio:https://studio.example:token-tail-1234';
const DEVBOX = 'Devbox:https://devbox.example:token-tail-5678';

beforeEach(() => {
  vi.useFakeTimers();
  files = new Map();
});
afterEach(() => vi.useRealTimers());

function phone(saves = (_id: string) => true) {
  const queryClient = new QueryClient();
  return { queryClient, saved: createSavedState(queryClient, store, { saves }) };
}

it('paints a machine’s lists after a relaunch, marked stale so screens still read them', () => {
  const before = phone();
  before.queryClient.setQueryData([MAC, 'sessions:get-all-with-projects'], [{ id: 1, name: 'pane' }]);
  before.queryClient.setQueryData([MAC, 'runpane:workspace:state'], { unseen: { 'pane-1': true } });
  before.queryClient.setQueryData([MAC, 'panels:list', 'pane-1', { chatTabs: true }], [{ id: 'tab' }]);
  before.queryClient.setQueryData([MAC, 'git:diff', 'pane-1'], 'not saved');
  before.queryClient.setQueryData([MAC, 'orchestration-sessions:get', 's-1'], { name: 'Spring sale launch' });
  before.queryClient.setQueryData([DEVBOX, 'all-machines:snapshot', 'https://devbox.example'], { projects: [] });
  vi.advanceTimersByTime(2_000);

  const after = phone();
  after.saved.restore(MAC);
  expect(after.queryClient.getQueryData([MAC, 'sessions:get-all-with-projects'])).toEqual([{ id: 1, name: 'pane' }]);
  expect(after.queryClient.getQueryData([MAC, 'runpane:workspace:state'])).toEqual({ unseen: { 'pane-1': true } });
  expect(after.queryClient.getQueryData([MAC, 'panels:list', 'pane-1', { chatTabs: true }])).toEqual([{ id: 'tab' }]);
  expect(after.queryClient.getQueryData([MAC, 'git:diff', 'pane-1'])).toBeUndefined();
  // An approval opens inside its Session's tabs, named from the saved Session.
  expect(after.queryClient.getQueryData([MAC, 'orchestration-sessions:get', 's-1'])).toEqual({ name: 'Spring sale launch' });
  // Another machine's lists live in its own file.
  expect(after.queryClient.getQueryData([DEVBOX, 'all-machines:snapshot', 'https://devbox.example'])).toBeUndefined();
  expect(after.queryClient.getQueryState([MAC, 'sessions:get-all-with-projects'])?.isInvalidated).toBe(true);
  after.saved.restore(DEVBOX);
  expect(after.queryClient.getQueryData([DEVBOX, 'all-machines:snapshot', 'https://devbox.example'])).toEqual({ projects: [] });
});

it('keeps no piece of a machine’s token in its file’s name or contents', () => {
  const { queryClient } = phone();
  queryClient.setQueryData([MAC, 'permission:getPending'], []);
  vi.advanceTimersByTime(2_000);

  expect(files.size).toBe(1);
  for (const [name, text] of files) {
    expect(name).not.toContain('token-tail');
    expect(text).not.toContain('token-tail');
  }
});

it('writes once, 2 s after the last change in a burst, and within 10 s of a burst that never stops', () => {
  const { queryClient } = phone();
  const writes = vi.spyOn(store, 'write');
  for (let count = 0; count < 5; count++) {
    queryClient.setQueryData([MAC, 'permission:getPending'], [count]);
    vi.advanceTimersByTime(500);
  }
  expect(writes).not.toHaveBeenCalled();
  vi.advanceTimersByTime(1_500);
  expect(writes).toHaveBeenCalledTimes(1);

  writes.mockClear();
  for (let count = 0; count < 12; count++) {
    queryClient.setQueryData([MAC, 'permission:getPending'], [count, 'again']);
    vi.advanceTimersByTime(1_000);
  }
  expect(writes).toHaveBeenCalledTimes(1);
});

it('writes nothing when a read brings back the same lists', () => {
  const { queryClient } = phone();
  const writes = vi.spyOn(store, 'write');
  queryClient.setQueryData([MAC, 'sessions:get-all-with-projects'], [{ id: 1 }]);
  vi.advanceTimersByTime(2_000);
  queryClient.setQueryData([MAC, 'sessions:get-all-with-projects'], [{ id: 1 }]);
  vi.advanceTimersByTime(2_000);

  expect(writes).toHaveBeenCalledTimes(1);
});

it('writes a pending change at once when the app goes to the background', () => {
  const { queryClient, saved } = phone();
  queryClient.setQueryData([MAC, 'permission:getPending'], ['waiting']);
  saved.flush();

  const after = phone();
  after.saved.restore(MAC);
  expect(after.queryClient.getQueryData([MAC, 'permission:getPending'])).toEqual(['waiting']);
});

it('keeps a list’s last answer when its next read failed', async () => {
  const { queryClient } = phone();
  queryClient.setQueryData([MAC, 'notify:remote-snapshot'], { items: ['q'] });
  await queryClient.fetchQuery({ queryKey: [MAC, 'notify:remote-snapshot'], queryFn: () => Promise.reject(new Error('timed out')), staleTime: 0 }).catch(() => undefined);
  queryClient.setQueryData([MAC, 'permission:getPending'], []);
  vi.advanceTimersByTime(2_000);

  const after = phone();
  after.saved.restore(MAC);
  expect(after.queryClient.getQueryData([MAC, 'notify:remote-snapshot'])).toEqual({ items: ['q'] });
  expect(after.queryClient.getQueryState([MAC, 'notify:remote-snapshot'])?.status).toBe('success');
});

it('keeps the tab lists of the 20 Panes read most recently', () => {
  const { queryClient } = phone();
  for (let pane = 1; pane <= 25; pane++) {
    queryClient.setQueryData([MAC, 'panels:list', `pane-${pane}`], [pane], { updatedAt: 1_000 + pane });
  }
  vi.advanceTimersByTime(2_000);
  const after = phone();
  after.saved.restore(MAC);
  expect(after.queryClient.getQueryData([MAC, 'panels:list', 'pane-6'])).toEqual([6]);
  expect(after.queryClient.getQueryData([MAC, 'panels:list', 'pane-5'])).toBeUndefined();
});

it('keeps newer lists already in memory', () => {
  const before = phone();
  before.queryClient.setQueryData([MAC, 'permission:getPending'], ['saved'], { updatedAt: 1_000 });
  vi.advanceTimersByTime(2_000);
  const { queryClient, saved } = phone();
  queryClient.setQueryData([MAC, 'permission:getPending'], ['live'], { updatedAt: 5_000 });
  saved.restore(MAC);
  expect(queryClient.getQueryData([MAC, 'permission:getPending'])).toEqual(['live']);
});

it('ignores a file from another version', () => {
  const before = phone();
  before.queryClient.setQueryData([MAC, 'permission:getPending'], ['saved']);
  vi.advanceTimersByTime(2_000);
  const [name, text] = [...files][0]!;
  files.set(name, text.replace('"version":1', '"version":2'));

  const { queryClient, saved } = phone();
  saved.restore(MAC);
  expect(queryClient.getQueryData([MAC, 'permission:getPending'])).toBeUndefined();
});

it('deletes a file it can’t read back instead of failing the launch', () => {
  const before = phone();
  before.queryClient.setQueryData([MAC, 'permission:getPending'], ['saved']);
  vi.advanceTimersByTime(2_000);
  const [name] = [...files.keys()];
  for (const text of ['{not json', JSON.stringify({ version: 1, queries: [null] })]) {
    files.set(name!, text);
    const { queryClient, saved } = phone();
    expect(() => saved.restore(MAC)).not.toThrow();
    expect(queryClient.getQueryData([MAC, 'permission:getPending'])).toBeUndefined();
    expect(files.has(name!)).toBe(false);
  }
});

it('saves nothing for a machine it must not keep, and forgets a machine on removal', () => {
  const { queryClient, saved } = phone(id => id !== 'pane-demo');
  queryClient.setQueryData(['pane-demo', 'sessions:get-all-with-projects'], []);
  queryClient.setQueryData([MAC, 'sessions:get-all-with-projects'], []);
  vi.advanceTimersByTime(2_000);
  expect(files.size).toBe(1);

  queryClient.setQueryData([MAC, 'sessions:get-all-with-projects'], [1]);
  saved.forget(MAC);
  vi.advanceTimersByTime(2_000);
  expect(files.size).toBe(0);
});

it('deletes the files of machines no longer saved', () => {
  const { queryClient, saved } = phone();
  queryClient.setQueryData([MAC, 'permission:getPending'], []);
  queryClient.setQueryData([DEVBOX, 'permission:getPending'], []);
  vi.advanceTimersByTime(2_000);
  expect(files.size).toBe(2);

  saved.keepOnly([DEVBOX]);
  const after = phone();
  after.saved.restore(DEVBOX);
  after.saved.restore(MAC);
  expect(files.size).toBe(1);
  expect(after.queryClient.getQueryData([DEVBOX, 'permission:getPending'])).toEqual([]);
  expect(after.queryClient.getQueryData([MAC, 'permission:getPending'])).toBeUndefined();
});
