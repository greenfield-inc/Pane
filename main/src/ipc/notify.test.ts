import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ipcMain } from 'electron';
import path from 'path';
import { pathToFileURL } from 'url';
import { PaneCommandRegistry } from '../daemon/commandRegistry';
import { remotePaneClientController } from '../daemon/client/remotePaneClient';
import { followSavedMachines, registerNotifyHandlers, type NotifyMachines, tabTakesText } from './notify';
import { PaneError } from '../../../shared/paneError';
import { boundary, decodeBoundary } from '../../../shared/validation/boundaryDecoder';
import { ConfigManager } from '../services/configManager';
import { resetPaneRuntimeForTests, setPaneRuntime } from '../core/runtime';
import type { NotifyItem, NotifyResult, NotifySharedState } from '../../../shared/types/notify';
import type { MachineConnectionsEvent, MachineState } from '../../../shared/types/machineConnections';
import type { PaneCommandValue } from '../daemon/commandRegistry';
import type { RemotePaneConnectionState } from '../../../shared/types/remoteDaemon';
import type { SessionInboxEnded } from '../services/sessionInbox';
import type { RunpaneInboxItem } from '../../../shared/types/runpaneOrchestration';

/** A Pane's Notify handlers, registered the way the app registers them; no window or phone. */
async function startPane() {
  const registry = new PaneCommandRegistry();
  const configManager = new ConfigManager();
  await configManager.initialize();
  // Show outside Pane off: no floating windows in a test.
  await configManager.updateConfig({ notify: { showOutsidePane: false } });
  const services = { configManager, sessionManager: { getSession: () => undefined }, getMainWindow: () => null };
  return { registry, notify: registerNotifyHandlers(ipcMain, services, registry) };
}

const connected: RemotePaneConnectionState = {
  mode: 'remote', status: 'connected', activeProfileId: 'host-1', activeProfileLabel: 'mac-studio',
  activeBaseUrl: 'http://127.0.0.1:47911', lastError: null, lastSeenAt: null,
};
const flush = () => new Promise(resolve => setTimeout(resolve, 0));
/** Lets Notify's coalesced broadcast (one per tick) run. */
const settle = async () => { await flush(); await new Promise(resolve => setImmediate(resolve)); };

/** A waiting question as a machine shares it. */
function question(id: string, title: string, createdAt: number): NotifyItem {
  return { id, ui: 'approve', title, source: { name: 'api', agent: 'Claude' }, state: 'waiting', createdAt };
}

function stateOf(machine: string, ...items: NotifyItem[]): NotifySharedState {
  return { machine, epoch: `${machine}-started`, revision: 1, enabled: true, items, queue: items.map(item => item.id), hidden: [] };
}

