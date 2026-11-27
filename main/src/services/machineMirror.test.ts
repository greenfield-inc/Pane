import { chmodSync, mkdtempSync, promises, readFileSync, readdirSync, rmSync, statSync, writeFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MachineMirror, MIRROR_MEMORY_SESSIONS, type MirrorMachines } from './machineMirror';
import { SessionSnapshotService } from './sessionSnapshots';
import { PaneError } from '../../../shared/paneError';
import type { MachineConnectionsEvent, MachineState } from '../../../shared/types/machineConnections';
import type { OrchestrationSessionSummary } from '../../../shared/types/orchestrationSession';
import type { AgentChatMessage } from '../../../shared/types/agentChat';
import type { ToolPanel } from '../../../shared/types/panels';
import type { MachineMirrorIndexFile } from '../../../shared/types/machineMirror';
import type { SessionSnapshot, SessionSnapshotsRequest, SessionSnapshotsResult } from '../../../shared/types/sessionSnapshot';
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
  const states = new Map<string, MachineState>(hosts.map(host => [host.name, { id: host.name, label: host.name, kind: 'remote', status: 'connecting', offlineSince: null, mine: true }]));
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

/** A machine's saved index, as the mirror wrote it. */
function readIndex(directory: string, machineId: string): MachineMirrorIndexFile {
  // SAFETY: the mirror writes MachineMirrorIndexFile JSON.
  return JSON.parse(readFileSync(path.join(directory, machineId, 'index.json'), 'utf8')) as MachineMirrorIndexFile;
}

/** One Session's saved file, as the mirror wrote it. */
function readSession(directory: string, machineId: string, sessionId: string): SessionSnapshot {
  // SAFETY: the mirror writes SessionSnapshot JSON.
  return JSON.parse(readFileSync(path.join(directory, machineId, `${sessionId}.json`), 'utf8')) as SessionSnapshot;
}

/** Every file the mirror saved for a machine, as one text. */
function savedText(directory: string, machineId: string): string {
  return readdirSync(path.join(directory, machineId)).map(name => readFileSync(path.join(directory, machineId, name), 'utf8')).join('\n');
}

