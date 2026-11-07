import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ChatPanelState } from '../../../../shared/types/chatTab';
import type { NotifyItem, NotifyResult } from '../../../../shared/types/notify';
import { AutopilotManager, type AutopilotPorts, type AutopilotSessionInfo } from './autopilotManager';
import { setAutopilotEntitlementForTests } from './entitlement';

interface Fake {
  ports: AutopilotPorts;
  enabled: boolean;
  chatTabs: boolean;
  owners: Map<string, string>;
  tabs: Map<string, ChatPanelState>;
  running: Set<string>;
  sent: Array<{ panelId: string; text: string }>;
  items: NotifyItem[];
  sessions: AutopilotSessionInfo[];
  notifyListeners: Array<() => void>;
  busy: Set<string>;
  queued: string[];
  resumed: string[];
  asks: Array<{ title: string; choices: string[]; resolve: (result: NotifyResult) => void }>;
  ticks: Array<{ ms: number; run: () => void }>;
  chatListeners: Array<(panelId: string) => void>;
  timers: Array<{ ms: number; run: () => void }>;
  watchers: Map<string, () => void>;
}

let root: string;

function fake(): Fake {
  const f: Fake = {
    enabled: false, chatTabs: true, owners: new Map(), tabs: new Map(), running: new Set(), sent: [], items: [], sessions: [], notifyListeners: [], busy: new Set(), queued: [], resumed: [], asks: [], ticks: [], chatListeners: [], timers: [], watchers: new Map(),
    // SAFETY: the ports close over `f` and are assigned on the next statement, before any use.
    ports: undefined as never,
  };
  f.ports = {
    root,
    config: {
      autopilotEnabled: () => f.enabled,
      chatTabsEnabled: () => f.chatTabs,
      setAutopilotEnabled: async (on) => { f.enabled = on; },
    },
    owner: {
      exists: (id) => f.owners.has(id),
      create: (id, _title, folder) => { f.owners.set(id, folder); },
    },
    chat: {
      exists: (id) => f.tabs.has(id),
      create: async (id, _owner, _title, state) => { f.tabs.set(id, state); },
      ensure: async (id) => { f.running.add(id); },
      isRunning: (id) => f.running.has(id),
      send: (panelId, text) => { f.sent.push({ panelId, text }); },
      stop: async (id) => { f.running.delete(id); },
      resume: async (id) => { if (f.queued.length > 0) return false; f.running.add(id); f.resumed.push(id); return true; },
      isBusy: (id) => f.busy.has(id),
      unqueueWhere: (_id, match) => { const before = f.queued.length; f.queued = f.queued.filter(text => !match(text)); return before - f.queued.length; },
      subscribe: (listener) => { f.chatListeners.push(listener); return () => { f.chatListeners.splice(f.chatListeners.indexOf(listener), 1); }; },
    },
    notify: {
      items: () => f.items,
      subscribe: (listener) => { f.notifyListeners.push(listener); return () => undefined; },
      ask: (question) => new Promise<NotifyResult>(resolve => { f.asks.push({ title: question.title, choices: (question.choices ?? []).map(choice => choice.label), resolve }); }),
    },
    every: (ms, run) => { const tick = { ms, run }; f.ticks.push(tick); return () => { f.ticks.splice(f.ticks.indexOf(tick), 1); }; },
    after: (ms, run) => { const timer = { ms, run }; f.timers.push(timer); return () => { const at = f.timers.indexOf(timer); if (at >= 0) f.timers.splice(at, 1); }; },
    sessions: { list: () => f.sessions, subscribe: () => () => undefined },
    watchFile: (file, onChange) => { f.watchers.set(file, onChange); return () => { f.watchers.delete(file); }; },
    launch: () => ({ kind: 'agent', mode: 'bypassPermissions' }),
    skillPath: '/pane/skills/pane-autopilot/SKILL.md',
    now: () => 1_000_000,
  };
  return f;
}

function item(id: string, extra: Partial<NotifyItem> = {}): NotifyItem {
  return { id, ui: 'approve', title: `Item ${id}`, state: 'waiting', createdAt: 900_000, source: { name: 'planner', agent: 'Claude', paneId: 'pane-a', panelId: 'panel-a' }, ...extra };
}

const snapshot0PanelId = (f: Fake) => [...f.tabs.keys()][0];
const settle = () => new Promise(resolve => setTimeout(resolve, 0));

beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'autopilot-manager-')); });
afterEach(() => { setAutopilotEntitlementForTests(undefined); fs.rmSync(root, { recursive: true, force: true }); });

describe('AutopilotManager: the switch and runs', () => {
  it('turning it on makes the current run with its owner Pane and a stopped chat tab, and starts no agent (J1, J2)', async () => {
    const f = fake();
    const manager = new AutopilotManager(f.ports);
    const snapshot = await manager.setEnabled(true);
    expect(snapshot.enabled).toBe(true);
    expect(snapshot.state).toBe('stopped');
    const run = snapshot.run!;
    expect(fs.readFileSync(path.join(root, 'current'), 'utf8').trim()).toBe(run.id);
    for (const name of ['AGENTS.md', 'docs', 'stack.json', 'state.json', 'log']) expect(fs.existsSync(path.join(run.folder, name))).toBe(true);
    expect(fs.readFileSync(path.join(run.folder, 'AGENTS.md'), 'utf8')).toContain('/pane/skills/pane-autopilot/SKILL.md');
    expect(f.owners.get(snapshot.ownerPaneId!)).toBe(run.folder);
    expect(f.tabs.get(snapshot.panelId!)).toMatchObject({ status: 'stopped', cwd: run.folder, autopilotRunId: run.id });
    expect(f.running.size).toBe(0);
    expect(f.sent).toEqual([]);
  });

  it('off, on, off, on keeps the same run and conversation', async () => {
    const f = fake();
    const manager = new AutopilotManager(f.ports);
    const first = (await manager.setEnabled(true)).run!.id;
    await manager.start();
    await manager.setEnabled(false);
    expect(f.running.size).toBe(0);
    expect(manager.snapshot().state).toBe('stopped');
    await manager.setEnabled(true);
    await manager.setEnabled(false);
    expect((await manager.setEnabled(true)).run!.id).toBe(first);
    expect(f.tabs.size).toBe(1);
  });

  it('needs chat tabs, and says so when they are off', async () => {
    const f = fake();
    f.chatTabs = false;
    const manager = new AutopilotManager(f.ports);
    await expect(manager.setEnabled(true)).rejects.toMatchObject({ code: 'AUTOPILOT_NEEDS_CHAT_TABS' });
    expect(f.enabled).toBe(false);
  });

  it('refuses to turn on or start when not entitled (D-65)', async () => {
    const f = fake();
    const manager = new AutopilotManager(f.ports);
    await manager.setEnabled(true);
    setAutopilotEntitlementForTests(false);
    await expect(manager.start()).rejects.toMatchObject({ code: 'AUTOPILOT_NOT_ENTITLED', next: expect.stringContaining('Autopilot') });
    await manager.setEnabled(false);
    await expect(manager.setEnabled(true)).rejects.toMatchObject({ code: 'AUTOPILOT_NOT_ENTITLED' });
    expect(manager.snapshot().entitlement.entitled).toBe(false);
  });

  it('refuses with AUTOPILOT_OFF while off, saying how to turn it on', async () => {
    const manager = new AutopilotManager(fake().ports);
    await expect(manager.start()).rejects.toMatchObject({ code: 'AUTOPILOT_OFF', next: expect.stringContaining('Settings') });
    expect(() => manager.pushToStack({ url: 'https://example.com' })).toThrow(expect.objectContaining({ code: 'AUTOPILOT_OFF' }));
  });

  it('Start starts the agent and tells it to walk; Pause and Go on tell it too', async () => {
    const f = fake();
    const manager = new AutopilotManager(f.ports);
    await manager.setEnabled(true);
    const started = await manager.start();
    expect(started.state).toBe('running');
    expect(f.running.has(started.panelId!)).toBe(true);
    expect(f.sent.at(-1)?.text).toMatch(/^\[Pane · Start\]/);
    expect(manager.pause().state).toBe('paused');
    expect(f.sent.at(-1)?.text).toMatch(/^\[Pane · Pause\]/);
    expect(manager.goOn().state).toBe('running');
    expect(f.sent.at(-1)?.text).toMatch(/^\[Pane · Go on\]/);
  });

  it('after a Pane restart the current run shows Start again with its stack kept (J2)', async () => {
    const f = fake();
    f.items = [item('q1')];
    const manager = new AutopilotManager(f.ports);
    await manager.setEnabled(true);
    await manager.start();
    manager.pushToStack({ item: 'q1' });
    const runId = manager.snapshot().run!.id;
    manager.dispose();
    f.running.clear();
    const stops: string[] = [];
    f.ports.chat.stop = async (id) => { stops.push(id); };
    const sentAtRestart = f.sent.length;
    const again = new AutopilotManager(f.ports);
    await again.initialize();
    expect(stops).toEqual([snapshot0PanelId(f)]);
    // The conversation reloads (the agent resumes its session), with no turn: nothing is sent before Start.
    expect(f.resumed).toEqual([snapshot0PanelId(f)]);
    expect(f.sent.length).toBe(sentAtRestart);
    const snapshot = again.snapshot();
    expect(snapshot.run?.id).toBe(runId);
    expect(snapshot.state).toBe('stopped');
    expect(snapshot.stack.entries.map(entry => entry.ref)).toEqual([{ kind: 'item', notifyId: 'q1' }]);
  });

  it('after a restart a tab with the person\'s messages queued stays stopped, so nothing is delivered before Start', async () => {
    const f = fake();
    const manager = new AutopilotManager(f.ports);
    await manager.setEnabled(true);
    await manager.start();
    manager.dispose();
    f.running.clear();
    f.queued = ['[Pane · Go on]', 'what is left in Billing?'];
    const again = new AutopilotManager(f.ports);
    await again.initialize();
    expect(f.queued).toEqual(['what is left in Billing?']);
    expect(f.resumed).toEqual([]);
    expect(f.running.size).toBe(0);
  });

  it('New Autopilot Session makes a new run with an empty stack; the old run\'s documents stay', async () => {
    const f = fake();
    f.items = [item('q1')];
    const manager = new AutopilotManager(f.ports);
    const old = (await manager.setEnabled(true)).run!;
    fs.writeFileSync(path.join(old.docsFolder, 'close-out.html'), '<h1>Close out</h1>');
    manager.pushToStack({ item: 'q1' });
    await manager.start();
    const next = await manager.newRun();
    expect(next.run!.id).not.toBe(old.id);
    expect(next.stack.entries).toEqual([]);
    expect(next.state).toBe('stopped');
    expect(fs.readFileSync(path.join(root, 'current'), 'utf8').trim()).toBe(next.run!.id);
    expect(fs.existsSync(path.join(old.docsFolder, 'close-out.html'))).toBe(true);
    expect(f.running.has(`__autopilot_panel_${old.id}`)).toBe(false);
    expect(f.tabs.has(next.panelId!)).toBe(true);
  });
});

