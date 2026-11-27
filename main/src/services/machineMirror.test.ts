import { mkdtempSync, promises, readFileSync, readdirSync, rmSync, statSync, writeFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MachineMirror, type MirrorMachines } from './machineMirror';
import { SessionSnapshotService } from './sessionSnapshots';
import { PaneError } from '../../../shared/paneError';
import type { MachineConnectionsEvent, MachineState } from '../../../shared/types/machineConnections';
import type { OrchestrationSessionSummary } from '../../../shared/types/orchestrationSession';
import type { AgentChatMessage } from '../../../shared/types/agentChat';
import type { ToolPanel } from '../../../shared/types/panels';
import type { MachineMirrorFile } from '../../../shared/types/machineMirror';
import type { SessionSnapshotsRequest, SessionSnapshotsResult } from '../../../shared/types/sessionSnapshot';
import type { PaneCommandValue } from '../daemon/commandRegistry';

const DAY = 24 * 60 * 60 * 1000;

function message(index: number): AgentChatMessage {
  return { id: `m${index}`, role: index % 2 ? 'assistant' : 'user', parts: [{ type: 'text', text: `message ${index}` }] };
}

/**
 * One host: its chat Sessions behind PR 4's real snapshot service, answering over the same
 * `{ success, data }` shape the channel does. `refuse` answers as a host that doesn't take this computer as its owner.
 */
function fakeHost(name: string) {
  const sessions = new Map<string, { record: OrchestrationSessionSummary; messages: AgentChatMessage[] }>();
  const tab = (id: string): ToolPanel => ({ id: `chat-${id}`, sessionId: `pane-${id}`, type: 'chat', title: 'Claude', state: { isActive: true }, metadata: { createdAt: '', lastActiveAt: '', position: 0 } });
  const byPanel = (panelId: string) => sessions.get(panelId.replace(/^chat-/, ''));
  const notices: Array<{ sessionId: string; revision: number }> = [];
  const service = new SessionSnapshotService({
    sessions: async () => [...sessions.values()].map(session => structuredClone(session.record)),
    tabs: paneId => (sessions.has(paneId.replace(/^pane-/, '')) ? [tab(paneId.replace(/^pane-/, ''))] : []),
    panel: panelId => (byPanel(panelId) ? tab(panelId.replace(/^chat-/, '')) : undefined),
    layout: () => null,
    chat: (panelId, limit) => {
      const session = byPanel(panelId);
      if (!session) return undefined;
      const window = session.messages.slice(-limit);
      return {
        panelId, agent: 'claude', generation: 1, status: 'idle', canAttachImages: false, controls: [], commands: [], permissions: [], questions: [], queue: [],
        transcript: { panelId, generation: 1, revision: session.messages.length, start: session.messages.length - window.length, messages: structuredClone(window) },
        messageCount: session.messages.length,
      };
    },
    announce: (sessionId, revision) => { notices.push({ sessionId, revision }); },
  });
  let refuse: string | undefined;
  return {
    name,
    sessions,
    notices,
    refuse: (code: string) => { refuse = code; },
    add(id: string, messages = 3, updatedAt = '2026-11-26T00:00:00.000Z') {
      sessions.set(id, {
        record: {
          id, name: `Session ${id}`, agent: 'claude', internalSessionId: `pane-${id}`, panelIds: { claude: `chat-${id}`, codex: `codex-${id}` },
          goal: '', context: '', decisions: [], blockers: [], nextAction: '', evidence: [], outputs: [], associations: [],
          revision: 1, createdAt: updatedAt, updatedAt,
        },
        messages: Array.from({ length: messages }, (_, index) => message(index)),
      });
      service.send('orchestration-sessions:changed', { sessionId: id, kind: 'created' });
    },
    say(id: string, count = 1) {
      const session = sessions.get(id)!;
      for (let added = 0; added < count; added += 1) {
        const index = session.messages.length;
        session.messages.push(message(index));
        // The transcript's revision is its message count here: one change per message.
        service.send('chat-tab:event', { panelId: `chat-${id}`, generation: 1, revision: session.messages.length, index });
      }
    },
    remove(id: string) {
      sessions.delete(id);
      service.send('orchestration-sessions:changed', { sessionId: id, kind: 'deleted' });
    },
    async answer(args: PaneCommandValue[]): Promise<PaneCommandValue> {
      if (refuse) return { success: false, error: 'Only this computer\'s owner can read its Session snapshots.', code: refuse };
      // SAFETY: the mirror sends one SessionSnapshotsRequest, which is plain JSON.
      const request = (args[0] ?? {}) as SessionSnapshotsRequest;
      return { success: true, data: structuredClone(await service.snapshots(request)) };
    },
  };
}

