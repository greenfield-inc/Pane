import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PaneCommandRegistry, paneCommandCaller, type PaneCommandValue } from '../daemon/commandRegistry';
import { AutopilotManager } from '../services/autopilot/autopilotManager';
import { NotifyQueue } from '../services/notify/notifyQueue';
import { DEFAULT_NOTIFY_SETTINGS } from '../../../shared/types/notify';
import { parsePaneDaemonFrame, type PaneDaemonCaller } from '../../../shared/types/daemon';
import { readDocument, refuseAnswers } from './autopilot';

let root: string;
let queue: NotifyQueue;
let manager: AutopilotManager;
const pending: AbortController[] = [];

const AUTOPILOT: PaneDaemonCaller = { paneId: '__autopilot_owner_run-1', panelId: '__autopilot_panel_run-1' };
const AUTOPILOT_PANEL_ONLY: PaneDaemonCaller = { panelId: '__autopilot_panel_run-1' };
const WORKER: PaneDaemonCaller = { paneId: 'pane-1', panelId: 'panel-1' };

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'autopilot-ipc-'));
  queue = new NotifyQueue({ settings: () => DEFAULT_NOTIFY_SETTINGS, showOutsideSupported: true, shortcutRegistered: () => true, instructionFiles: () => [] });
  manager = new AutopilotManager({
    root,
    config: { autopilotEnabled: () => true, chatTabsEnabled: () => true, setAutopilotEnabled: async () => undefined },
    owner: { exists: () => false, create: () => undefined },
    chat: {
      exists: () => false, create: async () => undefined, ensure: async () => undefined,
      isRunning: () => false, send: () => undefined, stop: async () => undefined,
    },
    notify: { items: () => [], subscribe: () => () => undefined },
    sessions: { list: () => [], subscribe: () => () => undefined },
    launch: () => ({ kind: 'agent' }),
    skillPath: '/pane/skills/pane-autopilot/SKILL.md',
  });
  // A permission prompt waiting on another tab's screen: typing into that tab would answer it.
  const controller = new AbortController();
  pending.push(controller);
  void queue.ask({
    question: { ui: 'approve', title: 'Allow rm -rf build?', agentPrompt: { yes: '1', no: '3' } },
    source: { paneId: 'pane-1', panelId: 'panel-prompt', name: 'Worker', agent: 'Claude' },
  }, controller.signal).catch(() => undefined);
});

afterEach(() => {
  for (const controller of pending.splice(0)) controller.abort();
  fs.rmSync(root, { recursive: true, force: true });
});

/** Every answer route refuseAnswers knows, with the arguments Pane's UI or runpane send. */
const ANSWER_ROUTES: Array<[string, PaneCommandValue[]]> = [
  ['notify:remote-command', [{ type: 'answer', id: 'n-1', answer: { approved: true } }]],
  ['notify:remote-command', [{ type: 'undo', id: 'n-1' }]],
  ['permission:respond', [{ requestId: 'r-1', allow: true }]],
  ['chat-tab:permission', ['panel-other', { requestId: 'r-1', allow: true }]],
  ['chat-tab:answer', ['panel-other', { requestId: 'r-1', answer: 'yes' }]],
  ['runpane:panels:input', [{ panelId: 'panel-1', text: '1' }]],
  ['runpane:panels:submit', [{ panelId: 'panel-prompt', text: '1' }]],
  ['runpane:panels:submit-composer', [{ panelId: 'panel-prompt' }]],
  // Every raw-input route: typing into a tab is how a terminal prompt is answered.
  ['terminal:input', ['panel-prompt', 'y\r']],
  ['terminal:paste-file', ['panel-prompt', '/tmp/a.txt']],
  ['terminal:paste-image', ['panel-prompt', 'data']],
  ['panels:send-input', ['panel-prompt', 'y\r']],
  ['panels:send-terminal-input', ['panel-prompt', 'y\r']],
  ['sessions:input', ['pane-1', 'y\r']],
  ['sessions:send-terminal-input', ['pane-1', 'y\r']],
  // Hiding, skipping or snoozing a card takes it away from the person.
  ['notify:remote-command', [{ type: 'dismiss', id: 'n-1' }]],
  ['notify:remote-command', [{ type: 'skip', id: 'n-1' }]],
  ['notify:remote-command', [{ type: 'remind', id: 'n-1', after: '1h' }]],
];

const refuse = (channel: string, args: PaneCommandValue[], caller: PaneDaemonCaller | undefined) =>
  () => refuseAnswers(manager, { queue }, channel, args, caller);