describe('AutopilotManager: the published status schema', () => {
  it('describes every field a real snapshot carries, Sentinel included, so runpane prints it whole (F-2)', async () => {
    // SAFETY: the checked-in contract is JSON this test reads; only its status schema's keys are used.
    const contract = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../../../contracts/runpane/contract.json'), 'utf8')) as { jsonSchemas: { autopilotStatusResult: { required: string[]; properties: Record<string, { type?: string }> } } };
    const schema = contract.jsonSchemas.autopilotStatusResult;
    const f = fake();
    const manager = new AutopilotManager(f.ports);
    await manager.setEnabled(true);
    await manager.setSentinel(true);
    const status = { ok: true, ...manager.snapshot() };
    expect(status.sentinel).toBe(true);
    expect(Object.keys(status).filter(key => !(key in schema.properties))).toEqual([]);
    expect(schema.required.filter(key => !(key in status))).toEqual([]);
    expect(schema.required).toContain('sentinel');
  });
});

describe('AutopilotManager: stack and waiting', () => {
  it('puts a waiting item on the stack with its links as tabs, Question tab first', async () => {
    const f = fake();
    f.items = [item('q14', { title: 'Approve the chat tabs plan (r7)?', links: [{ label: 'cover-sheet.html', path: '/tmp/cover.html' }, { label: 'Test build', url: 'http://localhost:5173' }], source: { name: 'planner', agent: 'Claude', session: { id: 's1', name: 'Pane Fixes', paneId: 'o1', orchestrator: true } } })];
    const manager = new AutopilotManager(f.ports);
    await manager.setEnabled(true);
    const snapshot = manager.pushToStack({ item: 'q14', note: 'The planner recommends approving.' });
    const entry = snapshot.stack.entries[0];
    expect(entry).toMatchObject({ title: 'Approve the chat tabs plan (r7)?', sessionId: 's1', sessionName: 'Pane Fixes', note: 'The planner recommends approving.' });
    expect(entry.tabs).toEqual([
      { kind: 'item', label: 'Approval', notifyId: 'q14' },
      { kind: 'file', label: 'cover-sheet.html', path: '/tmp/cover.html' },
      { kind: 'url', label: 'Test build', url: 'http://localhost:5173' },
    ]);
    expect(snapshot.stack.shownId).toBe(entry.id);
    expect(snapshot.walk.sessionId).toBeUndefined();
  });

  it('brings the next entry up when the shown item is answered, and keeps a held answer on screen until Undo passes', async () => {
    const f = fake();
    f.items = [item('a'), item('b')];
    const manager = new AutopilotManager(f.ports);
    await manager.setEnabled(true);
    manager.pushToStack({ item: 'a' });
    manager.pushToStack({ item: 'b' });
    const first = manager.snapshot().stack.shownId;
    f.items = [item('a', { state: 'sent' }), item('b')];
    f.notifyListeners.forEach(listener => listener());
    expect(manager.snapshot().stack.shownId).toBe(first);
    f.items = [item('a', { state: 'answered' }), item('b')];
    f.notifyListeners.forEach(listener => listener());
    expect(manager.snapshot().stack.shownId).not.toBe(first);
    expect(manager.snapshot().stack.entries.find(entry => entry.id === first)?.doneAt).toBe(1_000_000);
  });

  it('says which entry each push made or refreshed, even with another Session or a same-named file on the stack (F-1)', async () => {
    const f = fake();
    f.sessions = [{ id: 's-a', name: 'Session A', paneId: 'o-a' }, { id: 's-b', name: 'Session B', paneId: 'o-b' }];
    for (const folder of ['project-a', 'project-b']) { fs.mkdirSync(path.join(root, folder)); fs.writeFileSync(path.join(root, folder, 'plan.html'), '<p>plan</p>'); }
    const manager = new AutopilotManager(f.ports);
    await manager.setEnabled(true);
    expect(manager.push({ session: 's-a' }).entry).toMatchObject({ ref: { kind: 'session', sessionId: 's-a' } });
    expect(manager.push({ session: 'Session B' }).entry).toMatchObject({ ref: { kind: 'session', sessionId: 's-b' } });
    expect(manager.push({ file: path.join(root, 'project-a', 'plan.html') }).entry).toMatchObject({ ref: { kind: 'file', path: path.join(root, 'project-a', 'plan.html') } });
    const second = manager.push({ file: path.join(root, 'project-b', 'plan.html') });
    expect(second.entry).toMatchObject({ ref: { kind: 'file', path: path.join(root, 'project-b', 'plan.html') } });
    // Pushing Session A again refreshes its entry rather than adding one.
    const again = manager.push({ session: 's-a', note: 'Still open' });
    expect(again.entry).toMatchObject({ ref: { kind: 'session', sessionId: 's-a' }, note: 'Still open' });
    expect(again.snapshot.stack.entries.filter(entry => entry.ref.kind === 'session' && entry.ref.sessionId === 's-a')).toHaveLength(1);
    expect(again.snapshot.stack.entries.map(entry => entry.id)).toContain(again.entry.id);
  });

  it('refuses a push that names no target or a missing file, adding nothing', async () => {
    const f = fake();
    const manager = new AutopilotManager(f.ports);
    await manager.setEnabled(true);
    expect(() => manager.pushToStack({})).toThrow(expect.objectContaining({ code: 'AUTOPILOT_STACK_INVALID' }));
    expect(() => manager.pushToStack({ file: '/nope/missing.html' })).toThrow(expect.objectContaining({ code: 'AUTOPILOT_STACK_INVALID' }));
    expect(() => manager.pushToStack({ url: 'javascript:alert(1)' })).toThrow(expect.objectContaining({ code: 'AUTOPILOT_STACK_INVALID' }));
    expect(manager.snapshot().stack.entries).toEqual([]);
  });

  it('marks a document in its own run folder as written by Autopilot', async () => {
    const f = fake();
    const manager = new AutopilotManager(f.ports);
    const run = (await manager.setEnabled(true)).run!;
    const doc = path.join(run.docsFolder, 'close-out-pane-fixes.html');
    fs.writeFileSync(doc, '<h1>x</h1>');
    const entry = manager.pushToStack({ file: 'docs/close-out-pane-fixes.html', title: 'Close out Pane Fixes' }).stack.entries[0];
    expect(entry).toMatchObject({ byAutopilot: true, ref: { kind: 'file', path: doc } });
  });

  it('refuses new entries from Autopilot while paused, but the person can still push', async () => {
    const f = fake();
    const manager = new AutopilotManager(f.ports);
    const snapshot = await manager.setEnabled(true);
    await manager.start();
    manager.pause();
    expect(() => manager.pushToStack({ url: 'https://example.com' }, { panelId: snapshot.panelId! })).toThrow(expect.objectContaining({ code: 'AUTOPILOT_PAUSED' }));
    expect(manager.pushToStack({ url: 'https://example.com' }).stack.entries).toHaveLength(1);
  });

  it('lists waiting items by Session in sidebar order, oldest first within one, other machines last', async () => {
    const f = fake();
    f.sessions = [{ id: 'A', name: 'A', paneId: 'oa' }, { id: 'B', name: 'B', paneId: 'ob' }];
    const inA = { id: 'A', name: 'A', paneId: 'oa', orchestrator: true };
    const inB = { id: 'B', name: 'B', paneId: 'ob', orchestrator: true };
    f.items = [
      item('b1', { createdAt: 1, source: { name: 'o', agent: 'Claude', session: inB } }),
      item('far', { createdAt: 0, machineId: 'studio', machine: 'studio', source: { name: 'x', agent: 'Claude' } }),
      item('a2', { createdAt: 5, source: { name: 'o', agent: 'Claude', session: inA } }),
      item('a1', { createdAt: 3, source: { name: 'o', agent: 'Claude', session: inA } }),
      item('done', { state: 'answered', source: { name: 'o', agent: 'Claude', session: inA } }),
    ];
    const manager = new AutopilotManager(f.ports);
    await manager.setEnabled(true);
    expect(manager.waiting().map(entry => entry.id)).toEqual(['a1', 'a2', 'b1', 'far']);
    expect(manager.snapshot().walk.sessions).toEqual([{ id: 'A', name: 'A', waiting: 2 }, { id: 'B', name: 'B', waiting: 1 }]);
  });
});