type Host = ReturnType<typeof fakeHost>;

/** The desktop's saved machines: their states, their events and reads, each read recorded with its request. */
function fakeMachines(hosts: Host[]) {
  const listeners = new Set<(event: MachineConnectionsEvent) => void>();
  const states = new Map<string, MachineState>(hosts.map(host => [host.name, { id: host.name, label: host.name, kind: 'remote', status: 'connecting', offlineSince: null }]));
  const reads: Array<{ machineId: string; request: PaneCommandValue }> = [];
  const failures = new Map<string, Error>();
  const machines: MirrorMachines = {
    list: () => [{ id: 'local', label: 'This computer', kind: 'local', status: 'online', offlineSince: null }, ...[...states.values()].map(state => ({ ...state }))],
    subscribe: listener => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    read: async (machineId, channel, args) => {
      expect(channel).toBe('orchestration-sessions:snapshots');
      reads.push({ machineId, request: structuredClone(args[0]) });
      const failure = failures.get(machineId);
      if (failure) throw failure;
      const host = hosts.find(candidate => candidate.name === machineId)!;
      return { machineId, data: await host.answer(args) };
    },
  };
  const emit = (event: MachineConnectionsEvent) => { for (const listener of [...listeners]) listener(event); };
  return {
    machines,
    reads,
    failures,
    set(id: string, change: Partial<MachineState>) {
      states.set(id, { ...states.get(id)!, ...change });
      emit({ type: 'machines', machines: machines.list() });
    },
    forget(id: string) {
      states.delete(id);
      emit({ type: 'machines', machines: machines.list() });
    },
    online(id: string) { this.set(id, { status: 'online', onlineSince: new Date().toISOString(), offlineSince: null }); },
    offline(id: string) { this.set(id, { status: 'offline', offlineSince: new Date().toISOString() }); },
    resync(id: string) { emit({ type: 'resync', machineId: id }); },
    /** Delivers the host's notices since the last call, as its event stream would. */
    deliver(host: Host) {
      for (const notice of host.notices.splice(0)) emit({ type: 'event', machineId: host.name, channel: 'session-snapshot:changed', args: [notice] });
    },
  };
}

/** Lets the host's notice pace (one a second per Session) pass, and drops the notices it sent meanwhile. */
async function settle(host: Host): Promise<void> {
  await vi.advanceTimersByTimeAsync(1000);
  host.notices.splice(0);
}

function readFile(directory: string, machineId: string): MachineMirrorFile {
  // SAFETY: the mirror writes MachineMirrorFile JSON.
  return JSON.parse(readFileSync(path.join(directory, `${machineId}.json`), 'utf8')) as MachineMirrorFile;
}