/** Saved machines (id to its Notify state) behind a stand-in for the machine connections; records every command run. */
function savedMachines(states: Record<string, NotifySharedState>, initial: MachineState['status'] = 'online') {
  const listeners = new Set<(event: MachineConnectionsEvent) => void>();
  const statuses = new Map(Object.keys(states).map(id => [id, initial]));
  const sent: Array<[string, PaneCommandValue]> = [];
  const list = (): MachineState[] => [
    { id: 'local', label: 'This computer', kind: 'local', status: 'online', offlineSince: null },
    ...Object.keys(states).map((id): MachineState => ({ id, label: states[id].machine, kind: 'remote', status: statuses.get(id) ?? 'online', offlineSince: null })),
  ];
  const emit = (event: MachineConnectionsEvent) => { for (const listener of [...listeners]) listener(event); };
  const machines: NotifyMachines = {
    list,
    subscribe: (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    read: (machineId) => Promise.resolve({ machineId, data: states[machineId] }),
    run: (machineId, command) => { sent.push([machineId, command]); return Promise.resolve({ machineId, data: null }); },
  };
  return {
    machines,
    sent,
    emit,
    status: (id: string) => statuses.get(id),
    setStatus: (id: string, status: MachineState['status']) => { statuses.set(id, status); emit({ type: 'machines', machines: list() }); },
  };
}

describe('Notify across machines, through the registered handlers', () => {
  beforeEach(() => vi.stubEnv('PANE_DISABLE_OS_INTEGRATION', '1'));
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    for (const event of ['notify-shared', 'resync', 'state-changed']) remotePaneClientController.removeAllListeners(event);
  });

  it('lets another device read the queue, answer it in its own name, and be refused once it is answered', async () => {
    const host = await startPane();
    const call = host.registry.invoke<NotifyResult>('runpane:notify', [{ ui: 'approve', title: 'Apply migration 0042?', caller: { cwd: '/repo/api' } }]);
    await flush();
    const state = await host.registry.invoke<NotifySharedState>('notify:remote-snapshot', []);
    expect(state.items).toMatchObject([{ state: 'waiting', source: { name: 'api' } }]);
    const id = state.items[0].id;

    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    await host.registry.invoke('notify:remote-command', [{ type: 'answer', id, answer: { approved: true } }, { device: 'parsa-air' }]);
    await expect(host.registry.invoke('notify:remote-command', [{ type: 'answer', id, answer: { approved: false } }, { device: 'parsa-mini' }]))
      .rejects.toMatchObject({ code: 'ERR_NOTIFY_ANSWERED', message: 'Already answered by you on parsa-air. Nothing was sent.' });
    await vi.advanceTimersByTimeAsync(3_000);
    vi.useRealTimers();
    expect(await call).toEqual({ approved: true });
    host.notify.dispose();
  });

  it('counts one question from each of three machines, and each card names its machine', async () => {
    const pane = await startPane();
    const saved = savedMachines({ studio: stateOf('mac-studio', question('q-1', 'Ship the hotfix tonight?', 1_000)), devbox: stateOf('parsa-devbox', question('q-7', 'Apply migration 0042?', 2_000)) });
    followSavedMachines(saved.machines);
    void pane.notify.ask({ ui: 'approve', title: 'Delete the old branch?', caller: { cwd: '/repo/api' } });
    await flush();

    const waiting = pane.notify.snapshot().items.filter(item => item.state === 'waiting');
    expect(waiting).toHaveLength(3);
    expect(pane.notify.queue.waitingItems()).toHaveLength(3);
    expect(waiting.map(item => [item.title, item.machineId])).toEqual([
      ['Delete the old branch?', 'local'],
      ['Ship the hotfix tonight?', 'studio'],
      ['Apply migration 0042?', 'devbox'],
    ]);
    expect(waiting.slice(1).map(item => [item.id, item.machine])).toEqual([['studio:q-1', 'mac-studio'], ['devbox:q-7', 'parsa-devbox']]);
    pane.notify.dispose();
  });

  it('refuses a secret card a teammate posts, so the owner never sees one to answer', async () => {
    const host = await startPane();
    setPaneRuntime({ eventSink: { send: () => undefined }, getConfigManager: () => new ConfigManager(), getPtyHostRuntime: () => null, getWebviewContextMap: () => new Map() });

    const call = host.registry.invokeRemote('runpane:notify', [{ ui: 'secret', title: 'Stripe key', secret: { project: 'stripe', name: 'STRIPE_SECRET_KEY' }, caller: { cwd: '/repo/api' } }], { teammate: 'bob@example.com' });
    call.catch(() => undefined);
    await flush();

    expect(host.notify.snapshot().items).toEqual([]);
    await expect(call).rejects.toMatchObject({ code: 'SECRET_OWNER_REQUIRED' });
    resetPaneRuntimeForTests();
    host.notify.dispose();
  });

  it('shows another machine\'s secret card and sends the typed value only to that machine', async () => {
    const pane = await startPane();
    const card: NotifyItem = { ...question('q-9', 'Stripe test secret key', 1_000), ui: 'secret', secret: { project: 'stripe', name: 'STRIPE_SECRET_KEY', replaces: true } };
    const saved = savedMachines({ studio: stateOf('mac-studio', card) });
    followSavedMachines(saved.machines);
    await flush();
    expect(pane.notify.snapshot().items.find(item => item.id === 'studio:q-9')).toMatchObject({ ui: 'secret', secret: { project: 'stripe', replaces: true } });

    await pane.notify.run({ type: 'answer', id: 'studio:q-9', answer: { text: 'pane-canary-remote' } });

    expect(saved.sent).toEqual([['studio', { type: 'notify', command: { type: 'answer', id: 'q-9', answer: { text: 'pane-canary-remote' } } }]]);
    expect(JSON.stringify(pane.notify.snapshot())).not.toContain('pane-canary-remote');
    pane.notify.dispose();
  });

  it("sends one answer when another machine's card is answered twice before that machine replies", async () => {
    const pane = await startPane();
    const saved = savedMachines({ studio: stateOf('mac-studio', question('q-1', 'Ship it?', 1_000)) });
    let reply = () => undefined as void;
    const run = saved.machines.run;
    saved.machines.run = (machineId, command) => new Promise(resolve => { reply = () => resolve(run(machineId, command)); });
    followSavedMachines(saved.machines);
    await flush();

    const first = pane.notify.run({ type: 'answer', id: 'studio:q-1', answer: { approved: true } });
    await flush();
    // Before the machine replies: the card reads "Sent to" and leaves the round.
    expect(pane.notify.snapshot().items.find(item => item.id === 'studio:q-1')?.state).toBe('sent');
    expect(pane.notify.snapshot().queue).toEqual([]);
    await expect(pane.notify.run({ type: 'answer', id: 'studio:q-1', answer: { approved: false } })).resolves.toBeUndefined();
    reply();
    await first;

    expect(saved.sent).toEqual([['studio', { type: 'notify', command: { type: 'answer', id: 'q-1', answer: { approved: true } } }]]);
    pane.notify.dispose();
  });

  it('keeps the same question id on two machines as two cards, and an answer reaches only its own machine', async () => {
    const pane = await startPane();
    const saved = savedMachines({ studio: stateOf('mac-studio', question('q-1', 'Ship it?', 1_000)), devbox: stateOf('parsa-devbox', question('q-1', 'Ship it?', 2_000)) });
    followSavedMachines(saved.machines);
    await flush();
    expect(pane.notify.snapshot().queue).toEqual(['studio:q-1', 'devbox:q-1']);

    await pane.notify.run({ type: 'answer', id: 'devbox:q-1', answer: { approved: true } });
    await pane.notify.run({ type: 'skip', id: 'studio:q-1' });
    expect(saved.sent).toEqual([
      ['devbox', { type: 'notify', command: { type: 'answer', id: 'q-1', answer: { approved: true } } }],
      ['studio', { type: 'notify', command: { type: 'skip', id: 'q-1' } }],
    ]);
    pane.notify.dispose();
  });

  it("shows the machine the app is on once, and this computer's own question once", async () => {
    vi.spyOn(remotePaneClientController, 'getConnectionState').mockReturnValue(connected);
    vi.spyOn(remotePaneClientController, 'isRemoteModeActive').mockReturnValue(true);
    const pane = await startPane();
    void pane.notify.ask({ ui: 'approve', title: 'Delete the old branch?', caller: { cwd: '/repo/api' } });
    const studio = stateOf('mac-studio', question('q-1', 'Ship the hotfix tonight?', 1_000));
    // `self` is a saved machine that turns out to be this same running Pane.
    const saved = savedMachines({ 'host-1': studio, self: pane.notify.sharedState() });
    followSavedMachines(saved.machines);
    await flush();

    // The active connection's own stream, this computer's forwarded event and the machine's event all arrive.
    remotePaneClientController.emit('notify-shared', studio);
    saved.emit({ type: 'event', machineId: 'local', channel: 'notify:shared-changed', args: [pane.notify.sharedState()] });
    saved.emit({ type: 'event', machineId: 'host-1', channel: 'notify:shared-changed', args: [{ ...studio, revision: 2 }] });
    await flush();
    expect(pane.notify.snapshot().items.filter(item => item.state === 'waiting').map(item => item.title)).toEqual(['Delete the old branch?', 'Ship the hotfix tonight?']);
    // The machine the app is on keeps Open in Pane.
    expect(pane.notify.snapshot().items.find(item => item.id === 'host-1:q-1')?.elsewhere).toBeUndefined();
    pane.notify.dispose();
  });

  it("refuses a teammate acting as Autopilot on another machine's item before passing it on", async () => {
    const pane = await startPane();
    const saved = savedMachines({ studio: stateOf('mac-studio', question('q-1', 'Ship it?', 1_000)) });
    followSavedMachines(saved.machines);
    await flush();

    await expect(pane.notify.runRemote({ type: 'agent-answer', id: 'studio:q-1', answer: { approved: true }, because: 'trust me' }, 'build-mac', 'teammate@example.com'))
      .rejects.toMatchObject({ code: 'ERR_NOTIFY_NOT_AUTOPILOT' });
    expect(saved.sent).toEqual([]);
    pane.notify.dispose();
  });

  it("keeps an offline machine's question, dimmed and unanswerable, until it answers again", async () => {
    const pane = await startPane();
    const saved = savedMachines({ studio: stateOf('mac-studio', question('q-1', 'Ship it?', 1_000)) });
    followSavedMachines(saved.machines);
    await flush();

    saved.setStatus('studio', 'offline');
    expect(pane.notify.snapshot().items).toMatchObject([{ id: 'studio:q-1', state: 'waiting', unreachable: true, elsewhere: true }]);
    await expect(pane.notify.run({ type: 'answer', id: 'studio:q-1', answer: { approved: true } })).rejects.toMatchObject({ code: 'ERR_APPROVALS_MACHINE_OFFLINE' });
    expect(saved.sent).toEqual([]);

    saved.setStatus('studio', 'online');
    await flush();
    expect(pane.notify.snapshot().items[0].unreachable).toBeUndefined();
    await pane.notify.run({ type: 'answer', id: 'studio:q-1', answer: { approved: true } });
    expect(saved.sent).toEqual([['studio', { type: 'notify', command: { type: 'answer', id: 'q-1', answer: { approved: true } } }]]);
    pane.notify.dispose();
  });

  it('keeps a question that arrives while a reconnect read is in flight', async () => {
    const pane = await startPane();
    const saved = savedMachines({ studio: stateOf('mac-studio') });
    followSavedMachines(saved.machines);
    await flush();
    let finishRead: (state: NotifySharedState) => void = () => undefined;
    saved.machines.read = () => new Promise(resolve => { finishRead = state => resolve({ machineId: 'studio', data: state }); });

    // The reconnect read sees an empty queue; a question arrives as an event before the read returns.
    saved.emit({ type: 'resync', machineId: 'studio' });
    saved.emit({ type: 'event', machineId: 'studio', channel: 'notify:shared-changed', args: [{ ...stateOf('mac-studio', question('q-1', 'Which region?', 1_000)), revision: 2 }] });
    finishRead(stateOf('mac-studio'));
    await flush();
    expect(pane.notify.snapshot().queue).toEqual(['studio:q-1']);
    pane.notify.dispose();
  });

  it("publishes its own questions only, never another machine's arriving", async () => {
    const pane = await startPane();
    const published: unknown[] = [];
    setPaneRuntime({
      eventSink: { send: (channel, ...args) => { if (channel === 'notify:shared-changed') published.push(args[0]); } },
      getConfigManager: () => new ConfigManager(),
      getPtyHostRuntime: () => null,
      getWebviewContextMap: () => new Map(),
    });
    const saved = savedMachines({ devbox: stateOf('parsa-devbox') });
    followSavedMachines(saved.machines);
    await settle();
    published.length = 0;

    // Two desktops saved as each other: the other's state arriving must not send one back.
    saved.emit({ type: 'event', machineId: 'devbox', channel: 'notify:shared-changed', args: [{ ...stateOf('parsa-devbox', question('q-1', 'Ship it?', 1_000)), revision: 2 }] });
    await settle();
    expect(published).toEqual([]);

    void pane.notify.ask({ ui: 'approve', title: 'Delete the old branch?', caller: { cwd: '/repo/api' } });
    await settle();
    expect(published).toMatchObject([{ items: [{ title: 'Delete the old branch?', state: 'waiting' }] }]);
    resetPaneRuntimeForTests();
    pane.notify.dispose();
  });

  it('keeps a machine that went offline during its read unanswerable when the read lands', async () => {
    const pane = await startPane();
    const saved = savedMachines({ studio: stateOf('mac-studio') });
    followSavedMachines(saved.machines);
    await flush();
    let finishRead: (state: NotifySharedState) => void = () => undefined;
    saved.machines.read = () => new Promise(resolve => { finishRead = state => resolve({ machineId: 'studio', data: state }); });

    saved.emit({ type: 'resync', machineId: 'studio' });
    saved.setStatus('studio', 'offline');
    finishRead({ ...stateOf('mac-studio', question('q-1', 'Ship it?', 1_000)), revision: 2 });
    await flush();

    expect(pane.notify.snapshot().items).toMatchObject([{ id: 'studio:q-1', unreachable: true }]);
    pane.notify.dispose();
  });

  it('sends an answer given while the machine is still connecting once it answers', async () => {
    const pane = await startPane();
    const saved = savedMachines({ studio: stateOf('mac-studio', question('q-1', 'Ship it?', 1_000)) }, 'connecting');
    const run = saved.machines.run;
    saved.machines.run = (machineId, command) => saved.status('studio') === 'online'
      ? run(machineId, command)
      : Promise.reject(new PaneError('ERR_MACHINE_OFFLINE', 'mac-studio is not connected, so the action was not sent.'));
    followSavedMachines(saved.machines);
    await flush();

    const answering = pane.notify.run({ type: 'answer', id: 'studio:q-1', answer: { approved: true } });
    await flush();
    expect(saved.sent).toEqual([]);
    saved.setStatus('studio', 'online');
    await answering;
    expect(saved.sent).toEqual([['studio', { type: 'notify', command: { type: 'answer', id: 'q-1', answer: { approved: true } } }]]);
    pane.notify.dispose();
  });
});