describe('AutopilotManager: approvals are always the person\'s (D-66)', () => {
  it('refuses an answer from Autopilot\'s tab or owner Pane, and lets anyone else through', async () => {
    const manager = new AutopilotManager(fake().ports);
    const snapshot = await manager.setEnabled(true);
    expect(() => manager.refuseAnswerFrom({ panelId: snapshot.panelId! }, 'Q-14')).toThrow(expect.objectContaining({ code: 'AUTOPILOT_CANNOT_ANSWER' }));
    expect(() => manager.refuseAnswerFrom({ paneId: snapshot.ownerPaneId! }, 'Q-14')).toThrow(expect.objectContaining({ code: 'AUTOPILOT_CANNOT_ANSWER' }));
    expect(() => manager.refuseAnswerFrom({ panelId: 'panel-a', paneId: 'pane-a' }, 'Q-14')).not.toThrow();
    expect(() => manager.refuseAnswerFrom(undefined, 'Q-14')).not.toThrow();
    await settle();
  });
});

describe('AutopilotManager: it keeps driving (D-146)', () => {
  const carryOns = (f: Fake) => f.sent.filter(message => message.text.startsWith('[Pane · Carry on]'));
  const status = (f: Fake, panelId: string, busy: boolean) => {
    if (busy) f.busy.add(panelId); else f.busy.delete(panelId);
    f.chatListeners.forEach(listener => listener(panelId));
  };
  const fire = (f: Fake) => { const timer = f.timers.shift(); timer?.run(); return timer; };

  it('wakes the agent to carry on after it sits idle, at most 3 times in a row without the person', async () => {
    const f = fake();
    const manager = new AutopilotManager(f.ports);
    await manager.setEnabled(true);
    await manager.start();
    const panelId = manager.snapshot().panelId!;
    status(f, panelId, true);
    expect(f.timers).toEqual([]);
    for (let round = 1; round <= 3; round += 1) {
      status(f, panelId, false);
      expect(fire(f)?.ms).toBe(3 * 60_000);
      expect(carryOns(f)).toHaveLength(round);
      // Its own wake-up starts the next turn: that doesn't count as the person.
      status(f, panelId, true);
    }
    status(f, panelId, false);
    expect(f.timers).toEqual([]);
    // The person writes (a turn Pane didn't start): it drives again.
    status(f, panelId, true);
    status(f, panelId, false);
    fire(f);
    expect(carryOns(f)).toHaveLength(4);
  });

  it('does not drive while paused, with Sentinel on (its checks do that), or once off', async () => {
    const f = fake();
    const manager = new AutopilotManager(f.ports);
    await manager.setEnabled(true);
    await manager.start();
    const panelId = manager.snapshot().panelId!;
    status(f, panelId, false);
    expect(f.timers).toHaveLength(1);
    manager.pause();
    expect(f.timers).toEqual([]);
    status(f, panelId, false);
    expect(f.timers).toEqual([]);
    manager.goOn();
    await manager.setSentinel(true);
    status(f, panelId, false);
    expect(f.timers).toEqual([]);
    await manager.setSentinel(false);
    status(f, panelId, false);
    expect(f.timers).toHaveLength(1);
    await manager.setEnabled(false);
    expect(f.timers).toEqual([]);
    expect(carryOns(f)).toEqual([]);
  });
});

