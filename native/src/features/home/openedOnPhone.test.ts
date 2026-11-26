import { beforeEach, expect, it } from 'vitest';

import { createOpenedOnPhone } from './openedOnPhone';

let files: Map<string, string>;
const store = {
  read: (name: string) => files.get(name) ?? null,
  write: (name: string, text: string) => void files.set(name, text),
  remove: (name: string) => void files.delete(name),
  list: () => [...files.keys()],
};

const MAC = 'Studio:https://studio.example:token-tail-1234';
const DEVBOX = 'Devbox:https://devbox.example:token-tail-5678';
const DEMO = 'pane-demo';

beforeEach(() => { files = new Map(); });

/** The app, started on what the phone kept. */
function launch(computers = [MAC, DEVBOX]) {
  const opened = createOpenedOnPhone(store, { saves: id => id !== DEMO });
  opened.getState().restore(computers);
  return opened;
}

it('keeps when each Pane was last opened, per computer, across a relaunch', () => {
  const first = launch();
  first.getState().record(MAC, 'pane-1', 1_000);
  first.getState().record(MAC, 'pane-1', 3_000);
  first.getState().record(DEVBOX, 'pane-1', 2_000);
  const next = launch();
  expect(next.getState().opened[MAC]).toEqual({ 'pane-1': 3_000 });
  expect(next.getState().opened[DEVBOX]).toEqual({ 'pane-1': 2_000 });
});

it('keeps the 30 newest Panes of a computer', () => {
  const opened = launch();
  for (let index = 0; index < 35; index += 1) opened.getState().record(MAC, `pane-${index}`, index);
  const kept = Object.keys(launch().getState().opened[MAC] ?? {});
  expect(kept).toHaveLength(30);
  expect(kept).not.toContain('pane-4');
  expect(kept).toContain('pane-5');
});

it('forgets a removed computer, and never saves the demo', () => {
  const opened = launch([MAC, DEMO]);
  opened.getState().record(MAC, 'pane-1', 1_000);
  opened.getState().record(DEMO, 'pane-1', 1_000);
  opened.getState().forget(MAC);
  expect(files.size).toBe(0);
  expect(launch([MAC, DEMO]).getState().opened[MAC]).toEqual({});
});