describe('Approvals items, through the registered handlers', () => {
  beforeEach(() => vi.stubEnv('PANE_DISABLE_OS_INTEGRATION', '1'));
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  const panes = new Map([
    ['session-pane', { id: 'session-pane', name: 'Launch' }],
    ['worker', { id: 'worker', name: 'api-fix' }],
    ['loose', { id: 'loose', name: 'docs' }],
  ]);
  const launch = { id: 'session-1', name: 'Launch', paneId: 'session-pane' };
  const later = { id: 'session-2', name: 'Later', paneId: 'later-pane' };
  let openSessions = [launch, later];
  const sessionListeners = new Set<() => void>();
  const sessions = {
    approvalSession: (paneId: string) => paneId === 'session-pane' ? { ...launch, orchestrator: true } : paneId === 'worker' ? launch : undefined,
    approvalSessionsById: () => new Map(openSessions.map(session => [session.id, session])),
    approvalSessionRecord: (sessionId: string) => {
      const session = openSessions.find(candidate => candidate.id === sessionId);
      return session ? { name: session.name, paneId: session.paneId, archived: false } : undefined;
    },
    on: (_event: 'changed', listener: () => void) => { sessionListeners.add(listener); },
    off: (_event: 'changed', listener: () => void) => { sessionListeners.delete(listener); },
  };
  /** Archives a Session the way the manager reports it: the list changes, then 'changed'. */
  const archive = (sessionId: string) => {
    openSessions = openSessions.filter(session => session.id !== sessionId);
    for (const listener of sessionListeners) listener();
  };
  afterEach(() => { openSessions = [launch, later]; });

  /** A Pane with Sessions and, optionally, a Session inbox. */
  async function startWithSessions(inbox?: ReturnType<typeof inboxOf>) {
    const registry = new PaneCommandRegistry();
    const configManager = new ConfigManager();
    await configManager.initialize();
    await configManager.updateConfig({ notify: { showOutsidePane: false, enabled: true } });
    const services = {
      configManager,
      sessionManager: { getSession: (id: string) => panes.get(id) },
      getMainWindow: () => null,
      orchestrationSessionManager: sessions,
      sessionInbox: inbox,
    };
    return { configManager, registry, notify: registerNotifyHandlers(ipcMain, services, registry) };
  }

  /** A Session inbox stand-in: its items, and a way to change them as an ack or a new report would. */
  function inboxOf(items: RunpaneInboxItem[]) {
    const listeners = new Set<() => void>();
    const endedListeners = new Set<(ended: SessionInboxEnded) => void>();
    let current = items;
    return {
      all: () => current,
      subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
      subscribeEnded: (listener: (ended: SessionInboxEnded) => void) => { endedListeners.add(listener); return () => { endedListeners.delete(listener); }; },
      set: (next: RunpaneInboxItem[]) => { current = next; for (const listener of listeners) listener(); },
      end: (ended: SessionInboxEnded) => { current = current.filter(item => item.id !== ended.id); for (const listener of endedListeners) listener(ended); },
    };
  }
  const blocked = (at: number): RunpaneInboxItem => ({
    id: 'in-1', sessionId: 'session-1', kind: 'report', at: new Date(at).toISOString(), paneId: 'worker', paneName: 'api-fix', panelId: 'worker-panel',
    report: { state: 'blocked', question: 'Use the invoice id or number in the PDF filename?', // What `runpane report --summary-file` sends: the whole status file, with its path.
    summary: JSON.stringify({ state: 'blocked', step: 'Invoice PDFs', needs_you: { questions: [{ q: 'Id or number?', why: 'Ids are stable; numbers can be reissued.' }] } }), summaryPath: '/work/api-fix/status.json', reportedAt: new Date(at).toISOString() },
  });

  it("files the orchestrator's question under its Session, and a standalone Pane's under none", async () => {
    const pane = await startWithSessions();
    void pane.registry.invoke('runpane:notify', [{ ui: 'approve', title: 'Post Q-3?', caller: { paneId: 'session-pane', panelId: 'orchestrator-panel' } }]);
    void pane.registry.invoke('runpane:notify', [{ ui: 'approve', title: 'Rename the guide?', caller: { paneId: 'loose' } }]);
    await flush();

    const sources = (await pane.registry.invoke<NotifySharedState>('notify:remote-snapshot', [])).items.map(item => [item.title, item.source.session]);
    expect(sources).toEqual([
      ['Post Q-3?', { ...launch, orchestrator: true }],
      ['Rename the guide?', undefined],
    ]);
    pane.notify.dispose();
  });

  it("sends a Session worker's notify back to its orchestrator instead of showing it", async () => {
    const pane = await startWithSessions();
    const result = await pane.registry.invoke<NotifyResult>('runpane:notify', [{ ui: 'approve', title: 'Run the migration?', caller: { paneId: 'worker', panelId: 'worker-panel' } }]);

    expect(result).toEqual({
      unavailable: 'Not shown to the person: in a Pane Session, only the orchestrator asks the person.',
      next: 'Ask the Launch orchestrator instead: run runpane report --state blocked --question "<your question>", then wait for its answer or carry on with anything that doesn\'t depend on it.',
    });
    expect(pane.notify.snapshot().items).toEqual([]);
    pane.notify.dispose();
  });

  it("keeps another machine's Session and links on its cards", async () => {
    const pane = await startWithSessions();
    const remote = { ...question('q-1', 'Ship it?', 1_000), source: { name: 'api', agent: 'Claude', session: launch }, links: [{ label: 'Plan', path: '/repo/plan.md' }] };
    followSavedMachines(savedMachines({ studio: stateOf('mac-studio', remote) }).machines);
    await flush();
    expect(pane.notify.snapshot().items).toMatchObject([{ id: 'studio:q-1', source: { session: launch }, links: [{ label: 'Plan', path: '/repo/plan.md' }] }]);
    pane.notify.dispose();
  });

  it('keeps related links, resolving a file against the asking folder, and refuses a bad one', async () => {
    const pane = await startWithSessions();
    void pane.registry.invoke('runpane:notify', [{
      ui: 'approve', title: 'Ship the notes?', caller: { cwd: '/repo/api' },
      links: [{ label: 'Notes', path: 'docs/RELEASE.md' }, { label: 'Plan', path: '/tmp/plan.html' }, { label: 'PR #812', url: 'https://github.com/org/repo/pull/812' }],
    }]);
    await flush();
    // Resolved the way the host's platform resolves paths (a drive letter on Windows).
    expect(pane.notify.snapshot().items[0].links).toEqual([
      { label: 'Notes', path: path.resolve('/repo/api', 'docs/RELEASE.md') },
      { label: 'Plan', path: '/tmp/plan.html' },
      { label: 'PR #812', url: 'https://github.com/org/repo/pull/812' },
    ]);

    const call = (links: PaneCommandValue) => pane.registry.invoke('runpane:notify', [{ ui: 'approve', title: 'Ship?', caller: { cwd: '/repo' }, links }]);
    await expect(call([{ label: 'Site', url: 'file:///etc/passwd' }])).rejects.toMatchObject({ code: 'ERR_NOTIFY_INVALID' });
    await expect(call([{ label: 'Both', url: 'https://a.example', path: '/a' }])).rejects.toMatchObject({ code: 'ERR_NOTIFY_INVALID' });
    await expect(call(Array.from({ length: 7 }, (_, index) => ({ label: `L${index}`, url: 'https://a.example' })))).rejects.toMatchObject({ code: 'ERR_NOTIFY_INVALID' });
    await expect(call([{ label: 'x'.repeat(81), url: 'https://a.example' }])).rejects.toMatchObject({ code: 'ERR_NOTIFY_INVALID' });
    pane.notify.dispose();
  });

  it("shows a worker's blocked question at once, answerable and quiet, until its orchestrator acknowledges it", async () => {
    vi.stubEnv('PANE_APPROVALS_RELAY_AFTER_MS', '60');
    const inbox = inboxOf([blocked(Date.now())]);
    const pane = await startWithSessions(inbox);
    const [card] = pane.notify.snapshot().items;
    expect(card).toMatchObject({
      id: 'in-1',
      ui: 'ask',
      state: 'waiting',
      quiet: true,
      originKind: 'worker',
      title: 'Use the invoice id or number in the PDF filename?',
      // One human line from the status file, which opens beside the card as its link.
      context: 'Ids are stable; numbers can be reissued.',
      source: { paneId: 'worker', panelId: 'worker-panel', name: 'api-fix', session: { id: launch.id, name: launch.name, paneId: launch.paneId } },
      connected: { kind: 'session', id: launch.id },
      // The worker's status file, which its report named, opens beside the card.
      links: [{ label: 'api-fix status', path: '/work/api-fix/status.json' }],
    });
    // Quiet: answerable in Approvals, but not yet in the round or the strip.
    expect(pane.notify.snapshot().queue).toEqual([]);
    expect(pane.notify.snapshot().strip).toBeNull();
    await new Promise(resolve => setTimeout(resolve, 120));
    expect(pane.notify.snapshot().items[0].quiet).toBeUndefined();
    expect(pane.notify.snapshot().queue).toEqual(['in-1']);
    expect((await pane.registry.invoke<NotifySharedState>('notify:remote-snapshot', [])).items).toMatchObject([{ id: 'in-1', originKind: 'worker' }]);

    inbox.end({ id: 'in-1', how: 'acked', decision: 'D-9' });
    await flush();
    expect(pane.notify.snapshot().items).toMatchObject([{ id: 'in-1', state: 'expired', decision: 'D-9', closed: { reason: 'its orchestrator dealt with it' } }]);
    pane.notify.dispose();
  });

  it('files a card under the Session the worker reported to, even after the worker moved, and closes it when that Session closes', async () => {
    const moved = { ...blocked(Date.now() - 11 * 60_000), sessionId: 'session-2' };
    const pane = await startWithSessions(inboxOf([moved]));
    expect(pane.notify.snapshot().items.map(item => [item.id, item.connected])).toEqual([['in-1', expect.objectContaining({ kind: 'session', id: 'session-2' })]]);
    archive('session-2');
    pane.notify.queue.sweep();
    expect(pane.notify.snapshot().items).toMatchObject([{ state: 'expired', closed: { by: 'pane', reason: expect.stringMatching(/^Session (archived|closed)$/) } }]);
    pane.notify.dispose();
  });

  it('never shows a worker card while Approvals is off', async () => {
    const inbox = inboxOf([blocked(Date.now() - 11 * 60_000)]);
    const pane = await startWithSessions(inbox);
    expect(pane.notify.snapshot().items).toHaveLength(1);
    await pane.configManager.updateConfig({ notify: { enabled: false } });
    await flush();
    expect(pane.notify.snapshot().items).toEqual([]);
    pane.notify.dispose();
  });
});