describe('AutopilotManager: Sentinel (package 7)', () => {
  it('opening Autopilot with Sentinel on asks for the While you were away card whenever Sentinel made calls you have not seen, however soon (review F-6 round 2, J29)', async () => {
    const f = fake();
    const manager = new AutopilotManager(f.ports);
    const run = (await manager.setEnabled(true)).run!;
    const awayLog = path.join(run.docsFolder, 'away-log.html');
    // An away log left from an earlier time away is not new.
    fs.writeFileSync(awayLog, '<p>earlier</p>');
    await manager.setSentinel(true);
    const back = () => f.sent.filter(message => message.text.startsWith('[Pane · Back]'));
    // Nothing logged since Sentinel went on: nothing to sum up.
    manager.opened();
    expect(back()).toEqual([]);
    // Sentinel answers a question while the person looks away for a moment.
    fs.appendFileSync(awayLog, '<p>10:12 answered</p>');
    manager.opened();
    expect(back()).toHaveLength(1);
    expect(back()[0].text).toContain('autopilot-away');
    // Switching views again, with no new call, asks for nothing more.
    manager.opened();
    manager.opened();
    expect(back()).toHaveLength(1);
    // Another call, another short return: another card.
    fs.appendFileSync(awayLog, '<p>10:15 nudged</p>');
    manager.opened();
    expect(back()).toHaveLength(2);
    expect(manager.snapshot().sentinel).toBe(true);
  });

  it('opening a stopped or Sentinel-off Autopilot sends nothing (no turn before Start)', async () => {
    let clock = 1_000_000;
    const f = fake();
    f.ports.now = () => clock;
    const manager = new AutopilotManager(f.ports);
    await manager.setEnabled(true);
    clock += 60 * 60_000;
    manager.opened();
    await manager.start();
    clock += 60 * 60_000;
    manager.opened();
    expect(f.sent.map(message => message.text.split(']')[0] + ']')).toEqual(['[Pane · Start]']);
  });

  it('notices when its agent exits on its own: stopped, Sentinel off and saved, checks end, and the phone hears it (review F-4)', async () => {
    const f = fake();
    const manager = new AutopilotManager(f.ports);
    await manager.setEnabled(true);
    await manager.setSentinel(true);
    const panelId = manager.snapshot().panelId!;
    // The adapter exits: the chat tab stops with a problem.
    f.running.delete(panelId);
    f.chatListeners.forEach(listener => listener(panelId));
    const snapshot = manager.snapshot();
    expect(snapshot).toMatchObject({ state: 'stopped', sentinel: false });
    expect(f.ticks).toEqual([]);
    expect(JSON.parse(fs.readFileSync(path.join(snapshot.run!.folder, 'state.json'), 'utf8'))).toMatchObject({ state: 'stopped' });
    expect(JSON.parse(fs.readFileSync(path.join(snapshot.run!.folder, 'state.json'), 'utf8')).sentinel).toBeUndefined();
    expect(f.asks.map(ask => ask.title)).toEqual([expect.stringMatching(/Autopilot stopped/)]);
    expect(fs.readFileSync(path.join(snapshot.run!.folder, 'log'), 'utf8')).toMatch(/agent stopped on its own/);
    // Answering "Start again with Sentinel" brings both back.
    f.asks[0].resolve({ answer: f.asks[0].choices[0] });
    await settle();
    expect(manager.snapshot()).toMatchObject({ state: 'running', sentinel: true });
  });

  it('ignores chat changes while it is stopped or stopping the agent itself, and other tabs', async () => {
    const f = fake();
    const manager = new AutopilotManager(f.ports);
    await manager.setEnabled(true);
    const panelId = manager.snapshot().panelId!;
    f.chatListeners.forEach(listener => listener(panelId));
    expect(manager.snapshot().state).toBe('stopped');
    await manager.start();
    f.chatListeners.forEach(listener => listener('some-other-tab'));
    expect(manager.snapshot().state).toBe('running');
    // Pausing keeps the agent alive; a change then changes nothing.
    manager.pause();
    f.chatListeners.forEach(listener => listener(panelId));
    expect(manager.snapshot().state).toBe('paused');
    // Turning off stops the agent on purpose: no question for the person.
    f.ports.chat.stop = async (id) => { f.running.delete(id); f.chatListeners.forEach(listener => listener(id)); };
    await manager.setEnabled(false);
    expect(f.asks).toEqual([]);
    expect(fs.readFileSync(path.join(manager.snapshot().run!.folder, 'log'), 'utf8')).not.toMatch(/stopped on its own/);
  });

  it('turning Sentinel on starts Autopilot, tells the agent, and checks in every 5 minutes while it is idle', async () => {
    const f = fake();
    const manager = new AutopilotManager(f.ports);
    await manager.setEnabled(true);
    const snapshot = await manager.setSentinel(true);
    expect(snapshot).toMatchObject({ state: 'running', sentinel: true });
    expect(f.sent.map(message => message.text.split(']')[0] + ']')).toEqual(['[Pane · Start]', '[Pane · Sentinel on]']);
    expect(f.ticks.map(tick => tick.ms)).toEqual([5 * 60_000]);
    f.ticks[0].run();
    expect(f.sent.at(-1)?.text).toMatch(/^\[Pane · Sentinel check\]/);
    // A turn still running, or Pause, skips the check instead of queueing behind it.
    f.busy.add(snapshot.panelId!);
    f.ticks[0].run();
    f.busy.clear();
    manager.pause();
    f.ticks[0].run();
    expect(f.sent.filter(message => message.text.startsWith('[Pane · Sentinel check]'))).toHaveLength(1);
  });

  it('turning it off stops the checks and asks for the While you were away card', async () => {
    const f = fake();
    const manager = new AutopilotManager(f.ports);
    await manager.setEnabled(true);
    await manager.setSentinel(true);
    const off = await manager.setSentinel(false);
    expect(off.sentinel).toBe(false);
    expect(f.ticks).toEqual([]);
    expect(f.sent.at(-1)?.text).toMatch(/^\[Pane · Sentinel off\].*While you were away/);
  });

  it('after a Pane restart Sentinel is off, and the person gets a push saying so, which can turn it back on', async () => {
    const f = fake();
    const manager = new AutopilotManager(f.ports);
    await manager.setEnabled(true);
    await manager.setSentinel(true);
    manager.dispose();
    f.ticks.length = 0;
    const again = new AutopilotManager(f.ports);
    await again.initialize();
    expect(again.snapshot()).toMatchObject({ sentinel: false, state: 'stopped' });
    expect(f.asks.map(ask => [ask.title, ask.choices])).toEqual([['Sentinel stopped: Pane restarted', ['Turn Sentinel back on', 'Leave it off']]]);
    f.asks[0].resolve({ answer: 'Turn Sentinel back on' });
    await settle(); await settle();
    expect(again.snapshot()).toMatchObject({ sentinel: true, state: 'running' });
  });

  it('turning Autopilot off turns Sentinel off', async () => {
    const f = fake();
    const manager = new AutopilotManager(f.ports);
    await manager.setEnabled(true);
    await manager.setSentinel(true);
    await manager.setEnabled(false);
    expect(manager.snapshot().sentinel).toBe(false);
    expect(f.ticks).toEqual([]);
  });

  it('from Pause, turning Sentinel on sends only the Sentinel line (it implies Go on)', async () => {
    const f = fake();
    const manager = new AutopilotManager(f.ports);
    await manager.setEnabled(true);
    await manager.start();
    manager.pause();
    const before = f.sent.length;
    await manager.setSentinel(true);
    expect(manager.snapshot().state).toBe('running');
    expect(f.sent.slice(before).map(message => message.text.split(']')[0] + ']')).toEqual(['[Pane · Sentinel on]']);
  });

  it('after a restart, drops Pane\'s own control lines still queued for the agent, and keeps the person\'s', async () => {
    const f = fake();
    const manager = new AutopilotManager(f.ports);
    await manager.setEnabled(true);
    manager.dispose();
    f.queued = ['[Pane · Sentinel on] The person turned on Sentinel Mode', 'Please check Infra', '[Pane · Sentinel check] Five minutes'];
    const again = new AutopilotManager(f.ports);
    await again.initialize();
    expect(f.queued).toEqual(['Please check Infra']);
  });
});

