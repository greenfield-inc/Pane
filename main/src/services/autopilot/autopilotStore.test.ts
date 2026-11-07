import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AutopilotStore } from './autopilotStore';

let root: string;

beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'autopilot-store-')); });
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

describe('AutopilotStore', () => {
  it('has no run until one is made', () => {
    expect(new AutopilotStore(root).current()).toBeNull();
  });

  it('makes a run folder with its docs, stack, state and log, and points current at it', () => {
    const store = new AutopilotStore(root);
    const run = store.createRun(new Date('2026-11-04T10:00:00Z'));
    expect(run.folder).toBe(path.join(root, 'runs', run.id));
    for (const name of ['docs', 'stack.json', 'state.json', 'log']) expect(fs.existsSync(path.join(run.folder, name))).toBe(true);
    expect(fs.readFileSync(path.join(root, 'current'), 'utf8').trim()).toBe(run.id);
    expect(store.current()).toEqual(run);
    expect(store.readStack(run.id)).toEqual({ entries: [], shownId: null });
  });

  it('a new run moves current and leaves the old run where it was', () => {
    const store = new AutopilotStore(root);
    const first = store.createRun(new Date('2026-11-04T10:00:00Z'));
    fs.writeFileSync(path.join(first.docsFolder, 'close-out.html'), '<h1>x</h1>');
    const second = store.createRun(new Date('2026-11-04T11:00:00Z'));
    expect(second.id).not.toBe(first.id);
    expect(store.current()?.id).toBe(second.id);
    expect(fs.existsSync(path.join(first.docsFolder, 'close-out.html'))).toBe(true);
  });

  it('keeps the stack and state across instances (a Pane restart)', () => {
    const store = new AutopilotStore(root);
    const run = store.createRun();
    store.writeStack(run.id, { entries: [{ id: 'e', ref: { kind: 'url', url: 'https://example.com' }, title: 'x', tabs: [], addedAt: 1 }], shownId: 'e' });
    store.writeState(run.id, { state: 'running', walkSessionId: 's1' });
    const again = new AutopilotStore(root);
    expect(again.readStack(run.id).shownId).toBe('e');
    expect(again.readState(run.id)).toEqual({ state: 'running', walkSessionId: 's1' });
  });

  it('reads a damaged stack as empty instead of failing, and says so in the log', () => {
    const store = new AutopilotStore(root);
    const run = store.createRun();
    fs.writeFileSync(path.join(run.folder, 'stack.json'), '{not json');
    expect(store.readStack(run.id)).toEqual({ entries: [], shownId: null });
    expect(fs.readFileSync(path.join(run.folder, 'log'), 'utf8')).toMatch(/stack\.json could not be read/);
  });

  it('appends one timestamped line per log entry', () => {
    const store = new AutopilotStore(root);
    const run = store.createRun();
    store.log(run.id, 'started', new Date('2026-11-04T10:00:00Z'));
    store.log(run.id, 'stack push: Q-14', new Date('2026-11-04T10:00:01Z'));
    const lines = fs.readFileSync(path.join(run.folder, 'log'), 'utf8').trim().split('\n');
    expect(lines.slice(-2)).toEqual(['2026-11-04T10:00:00.000Z started', '2026-11-04T10:00:01.000Z stack push: Q-14']);
  });

  it('ignores a current pointer naming a run that is gone', () => {
    const store = new AutopilotStore(root);
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(path.join(root, 'current'), 'missing-run\n');
    expect(store.current()).toBeNull();
  });

  it('refuses a current pointer that tries to leave the runs folder', () => {
    const store = new AutopilotStore(root);
    fs.writeFileSync(path.join(root, 'current'), '../../etc\n');
    expect(store.current()).toBeNull();
  });
});
