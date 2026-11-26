import { beforeEach, expect, it } from 'vitest';

import { createOpenSessions } from './openSessions';

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
const DEMO = 'pane-demo';

beforeEach(() => { files = new Map(); });

/** The app, started on what the phone kept. */
function launch(computers = [MAC, DEVBOX]) {
  const sessions = createOpenSessions(store, { saves: id => id !== DEMO });
  sessions.getState().restore(computers);
  return sessions;
}
const open = (sessions: ReturnType<typeof launch>, computer: string) => sessions.getState().open[computer] ?? [];

it('starts every Session collapsed, and keeps the opened ones open after a relaunch', () => {
  const first = launch();
  expect(open(first, MAC)).toEqual([]);
  first.getState().toggle(MAC, 's-1');
  first.getState().toggle(MAC, 's-2');
  first.getState().toggle(MAC, 's-1');
  expect(open(first, MAC)).toEqual(['s-2']);
  expect(open(launch(), MAC)).toEqual(['s-2']);
});

it('keeps each computer’s Sessions apart, also when their ids match', () => {
  const sessions = launch();
  sessions.getState().toggle(MAC, 's-1');
  expect(open(sessions, DEVBOX)).toEqual([]);
  expect(open(launch(), DEVBOX)).toEqual([]);
});

it('forgets a Session its computer no longer has', () => {
  const sessions = launch();
  sessions.getState().toggle(MAC, 'gone');
  sessions.getState().keepSessions(MAC, ['s-1', 's-2']);
  expect(open(sessions, MAC)).toEqual([]);
  expect(open(launch(), MAC)).toEqual([]);
});

it('forgets a computer that was removed, and one that went away while the app was closed', () => {
  const sessions = launch();
  sessions.getState().toggle(MAC, 's-1');
  sessions.getState().toggle(DEVBOX, 's-9');
  sessions.getState().forget(MAC);
  expect(open(sessions, MAC)).toEqual([]);
  launch([MAC]);
  expect(files.size).toBe(0);
  expect(open(launch(), DEVBOX)).toEqual([]);
});

it('keeps no piece of a computer’s token, and saves nothing of the demo', () => {
  const sessions = launch();
  sessions.getState().toggle(MAC, 's-1');
  sessions.getState().toggle(DEMO, 'demo-1');
  expect(open(sessions, DEMO)).toEqual(['demo-1']);
  expect(files.size).toBe(1);
  for (const [name, text] of files) expect(name + text).not.toContain('token-tail');
});

it('starts collapsed when the saved file can’t be read', () => {
  launch().getState().toggle(MAC, 's-1');
  for (const name of files.keys()) files.set(name, '{broken');
  expect(open(launch(), MAC)).toEqual([]);
});