describe('AutopilotManager: the person\'s own instructions (D-196)', () => {
  const file = () => path.join(root, 'instructions.md');

  it('reads and writes a plain file next to its runs, and shows the built-in instructions they add to', async () => {
    const f = fake();
    const manager = new AutopilotManager(f.ports);
    await manager.setEnabled(true);
    const empty = manager.instructions();
    expect(empty).toMatchObject({ text: '', path: file(), status: 'none' });
    expect(empty.builtIn).toContain('Never answer a permission prompt');
    expect(empty.builtIn).toContain('[Pane · Start]');

    const saved = await manager.setInstructions('Group things by repo.\nBe brief.');
    expect(fs.readFileSync(file(), 'utf8')).toBe('Group things by repo.\nBe brief.\n');
    // Not running: nothing is sent; the next Start applies them.
    expect(saved).toMatchObject({ text: 'Group things by repo.\nBe brief.', status: 'next-start' });
    expect(f.sent).toEqual([]);

    fs.writeFileSync(file(), 'Focus on Bloom first.\n');
    expect(manager.instructions().text).toBe('Focus on Bloom first.');
  });

  it('Start puts them in its brief after Pane\'s rules, labelled as the person\'s, and in AGENTS.md after Never', async () => {
    const f = fake();
    const manager = new AutopilotManager(f.ports);
    const run = (await manager.setEnabled(true)).run!;
    await manager.setInstructions('Always ask before closing anything.');
    await manager.start();
    const start = f.sent.at(-1)!.text;
    expect(start).toMatch(/^\[Pane · Start\]/);
    expect(start.indexOf('Always ask before closing anything.')).toBeGreaterThan(start.indexOf('drive'));
    expect(start).toMatch(/The person's own instructions/);
    expect(start).toMatch(/never override/i);
    const agents = fs.readFileSync(path.join(run.folder, 'AGENTS.md'), 'utf8');
    expect(agents.indexOf('Always ask before closing anything.')).toBeGreaterThan(agents.indexOf('## Never'));
    expect(agents).toContain(file());
    expect(manager.instructions().status).toBe('applied');
  });

  it('while it runs a save reaches the agent at once, as a Pane line; Reset clears them the same way', async () => {
    const f = fake();
    const manager = new AutopilotManager(f.ports);
    await manager.setEnabled(true);
    await manager.start();
    expect(f.sent.at(-1)!.text).not.toMatch(/own instructions/);
    expect((await manager.setInstructions('Be brief.')).status).toBe('applied');
    expect(f.sent.at(-1)!.text).toMatch(/^\[Pane · Instructions\][\s\S]*Be brief\./);
    const sends = f.sent.length;
    await manager.setInstructions('Be brief.\n');
    expect(f.sent.length).toBe(sends);
    expect((await manager.setInstructions('  ')).status).toBe('none');
    expect(f.sent.at(-1)!.text).toMatch(/^\[Pane · Instructions\].*cleared/);
    expect(fs.readFileSync(file(), 'utf8')).toBe('');
  });

  it('an edit to the file itself (an editor, the CLI) reaches a running agent too, and waits for Start when stopped', async () => {
    const f = fake();
    const manager = new AutopilotManager(f.ports);
    await manager.setEnabled(true);
    fs.writeFileSync(file(), 'Group by repo.\n');
    f.watchers.get(file())?.();
    expect(f.sent).toEqual([]);
    expect(manager.instructions().status).toBe('next-start');
    await manager.start();
    fs.writeFileSync(file(), 'Group by repo.\nBe brief.\n');
    f.watchers.get(file())!();
    expect(f.sent.at(-1)!.text).toMatch(/^\[Pane · Instructions\][\s\S]*Be brief\./);
    expect(manager.instructions().status).toBe('applied');
    await manager.setEnabled(false);
    expect(manager.instructions().status).toBe('next-start');
  });

  it('refuses instructions too long to be a brief, changing nothing', async () => {
    const f = fake();
    const manager = new AutopilotManager(f.ports);
    await manager.setEnabled(true);
    await expect(manager.setInstructions('x'.repeat(20_001))).rejects.toMatchObject({ code: 'AUTOPILOT_INSTRUCTIONS_TOO_LONG' });
    expect(fs.existsSync(file())).toBe(false);
  });
});