describe('refuseAnswers (D-66)', () => {
  it.each(ANSWER_ROUTES)('refuses %s from Autopilot\'s panel', (channel, args) => {
    for (const caller of [AUTOPILOT, AUTOPILOT_PANEL_ONLY]) {
      expect(refuse(channel, args, caller)).toThrow(expect.objectContaining({ code: 'AUTOPILOT_CANNOT_ANSWER' }));
    }
  });

  it.each(ANSWER_ROUTES)('allows %s from any other caller, and from Pane\'s own UI (no caller)', (channel, args) => {
    expect(refuse(channel, args, WORKER)).not.toThrow();
    expect(refuse(channel, args, undefined)).not.toThrow();
  });

  it('lets Autopilot do everything that is not an answer', () => {
    // Its own chat tab's questions are the person's to answer there.
    expect(refuse('chat-tab:answer', [AUTOPILOT.panelId ?? '', { answer: 'yes' }], AUTOPILOT)).not.toThrow();
    // Submitting to a tab with no prompt waiting answers nothing.
    expect(refuse('runpane:panels:submit', [{ panelId: 'panel-quiet', text: 'next task' }], AUTOPILOT)).not.toThrow();
    expect(refuse('runpane:autopilot:stack-push', [{ item: 'n-1' }], AUTOPILOT)).not.toThrow();
    expect(refuse('runpane:panes:list', [], AUTOPILOT)).not.toThrow();
  });
});

describe('the caller on daemon request frames', () => {
  it('decodes a request frame\'s caller and gives it to the guard and to the handler', async () => {
    const frame = parsePaneDaemonFrame({ type: 'request', id: 1, channel: 'runpane:panels:input', args: [{ panelId: 'panel-1', text: '1' }], caller: AUTOPILOT });
    if (frame.type !== 'request') throw new Error('expected a request frame');
    expect(frame.caller).toEqual(AUTOPILOT);
    const older = parsePaneDaemonFrame({ type: 'request', id: 2, channel: 'runpane:panes:list', args: [] });
    expect(older.type === 'request' && older.caller).toBe(undefined);

    const registry = new PaneCommandRegistry();
    registry.addGuard((channel, args, caller) => refuseAnswers(manager, { queue }, channel, args, caller));
    const seen: Array<PaneDaemonCaller | undefined> = [];
    registry.register('runpane:panels:input', async () => { await Promise.resolve(); seen.push(paneCommandCaller()); return { ok: true }; });
    registry.register('runpane:panes:list', async () => { await Promise.resolve(); seen.push(paneCommandCaller()); return { ok: true }; });
    const signal = new AbortController().signal;

    await expect(registry.invokeConnected(frame.channel, frame.args, signal, frame.caller)).rejects.toMatchObject({ code: 'AUTOPILOT_CANNOT_ANSWER' });
    await expect(registry.invokeConnected('runpane:panes:list', [], signal, frame.caller)).resolves.toEqual({ ok: true });
    await expect(registry.invokeConnected('runpane:panels:input', [{ panelId: 'panel-1', text: '1' }], signal, WORKER)).resolves.toEqual({ ok: true });
    await expect(registry.invokeConnected('runpane:panels:input', [{ panelId: 'panel-1', text: '1' }], signal)).resolves.toEqual({ ok: true });
    expect(seen).toEqual([AUTOPILOT, WORKER, undefined]);
  });

  it('refuses an answer from Autopilot that arrives over another machine\'s /invoke too', async () => {
    const registry = new PaneCommandRegistry();
    registry.addGuard((channel, args, caller) => refuseAnswers(manager, { queue }, channel, args, caller));
    registry.register('notify:remote-command', async () => null);
    await expect(registry.invokeRemote('notify:remote-command', [{ type: 'answer', id: 'n-1', answer: { approved: true } }, { device: 'studio' }], { caller: AUTOPILOT })).rejects.toMatchObject({ code: 'AUTOPILOT_CANNOT_ANSWER' });
    // A phone or another screen sends no caller: the person answering is never refused.
    await expect(registry.invokeRemote('notify:remote-command', [{ type: 'answer', id: 'n-1', answer: { approved: true } }, { device: 'iPhone' }])).resolves.toBeNull();
  });
});

describe('autopilot:read-doc', () => {
  const page = () => {
    const file = path.join(root, 'linked', 'cover-sheet.html');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '<h1>Plan</h1>');
    return file;
  };

  it('gives the phone an HTML page inline, and the desktop only its file URL', () => {
    const file = page();
    const links = () => [file];
    expect(readDocument(manager, file, { links })).toEqual({ kind: 'html', path: file, url: expect.stringMatching(/^file:/) });
    expect(readDocument(manager, file, { links, inline: true })).toMatchObject({ kind: 'html', path: file, html: '<h1>Plan</h1>' });
  });

  it('opens a waiting item\'s linked file, and refuses one nothing names', () => {
    const file = page();
    expect(readDocument(manager, file, { inline: true })).toMatchObject({ kind: 'missing', message: "This file is not on Autopilot's stack." });
    expect(readDocument(manager, file, { inline: true, links: () => [file] }).kind).toBe('html');
  });
});