describe('Approvals related links, through the registered handlers', () => {
  beforeEach(() => vi.stubEnv('PANE_DISABLE_OS_INTEGRATION', '1'));
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it('opens a file link as a tab of the Pane shown beside it, as a file page when it is outside that worktree, and a URL as a browser tab', async () => {
    const registry = new PaneCommandRegistry();
    const configManager = new ConfigManager();
    await configManager.initialize();
    await configManager.updateConfig({ notify: { showOutsidePane: false, enabled: true } });
    const opened: PaneCommandValue[] = [];
    let pageRefused = false;
    registry.register('runpane:panels:open', async (request: PaneCommandValue) => {
      opened.push(request);
      const { paneId, filePath } = decodeBoundary(request, boundary.object({ paneId: boundary.string, filePath: boundary.optional(boundary.string) }));
      if (paneId === 'session-pane' && filePath) throw new Error('File path must be inside the Pane worktree: /work/api/plan.md');
      if (paneId === 'session-pane' && pageRefused) throw new Error('Pane could not open that page.');
      return { ok: true };
    });
    const worker = { id: 'worker', name: 'api-fix' };
    const notify = registerNotifyHandlers(ipcMain, { configManager, sessionManager: { getSession: (id: string) => id === 'worker' ? worker : undefined }, getMainWindow: () => null }, registry);
    void registry.invoke('runpane:notify', [{
      ui: 'approve', title: 'Ship?', caller: { paneId: 'worker', cwd: '/work/api' },
      links: [{ label: 'Plan', path: 'plan.md' }, { label: 'PR', url: 'https://github.com/org/repo/pull/1' }],
    }]);
    await flush();
    const id = notify.snapshot().items[0].id;
    const planPath = path.resolve('/work/api', 'plan.md');

    await notify.run({ type: 'open-link', id, index: 0, paneId: 'session-pane' });
    await notify.run({ type: 'open-link', id, index: 1, paneId: 'session-pane' });
    expect(opened).toEqual([
      { paneId: 'session-pane', filePath: planPath, placement: 'tab', source: 'user' },
      { paneId: 'session-pane', url: pathToFileURL(planPath).href, title: 'Plan', placement: 'tab', source: 'user' },
      { paneId: 'session-pane', url: 'https://github.com/org/repo/pull/1', placement: 'tab', source: 'user' },
    ]);

    // When the shown Pane can't take it at all, the asking Pane opens it.
    opened.length = 0;
    pageRefused = true;
    await notify.run({ type: 'open-link', id, index: 0, paneId: 'session-pane' });
    expect(opened.map(request => decodeBoundary(request, boundary.object({ paneId: boundary.string })).paneId)).toEqual(['session-pane', 'session-pane', 'worker']);
    await expect(notify.run({ type: 'open-link', id, index: 5, paneId: 'session-pane' })).rejects.toMatchObject({ code: 'ERR_APPROVALS_LINK_GONE' });

    // A phone opens a link the same way, through the remote command, so it gets the same fallback.
    opened.length = 0;
    pageRefused = false;
    await registry.invoke('notify:remote-command', [{ type: 'open-link', id, index: 0, paneId: 'session-pane' }, { device: 'iPhone' }]);
    expect(opened).toEqual([
      { paneId: 'session-pane', filePath: planPath, placement: 'tab', source: 'user' },
      { paneId: 'session-pane', url: pathToFileURL(planPath).href, title: 'Plan', placement: 'tab', source: 'user' },
    ]);
    notify.dispose();
  });
});

describe('tabTakesText', () => {
  it('types only at a live agent prompt, with an agent in the foreground', () => {
    expect(tabTakesText('idle', true)).toBe(true);
    expect(tabTakesText('working', true)).toBe(false);
    expect(tabTakesText(undefined, true)).toBe(false);
    // A shell, a nested shell, ssh or a REPL in the foreground: an agent frame on screen proves nothing.
    expect(tabTakesText('idle', false)).toBe(false);
  });
});