describe('MachineMirror', () => {
  let directory: string;
  const mirrors: MachineMirror[] = [];
  const mirrorOf = (machines: MirrorMachines, options: { capBytes?: number } = {}) => {
    const mirror = new MachineMirror({ directory, machines, ...options });
    mirrors.push(mirror);
    return mirror;
  };

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
    vi.setSystemTime(new Date('2026-11-26T12:00:00.000Z'));
    directory = path.join(mkdtempSync(path.join(tmpdir(), 'machine-mirror-')), 'machine-mirror');
  });
  afterEach(async () => {
    for (const mirror of mirrors.splice(0)) await mirror.stop();
    vi.useRealTimers();
    rmSync(path.dirname(directory), { recursive: true, force: true });
  });

  it('fills a machine\'s mirror with one read when it connects, and saves it readable only by this user', async () => {
    const mac = fakeHost('mac');
    mac.add('a', 40);
    mac.add('b', 2);
    const link = fakeMachines([mac]);
    const mirror = mirrorOf(link.machines);
    await mirror.start();
    expect(mirror.state('mac')?.sync).toBe('offline');

    link.online('mac');
    await vi.advanceTimersByTimeAsync(0);

    expect(link.reads).toEqual([{ machineId: 'mac', request: {} }]);
    expect(mirror.sessions('mac').map(snapshot => snapshot.sessionId).sort()).toEqual(['a', 'b']);
    expect(mirror.session('mac', 'a')?.chat.transcript?.messages).toHaveLength(30);
    expect(mirror.state('mac')).toEqual({ machineId: 'mac', sync: 'live', lastSeenAt: '2026-11-26T12:00:00.000Z', sessionCount: 2 });

    await mirror.flush();
    const file = path.join(directory, 'mac.json');
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(statSync(directory).mode & 0o777).toBe(0o700);
    expect(readFile(directory, 'mac').sessions).toHaveLength(2);
  });

  it('batches a machine\'s notices for 250 ms into one read of what changed, sending only new messages', async () => {
    const mac = fakeHost('mac');
    mac.add('a', 10);
    mac.add('b', 10);
    mac.add('c', 10);
    const link = fakeMachines([mac]);
    const mirror = mirrorOf(link.machines);
    await mirror.start();
    link.online('mac');
    await vi.advanceTimersByTimeAsync(0);
    await settle(mac);
    const first = link.reads.length;

    mac.say('a', 3);
    link.deliver(mac);
    await vi.advanceTimersByTimeAsync(100);
    mac.say('b');
    link.deliver(mac);
    await vi.advanceTimersByTimeAsync(149);
    expect(link.reads).toHaveLength(first);
    await vi.advanceTimersByTimeAsync(1);

    expect(link.reads).toHaveLength(first + 1);
    // SAFETY: the mirror sends a SessionSnapshotsRequest.
    const request = link.reads[first]!.request as SessionSnapshotsRequest;
    expect(request.since).toBeGreaterThan(0);
    expect(request.held).toEqual({ a: { generation: 1, count: 10, revision: 10 }, b: { generation: 1, count: 10, revision: 10 }, c: { generation: 1, count: 10, revision: 10 } });
    expect(mirror.session('mac', 'a')?.chat.transcript?.messages.map(entry => entry.id)).toEqual(Array.from({ length: 13 }, (_, index) => `m${index}`));
    expect(mirror.session('mac', 'b')?.chat.messageCount).toBe(11);
    expect(mirror.session('mac', 'c')?.chat.messageCount).toBe(10);
  });

  it('keeps only the newest 30 messages as a Session grows', async () => {
    const mac = fakeHost('mac');
    mac.add('a', 28);
    const link = fakeMachines([mac]);
    const mirror = mirrorOf(link.machines);
    await mirror.start();
    link.online('mac');
    await vi.advanceTimersByTimeAsync(0);
    await settle(mac);

    mac.say('a', 5);
    link.deliver(mac);
    await vi.advanceTimersByTimeAsync(250);

    const transcript = mirror.session('mac', 'a')?.chat.transcript;
    expect(transcript?.messages).toHaveLength(30);
    expect(transcript?.start).toBe(3);
    expect(transcript?.messages.at(-1)?.id).toBe('m32');
  });

  it('catches up on changes whose notices it missed when the machine resyncs or reconnects', async () => {
    const mac = fakeHost('mac');
    mac.add('a');
    const link = fakeMachines([mac]);
    const mirror = mirrorOf(link.machines);
    await mirror.start();
    link.online('mac');
    await vi.advanceTimersByTimeAsync(0);

    // Notices lost while the stream was down.
    mac.say('a', 4);
    mac.add('b');
    mac.notices.splice(0);
    link.resync('mac');
    await vi.advanceTimersByTimeAsync(0);
    expect(mirror.session('mac', 'a')?.chat.messageCount).toBe(7);
    expect(mirror.session('mac', 'b')).toBeDefined();

    link.offline('mac');
    vi.advanceTimersByTime(5);
    mac.remove('b');
    mac.notices.splice(0);
    link.online('mac');
    await vi.advanceTimersByTimeAsync(0);
    expect(mirror.session('mac', 'b')).toBeUndefined();
  });

  it('shows the last copy while the machine is offline, and as catching up while a read is under way', async () => {
    const mac = fakeHost('mac');
    mac.add('a');
    const link = fakeMachines([mac]);
    const mirror = mirrorOf(link.machines);
    const changes: string[] = [];
    mirror.subscribe(change => changes.push(`${change.machineId}:${mirror.state(change.machineId)?.sync}`));
    await mirror.start();
    link.online('mac');
    expect(mirror.state('mac')?.sync).toBe('catching-up');
    await vi.advanceTimersByTimeAsync(0);
    vi.advanceTimersByTime(60_000);

    link.offline('mac');

    expect(mirror.state('mac')).toEqual({ machineId: 'mac', sync: 'offline', lastSeenAt: '2026-11-26T12:00:00.000Z', sessionCount: 1 });
    expect(mirror.session('mac', 'a')).toBeDefined();
    expect(changes).toEqual(expect.arrayContaining(['mac:catching-up', 'mac:live', 'mac:offline']));
  });

  it('reads its saved copy after a restart, then asks only for what changed since', async () => {
    const mac = fakeHost('mac');
    mac.add('a', 5);
    const link = fakeMachines([mac]);
    const before = mirrorOf(link.machines);
    await before.start();
    link.online('mac');
    await vi.advanceTimersByTimeAsync(0);
    await before.stop();
    const saved = readFile(directory, 'mac');

    link.offline('mac');
    const after = mirrorOf(link.machines);
    await after.start();
    expect(after.session('mac', 'a')?.chat.messageCount).toBe(5);
    expect(after.state('mac')?.sync).toBe('offline');

    link.online('mac');
    await vi.advanceTimersByTimeAsync(0);
    expect(link.reads.at(-1)?.request).toEqual({ since: saved.revision, epoch: saved.epoch, held: { a: { generation: 1, count: 5, revision: 5 } } });
  });

  it('follows a Session moved to another machine: the old machine\'s copy goes when it stops listing it', async () => {
    const a = fakeHost('mac-a');
    const b = fakeHost('mac-b');
    a.add('moving', 3);
    const link = fakeMachines([a, b]);
    const mirror = mirrorOf(link.machines);
    await mirror.start();
    link.online('mac-a');
    link.online('mac-b');
    await vi.advanceTimersByTimeAsync(0);
    expect(mirror.session('mac-a', 'moving')).toBeDefined();
    await settle(a);
    await settle(b);

    b.add('moving', 3);
    a.remove('moving');
    // Each host announces once it has read its own Session list again.
    await vi.advanceTimersByTimeAsync(0);
    link.deliver(b);
    link.deliver(a);
    await vi.advanceTimersByTimeAsync(250);

    expect(mirror.session('mac-a', 'moving')).toBeUndefined();
    expect(mirror.session('mac-b', 'moving')?.chat.messageCount).toBe(3);
  });

  it('never copies a machine it only watches, and removes a copy once a machine stops being yours', async () => {
    const mac = fakeHost('mac');
    const shared = fakeHost('shared');
    mac.add('a');
    shared.add('t');
    const link = fakeMachines([mac, shared]);
    link.set('shared', { access: 'read' });
    const mirror = mirrorOf(link.machines);
    await mirror.start();
    link.online('shared');
    link.online('mac');
    await vi.advanceTimersByTimeAsync(0);
    await mirror.flush();
    expect(link.reads.map(read => read.machineId)).toEqual(['mac']);
    expect(mirror.state('shared')).toBeUndefined();

    link.set('mac', { access: 'read' });
    await mirror.flush();

    expect(mirror.sessions('mac')).toEqual([]);
    expect(readdirSync(directory)).toEqual([]);
  });

  it('removes the copy and stops reading when the host says this computer is not its owner', async () => {
    const mac = fakeHost('mac');
    mac.add('a');
    const link = fakeMachines([mac]);
    const mirror = mirrorOf(link.machines);
    await mirror.start();
    link.online('mac');
    await vi.advanceTimersByTimeAsync(0);
    await mirror.flush();

    await settle(mac);
    mac.refuse('SESSION_SNAPSHOTS_OWNER_ONLY');
    link.resync('mac');
    await vi.advanceTimersByTimeAsync(0);
    mac.say('a');
    link.deliver(mac);
    await vi.advanceTimersByTimeAsync(500);
    await mirror.flush();

    expect(mirror.sessions('mac')).toEqual([]);
    expect(mirror.state('mac')).toBeUndefined();
    expect(readdirSync(directory)).toEqual([]);
    expect(link.reads).toHaveLength(2);
  });

  it('leaves a machine whose Pane has no snapshots alone until it reconnects', async () => {
    const mac = fakeHost('mac');
    const link = fakeMachines([mac]);
    link.failures.set('mac', new PaneError('ERR_HOST_OUTDATED', 'mac runs an older Pane.', 'Update Pane on mac.'));
    const mirror = mirrorOf(link.machines);
    await mirror.start();
    link.online('mac');
    await vi.advanceTimersByTimeAsync(0);
    link.resync('mac');
    await vi.advanceTimersByTimeAsync(0);

    expect(link.reads).toHaveLength(1);
    expect(mirror.state('mac')).toBeUndefined();

    link.failures.delete('mac');
    link.offline('mac');
    vi.advanceTimersByTime(5000);
    link.online('mac');
    await vi.advanceTimersByTimeAsync(0);
    expect(link.reads).toHaveLength(2);
    expect(mirror.state('mac')?.sync).toBe('live');
  });

  it('keeps its copy and tries again on the next notice when a read fails', async () => {
    const mac = fakeHost('mac');
    mac.add('a');
    const link = fakeMachines([mac]);
    const mirror = mirrorOf(link.machines);
    await mirror.start();
    link.online('mac');
    await vi.advanceTimersByTimeAsync(0);
    await settle(mac);
    link.failures.set('mac', new Error('socket hang up'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    mac.say('a');
    link.deliver(mac);
    await vi.advanceTimersByTimeAsync(250);
    expect(mirror.session('mac', 'a')?.chat.messageCount).toBe(3);
    expect(mirror.state('mac')?.sync).toBe('catching-up');

    link.failures.delete('mac');
    await settle(mac);
    mac.say('a');
    link.deliver(mac);
    await vi.advanceTimersByTimeAsync(250);
    expect(mirror.session('mac', 'a')?.chat.messageCount).toBe(5);
    expect(mirror.state('mac')?.sync).toBe('live');
    warn.mockRestore();
  });

  it('saves only the projection the host sends: no launch settings or tab screens on disk', async () => {
    const mac = fakeHost('mac');
    mac.add('a');
    Object.assign(mac.sessions.get('a')!.record, { launchCommand: 'claude --api-key sk-live-123', openingPrompt: 'use sk-live-123' });
    const link = fakeMachines([mac]);
    const mirror = mirrorOf(link.machines);
    await mirror.start();
    link.online('mac');
    await vi.advanceTimersByTimeAsync(0);
    await mirror.flush();

    const saved = readFileSync(path.join(directory, 'mac.json'), 'utf8');
    expect(saved).not.toContain('sk-live-123');
    expect(saved).not.toContain('launchCommand');
    expect(mirror.session('mac', 'a')?.session).not.toHaveProperty('openingPrompt');
  });

  it('removes the copy of a machine that is forgotten', async () => {
    const mac = fakeHost('mac');
    mac.add('a');
    const link = fakeMachines([mac]);
    const mirror = mirrorOf(link.machines);
    await mirror.start();
    link.online('mac');
    await vi.advanceTimersByTimeAsync(0);
    await mirror.flush();
    expect(readdirSync(directory)).toEqual(['mac.json']);

    link.forget('mac');
    await vi.advanceTimersByTimeAsync(0);
    await mirror.flush();

    expect(mirror.state('mac')).toBeUndefined();
    expect(readdirSync(directory)).toEqual([]);
  });

  it('removes at start the copies of machines no longer saved, not yours, or not seen for 30 days', async () => {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const file = (machineId: string, lastSeenAt: string): MachineMirrorFile => ({ version: 1, machineId, epoch: 'run', revision: 1, lastSeenAt, sessions: [] });
    writeFileSync(path.join(directory, 'kept.json'), JSON.stringify(file('kept', new Date(Date.now() - 29 * DAY).toISOString())));
    writeFileSync(path.join(directory, 'stale.json'), JSON.stringify(file('stale', new Date(Date.now() - 31 * DAY).toISOString())));
    writeFileSync(path.join(directory, 'gone.json'), JSON.stringify(file('gone', new Date().toISOString())));
    writeFileSync(path.join(directory, 'watched.json'), JSON.stringify(file('watched', new Date().toISOString())));
    writeFileSync(path.join(directory, 'broken.json'), '{not json');
    const link = fakeMachines([fakeHost('kept'), fakeHost('stale'), fakeHost('watched')]);
    link.set('watched', { access: 'read' });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const mirror = mirrorOf(link.machines);
    await mirror.start();
    warn.mockRestore();

    expect(readdirSync(directory)).toEqual(['kept.json']);
    expect(mirror.state('kept')?.sync).toBe('offline');
  });

  it('keeps each machine under its size cap by leaving out the Sessions changed longest ago', async () => {
    const mac = fakeHost('mac');
    mac.add('old', 30, '2026-11-01T00:00:00.000Z');
    mac.add('mid', 30, '2026-11-10T00:00:00.000Z');
    mac.add('new', 30, '2026-11-20T00:00:00.000Z');
    const link = fakeMachines([mac]);
    // SAFETY: the fake host answers as the channel does, `{ success, data: SessionSnapshotsResult }`.
    const one = JSON.stringify((await mac.answer([{}]) as { data: SessionSnapshotsResult }).data.snapshots[0]).length;
    const mirror = mirrorOf(link.machines, { capBytes: one * 2 + 500 });
    await mirror.start();
    link.online('mac');
    await vi.advanceTimersByTimeAsync(0);

    expect(mirror.sessions('mac').map(snapshot => snapshot.sessionId).sort()).toEqual(['mid', 'new']);
    await mirror.flush();
    expect(statSync(path.join(directory, 'mac.json')).size).toBeLessThanOrEqual(one * 2 + 500);
  });

  it('saves at most once every 2 seconds per machine while changes stream in', async () => {
    const mac = fakeHost('mac');
    mac.add('a');
    const link = fakeMachines([mac]);
    const mirror = mirrorOf(link.machines);
    await mirror.start();
    link.online('mac');
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(2000);
    // The first save, at connect, has finished.
    await mirror.flush();
    const renames = vi.spyOn(promises, 'rename');

    for (let tick = 0; tick < 20; tick += 1) {
      mac.say('a');
      link.deliver(mac);
      await vi.advanceTimersByTimeAsync(300);
    }
    // The host's last notice comes up to a second after the last change.
    await vi.advanceTimersByTimeAsync(1000);
    link.deliver(mac);
    await vi.advanceTimersByTimeAsync(250);
    await mirror.flush();

    // 7.25 s of changes: a save every 2 s at most (4), and the last one on flush. Counted once every save finished:
    // their real disk time, not the test's clock, decides when each rename runs.
    expect(renames.mock.calls.filter(([, to]) => String(to).endsWith('mac.json'))).toHaveLength(5);
    expect(readFile(directory, 'mac').sessions[0]?.chat.messageCount).toBe(23);
    renames.mockRestore();
  });
});