const ids = (mirror: MachineMirror, machineId: string) => mirror.index(machineId).map(entry => entry.sessionId).sort();

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
    expect(ids(mirror, 'mac')).toEqual(['a', 'b']);
    expect((await mirror.session('mac', 'a'))?.chat.transcript?.messages).toHaveLength(30);
    expect(mirror.state('mac')).toEqual({ machineId: 'mac', sync: 'live', lastSeenAt: '2026-11-26T12:00:00.000Z', sessionCount: 2 });

    await mirror.flush();
    const folder = path.join(directory, 'mac');
    expect(readdirSync(folder).sort()).toEqual(['a.json', 'b.json', 'index.json']);
    // Windows has no POSIX modes; its files inherit the user profile's access instead.
    if (process.platform !== 'win32') {
      for (const name of readdirSync(folder)) expect(statSync(path.join(folder, name)).mode & 0o777).toBe(0o600);
      expect(statSync(folder).mode & 0o777).toBe(0o700);
      expect(statSync(directory).mode & 0o777).toBe(0o700);
    }
    expect(Object.keys(readIndex(directory, 'mac').sessions).sort()).toEqual(['a', 'b']);
    expect(readSession(directory, 'mac', 'a').chat.transcript?.messages).toHaveLength(30);
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
    expect((await mirror.session('mac', 'a'))?.chat.transcript?.messages.map(entry => entry.id)).toEqual(Array.from({ length: 13 }, (_, index) => `m${index}`));
    expect((await mirror.session('mac', 'b'))?.chat.messageCount).toBe(11);
    expect((await mirror.session('mac', 'c'))?.chat.messageCount).toBe(10);
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

    const transcript = (await mirror.session('mac', 'a'))?.chat.transcript;
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
    expect((await mirror.session('mac', 'a'))?.chat.messageCount).toBe(7);
    expect((await mirror.session('mac', 'b'))).toBeDefined();

    link.offline('mac');
    vi.advanceTimersByTime(5);
    mac.remove('b');
    mac.notices.splice(0);
    link.online('mac');
    await vi.advanceTimersByTimeAsync(0);
    expect((await mirror.session('mac', 'b'))).toBeUndefined();
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
    expect((await mirror.session('mac', 'a'))).toBeDefined();
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
    const saved = readIndex(directory, 'mac');

    link.offline('mac');
    const after = mirrorOf(link.machines);
    await after.start();
    expect((await after.session('mac', 'a'))?.chat.messageCount).toBe(5);
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
    expect((await mirror.session('mac-a', 'moving'))).toBeDefined();
    await settle(a);
    await settle(b);

    b.add('moving', 3);
    a.remove('moving');
    // Each host announces once it has read its own Session list again.
    await vi.advanceTimersByTimeAsync(0);
    link.deliver(b);
    link.deliver(a);
    await vi.advanceTimersByTimeAsync(250);

    expect((await mirror.session('mac-a', 'moving'))).toBeUndefined();
    expect((await mirror.session('mac-b', 'moving'))?.chat.messageCount).toBe(3);
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

    expect(mirror.index('mac')).toEqual([]);
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

    expect(mirror.index('mac')).toEqual([]);
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
    expect((await mirror.session('mac', 'a'))?.chat.messageCount).toBe(3);
    expect(mirror.state('mac')?.sync).toBe('catching-up');

    link.failures.delete('mac');
    await settle(mac);
    mac.say('a');
    link.deliver(mac);
    await vi.advanceTimersByTimeAsync(250);
    expect((await mirror.session('mac', 'a'))?.chat.messageCount).toBe(5);
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

    const saved = savedText(directory, 'mac');
    expect(saved).not.toContain('sk-live-123');
    expect(saved).not.toContain('launchCommand');
    expect((await mirror.session('mac', 'a'))?.session).not.toHaveProperty('openingPrompt');
  });

  it('applies the projection itself, storing nothing outside it whatever the host sends', async () => {
    const mac = fakeHost('mac');
    mac.add('a');
    const link = fakeMachines([mac]);
    const read = link.machines.read;
    const big = 'q'.repeat(20_000);
    // A host that sends more than it should (a regression, or a field added later).
    link.machines.read = async (machineId, channel, args) => {
      const result = await read(machineId, channel, args);
      // SAFETY: the fake host answers { success, data: SessionSnapshotsResult }.
      const answer = result.data as { data: SessionSnapshotsResult };
      for (const snapshot of answer.data.snapshots) {
        Object.assign(snapshot.session, { launchCommand: 'claude --api-key sk-live-123' });
        snapshot.tabs.push({ id: 'term', sessionId: 'pane-a', type: 'terminal', title: 'T', state: { isActive: false, customState: { screenText: 'sk-live-123', cwd: '/r' } }, metadata: { createdAt: '', lastActiveAt: '', position: 1 } });
        snapshot.tabs.push({ id: 'file', sessionId: 'pane-a', type: 'explorer', title: 'f', state: { isActive: false, customState: { content: 'sk-live-123' } }, metadata: { createdAt: '', lastActiveAt: '', position: 2 } });
        snapshot.chat.transcript?.messages.push({ id: 'img', role: 'user', parts: [{ type: 'content', content: { type: 'image', data: big } }] });
      }
      return result;
    };
    const mirror = mirrorOf(link.machines);
    await mirror.start();
    link.online('mac');
    await vi.advanceTimersByTimeAsync(0);
    await mirror.flush();

    const saved = savedText(directory, 'mac');
    expect(saved).not.toContain('sk-live-123');
    expect(saved).not.toContain(big);
    expect((await mirror.session('mac', 'a'))?.tabs.map(tab => tab.id)).toEqual(['chat-a', 'term']);
  });

  it('over its cap, leaves out the Sessions whose snapshot changed longest ago, not whose record did', async () => {
    const mac = fakeHost('mac');
    // busy's record is the oldest, but its chat keeps changing.
    mac.add('busy', 30, '2026-10-01T00:00:00.000Z');
    mac.add('idle', 30, '2026-11-20T00:00:00.000Z');
    const link = fakeMachines([mac]);
    // SAFETY: the fake host answers as the channel does, `{ success, data: SessionSnapshotsResult }`.
    const one = JSON.stringify((await mac.answer([{}]) as { data: SessionSnapshotsResult }).data.snapshots[0]).length;
    const mirror = mirrorOf(link.machines, { capBytes: one * 2 + 2000 });
    await mirror.start();
    link.online('mac');
    await vi.advanceTimersByTimeAsync(0);
    await settle(mac);
    mac.add('new', 30, '2026-11-25T00:00:00.000Z');
    await vi.advanceTimersByTimeAsync(0);
    link.deliver(mac);
    await vi.advanceTimersByTimeAsync(250);
    await settle(mac);
    mac.say('busy');
    link.deliver(mac);
    await vi.advanceTimersByTimeAsync(250);

    expect(ids(mirror, 'mac')).toEqual(['busy', 'new']);
  });

  it('saves nothing for a read that finishes after it stopped', async () => {
    const mac = fakeHost('mac');
    mac.add('a');
    const link = fakeMachines([mac]);
    const read = link.machines.read;
    let release: () => void = () => undefined;
    const gate = new Promise<void>(resolve => { release = resolve; });
    link.machines.read = async (machineId, channel, args) => { await gate; return read(machineId, channel, args); };
    const mirror = new MachineMirror({ directory, machines: link.machines });
    await mirror.start();
    link.online('mac');

    await mirror.stop();
    release();
    await vi.advanceTimersByTimeAsync(5000);

    expect(() => readdirSync(directory)).toThrow();
  });

  it('makes an existing mirror folder readable only by this user', async () => {
    if (process.platform === 'win32') return;
    mkdirSync(directory, { recursive: true, mode: 0o755 });
    chmodSync(directory, 0o755);
    const mirror = mirrorOf(fakeMachines([]).machines);

    await mirror.start();

    expect(statSync(directory).mode & 0o777).toBe(0o700);
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
    expect(readdirSync(directory)).toEqual(['mac']);

    link.forget('mac');
    await vi.advanceTimersByTimeAsync(0);
    await mirror.flush();

    expect(mirror.state('mac')).toBeUndefined();
    expect(readdirSync(directory)).toEqual([]);
  });

  it('removes at start the copies of machines no longer saved, not yours, or not seen for 30 days, and files no index names', async () => {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const save = (folder: string, machineId: string, lastSeenAt: string) => {
      const index: MachineMirrorIndexFile = { version: 2, machineId, epoch: 'run', revision: 1, lastSeenAt, sessions: {} };
      mkdirSync(path.join(directory, folder));
      writeFileSync(path.join(directory, folder, 'index.json'), JSON.stringify(index));
    };
    save('kept', 'kept', new Date(Date.now() - 29 * DAY).toISOString());
    writeFileSync(path.join(directory, 'kept', 'orphan.json'), '{}');
    writeFileSync(path.join(directory, 'kept', 'index.json.1.tmp'), '{}');
    save('stale', 'stale', new Date(Date.now() - 31 * DAY).toISOString());
    save('gone', 'gone', new Date().toISOString());
    save('watched', 'watched', new Date().toISOString());
    save('elsewhere', 'kept', new Date().toISOString());
    mkdirSync(path.join(directory, 'broken'));
    writeFileSync(path.join(directory, 'broken', 'index.json'), '{not json');
    // This PR's earlier whole-machine file, never released.
    writeFileSync(path.join(directory, 'kept.json'), '{}');
    const link = fakeMachines([fakeHost('kept'), fakeHost('stale'), fakeHost('watched')]);
    link.set('watched', { access: 'read' });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const mirror = mirrorOf(link.machines);
    await mirror.start();
    warn.mockRestore();

    expect(readdirSync(directory)).toEqual(['kept']);
    expect(readdirSync(path.join(directory, 'kept'))).toEqual(['index.json']);
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

    expect(ids(mirror, 'mac')).toEqual(['mid', 'new']);
    await mirror.flush();
    const sessionFiles = readdirSync(path.join(directory, 'mac')).filter(name => name !== 'index.json');
    expect(sessionFiles.sort()).toEqual(['mid.json', 'new.json']);
    expect(sessionFiles.reduce((sum, name) => sum + statSync(path.join(directory, 'mac', name)).size, 0)).toBeLessThanOrEqual(one * 2 + 500);
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
    expect(renames.mock.calls.filter(([, to]) => String(to).endsWith(path.join('mac', 'index.json')))).toHaveLength(5);
    expect(readSession(directory, 'mac', 'a').chat.messageCount).toBe(23);
    renames.mockRestore();
  });

  it('reads a cold 100 KB Session from its file in under 10 ms', async () => {
    const mac = fakeHost('mac');
    mac.add('big', 30);
    // About 3.4 KB a message, so the newest 30 weigh about 100 KB.
    for (const entry of mac.sessions.get('big')!.messages) entry.parts = [{ type: 'text', text: 'x'.repeat(3400) }];
    const link = fakeMachines([mac]);
    const before = mirrorOf(link.machines);
    await before.start();
    link.online('mac');
    await vi.advanceTimersByTimeAsync(0);
    await before.stop();
    expect(statSync(path.join(directory, 'mac', 'big.json')).size).toBeGreaterThan(100_000);

    // Offline, so nothing but the file can answer.
    link.offline('mac');
    const after = mirrorOf(link.machines);
    await after.start();
    const reads = vi.spyOn(promises, 'readFile');
    const started = performance.now();
    const snapshot = await after.session('mac', 'big');
    const took = performance.now() - started;

    expect(snapshot?.chat.transcript?.messages).toHaveLength(30);
    expect(reads).toHaveBeenCalledTimes(1);
    expect(took).toBeLessThan(10);
    reads.mockRestore();
  });

  it(`keeps at most ${MIRROR_MEMORY_SESSIONS} Sessions in memory, and reads the rest from their files`, async () => {
    const mac = fakeHost('mac');
    for (let index = 0; index <= MIRROR_MEMORY_SESSIONS; index += 1) mac.add(`s${String(index).padStart(2, '0')}`, 2);
    const link = fakeMachines([mac]);
    const mirror = mirrorOf(link.machines);
    await mirror.start();
    link.online('mac');
    await vi.advanceTimersByTimeAsync(0);
    await mirror.flush();
    expect(mirror.index('mac')).toHaveLength(MIRROR_MEMORY_SESSIONS + 1);

    const reads = vi.spyOn(promises, 'readFile');
    const fromDisk = () => reads.mock.calls.map(([file]) => path.basename(String(file)));
    // The read stored all 31; the first was pushed out of memory by the 30 after it.
    expect((await mirror.session('mac', 's00'))?.sessionId).toBe('s00');
    expect(fromDisk()).toEqual(['s00.json']);
    // The newest are still in memory.
    expect((await mirror.session('mac', `s${MIRROR_MEMORY_SESSIONS}`))?.sessionId).toBe(`s${MIRROR_MEMORY_SESSIONS}`);
    expect((await mirror.session('mac', 's00'))?.sessionId).toBe('s00');
    expect(fromDisk()).toEqual(['s00.json']);
    // Reading s00 back pushed out the least recently used, s01.
    expect((await mirror.session('mac', 's01'))?.sessionId).toBe('s01');
    expect(fromDisk()).toEqual(['s00.json', 's01.json']);
    reads.mockRestore();
  });

  it('deletes the file of a Session the machine no longer lists, and writes the index last', async () => {
    const mac = fakeHost('mac');
    mac.add('a');
    mac.add('b');
    const link = fakeMachines([mac]);
    const mirror = mirrorOf(link.machines);
    await mirror.start();
    link.online('mac');
    await vi.advanceTimersByTimeAsync(0);
    await mirror.flush();
    await settle(mac);
    const renames = vi.spyOn(promises, 'rename');

    mac.remove('b');
    mac.say('a');
    await vi.advanceTimersByTimeAsync(0);
    link.deliver(mac);
    await vi.advanceTimersByTimeAsync(250);
    await mirror.flush();

    expect(readdirSync(path.join(directory, 'mac')).sort()).toEqual(['a.json', 'index.json']);
    expect(renames.mock.calls.map(([, to]) => path.basename(String(to)))).toEqual(['a.json', 'index.json']);
    expect(Object.keys(readIndex(directory, 'mac').sessions)).toEqual(['a']);
    renames.mockRestore();
  });

  it('never reads a Full access machine that is not marked yours (a teammate\'s), and removes its saved copy', async () => {
    const mac = fakeHost('mac');
    const teammate = fakeHost('teammate');
    mac.add('a');
    teammate.add('t');
    const link = fakeMachines([mac, teammate]);
    const first = mirrorOf(link.machines);
    await first.start();
    link.online('teammate');
    await vi.advanceTimersByTimeAsync(0);
    await first.stop();
    expect(readdirSync(directory)).toEqual(['teammate']);

    // Its mark is gone (a mismatched login, or the switch turned off): the copy goes at start, and nothing is read.
    link.set('teammate', { mine: undefined });
    link.online('mac');
    const reads = link.reads.length;
    const mirror = mirrorOf(link.machines);
    await mirror.start();
    await vi.advanceTimersByTimeAsync(0);
    await mirror.flush();

    expect(link.reads.slice(reads).map(read => read.machineId)).toEqual(['mac']);
    expect(mirror.state('teammate')).toBeUndefined();
    expect(readdirSync(directory)).toEqual(['mac']);
  });

  it('removes a running copy as soon as the machine stops being marked yours', async () => {
    const mac = fakeHost('mac');
    mac.add('a');
    const link = fakeMachines([mac]);
    const mirror = mirrorOf(link.machines);
    await mirror.start();
    link.online('mac');
    await vi.advanceTimersByTimeAsync(0);
    await mirror.flush();
    expect(readdirSync(directory)).toEqual(['mac']);

    link.set('mac', { mine: undefined });
    await mirror.flush();

    expect(mirror.state('mac')).toBeUndefined();
    expect(await mirror.session('mac', 'a')).toBeUndefined();
    expect(readdirSync(directory)).toEqual([]);
  });
});
