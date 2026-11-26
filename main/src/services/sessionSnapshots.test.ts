import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionSnapshotService, type SessionSnapshotSources } from './sessionSnapshots';
import type { OrchestrationSessionSummary } from '../../../shared/types/orchestrationSession';
import type { ChatTabView } from '../../../shared/types/chatTab';
import type { AgentChatMessage } from '../../../shared/types/agentChat';
import type { SessionPanelLayout, ToolPanel } from '../../../shared/types/panels';
import type { JsonObject } from '../../../shared/validation/boundaryDecoder';

/** One Session on the host: its record, its Pane's tabs, its layout and its chat's whole conversation. */
interface HostSession {
  record: OrchestrationSessionSummary;
  tabs: ToolPanel[];
  layout: SessionPanelLayout | null;
  messages: AgentChatMessage[];
  generation: number;
}

function message(index: number, text = `message ${index}`): AgentChatMessage {
  return { id: `m${index}`, role: index % 2 === 0 ? 'user' : 'assistant', parts: [{ type: 'text', text }] };
}

function hostSession(id: string, options: { messages?: number; archived?: boolean; agentTab?: 'chat' | 'terminal' } = {}): HostSession {
  const pane = `pane-${id}`;
  const chatPanel = `chat-${id}`;
  return {
    record: {
      id,
      name: `Session ${id}`,
      archived: options.archived,
      agent: 'claude',
      internalSessionId: pane,
      panelIds: { claude: chatPanel, codex: `codex-${id}` },
      goal: '', context: '', decisions: [], blockers: [], nextAction: '', evidence: [], outputs: [], associations: [],
      revision: 1, createdAt: '2026-11-26T00:00:00.000Z', updatedAt: '2026-11-26T00:00:00.000Z',
    },
    tabs: [{
      id: chatPanel, sessionId: pane, type: options.agentTab ?? 'chat', title: 'Claude',
      state: { isActive: true }, metadata: { createdAt: '2026-11-26T00:00:00.000Z', lastActiveAt: '2026-11-26T00:00:00.000Z', position: 0 },
    }],
    layout: null,
    messages: Array.from({ length: options.messages ?? 3 }, (_, index) => message(index)),
    generation: 1,
  };
}

/** A fake host behind the service's ports, which records every call that could change something. */
function fakeHost(sessions: HostSession[]) {
  const byId = new Map(sessions.map(session => [session.record.id, session]));
  const announced: Array<{ sessionId: string; revision: number }> = [];
  const chatReads: Array<{ panelId: string; limit: number }> = [];
  const findByPanel = (panelId: string) => [...byId.values()].find(session => session.tabs.some(tab => tab.id === panelId));
  const sources: SessionSnapshotSources = {
    sessions: async () => [...byId.values()].map(session => structuredClone(session.record)),
    tabs: paneId => structuredClone([...byId.values()].find(session => session.record.internalSessionId === paneId)?.tabs ?? []),
    panel: panelId => findByPanel(panelId)?.tabs.find(tab => tab.id === panelId),
    layout: paneId => structuredClone([...byId.values()].find(session => session.record.internalSessionId === paneId)?.layout ?? null),
    chat: (panelId, limit) => {
      chatReads.push({ panelId, limit });
      const session = findByPanel(panelId);
      if (!session) return undefined;
      const window = session.messages.slice(Math.max(0, session.messages.length - limit));
      const view: ChatTabView = {
        panelId, agent: 'claude', generation: session.generation, status: 'idle',
        canAttachImages: true, controls: [], commands: [], permissions: [], questions: [], queue: [],
        transcript: { panelId, generation: session.generation, revision: session.messages.length, start: session.messages.length - window.length, messages: structuredClone(window) },
        messageCount: session.messages.length,
      };
      return view;
    },
    announce: (sessionId, revision) => { announced.push({ sessionId, revision }); },
  };
  return { sources, byId, announced, chatReads };
}

describe('SessionSnapshotService', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-26T12:00:00.000Z'));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('answers a first read with every unarchived chat Session: its summary, tabs, layout and newest messages', async () => {
    const host = fakeHost([hostSession('a'), hostSession('b', { archived: true }), hostSession('c', { agentTab: 'terminal' })]);
    host.byId.get('a')!.layout = { version: 1, root: { type: 'group', id: 'g1', panelIds: ['chat-a'], activePanelId: 'chat-a' } };
    const service = new SessionSnapshotService(host.sources);

    const result = await service.snapshots({});

    expect(result.sessionIds).toEqual(['a']);
    expect(result.snapshots).toHaveLength(1);
    const [snapshot] = result.snapshots;
    expect(snapshot.session.name).toBe('Session a');
    expect(snapshot.tabs.map(tab => tab.id)).toEqual(['chat-a']);
    expect(snapshot.layout?.root).toEqual({ type: 'group', id: 'g1', panelIds: ['chat-a'], activePanelId: 'chat-a' });
    expect(snapshot.chat.transcript?.messages.map(entry => entry.id)).toEqual(['m0', 'm1', 'm2']);
    expect(snapshot.chat.messageCount).toBe(3);
    expect(result.revision).toBeGreaterThanOrEqual(snapshot.revision);
  });

  it('caps a snapshot at the newest 30 messages, numbered from the conversation\'s first', async () => {
    const host = fakeHost([hostSession('a', { messages: 75 })]);
    const service = new SessionSnapshotService(host.sources);

    const [snapshot] = (await service.snapshots({})).snapshots;

    expect(host.chatReads).toEqual([{ panelId: 'chat-a', limit: 30 }]);
    expect(snapshot.chat.transcript?.messages).toHaveLength(30);
    expect(snapshot.chat.transcript?.start).toBe(45);
    expect(snapshot.chat.transcript?.messages[0]?.id).toBe('m45');
    expect(snapshot.chat.messageCount).toBe(75);
  });

  it('returns only the Sessions that changed since the last answer', async () => {
    const host = fakeHost([hostSession('a'), hostSession('b')]);
    const service = new SessionSnapshotService(host.sources);
    const first = await service.snapshots({});

    expect((await service.snapshots({ since: first.revision })).snapshots).toEqual([]);

    vi.advanceTimersByTime(10);
    host.byId.get('b')!.messages.push(message(3));
    service.send('chat-tab:event', { panelId: 'chat-b', generation: 1, revision: 4, change: { type: 'replace', message: message(3) } });
    const second = await service.snapshots({ since: first.revision });

    expect(second.sessionIds).toEqual(['a', 'b']);
    expect(second.snapshots.map(snapshot => snapshot.sessionId)).toEqual(['b']);
    expect(second.revision).toBeGreaterThan(first.revision);
  });

  it('sends only the messages after the ones the desktop holds, with the last held one again', async () => {
    const host = fakeHost([hostSession('a', { messages: 10 })]);
    const service = new SessionSnapshotService(host.sources);
    const first = await service.snapshots({});
    host.byId.get('a')!.messages.push(message(10), message(11));
    vi.advanceTimersByTime(10);
    service.send('chat-tab:event', { panelId: 'chat-a', generation: 1, revision: 12, change: { type: 'replace', message: message(11) } });

    const [snapshot] = (await service.snapshots({ since: first.revision, held: { a: { generation: 1, count: 10 } } })).snapshots;

    expect(snapshot.chat.transcript?.start).toBe(9);
    expect(snapshot.chat.transcript?.messages.map(entry => entry.id)).toEqual(['m9', 'm10', 'm11']);
    expect(snapshot.chat.messageCount).toBe(12);
  });

  it('sends the whole window when the desktop holds another conversation or a gap it cannot fill', async () => {
    const host = fakeHost([hostSession('a', { messages: 60 })]);
    const service = new SessionSnapshotService(host.sources);

    const [otherConversation] = (await service.snapshots({ held: { a: { generation: 0, count: 59 } } })).snapshots;
    const [gap] = (await service.snapshots({ held: { a: { generation: 1, count: 5 } } })).snapshots;

    expect(otherConversation.chat.transcript?.start).toBe(30);
    expect(otherConversation.chat.transcript?.messages).toHaveLength(30);
    expect(gap.chat.transcript?.start).toBe(30);
  });

  it('raises a Session\'s revision on a change to its record, tabs, layout or chat, and not on its order or selection', async () => {
    const host = fakeHost([hostSession('a'), hostSession('b')]);
    const service = new SessionSnapshotService(host.sources);
    let since = (await service.snapshots({})).revision;
    const changedAfter = async (channel: string, payload: JsonObject) => {
      vi.advanceTimersByTime(5);
      service.send(channel, payload);
      const result = await service.snapshots({ since });
      since = result.revision;
      return result.snapshots.map(snapshot => snapshot.sessionId);
    };

    expect(await changedAfter('orchestration-sessions:changed', { sessionId: 'a', kind: 'updated' })).toEqual(['a']);
    expect(await changedAfter('panel:created', { id: 'browser-b', sessionId: 'pane-b', type: 'browser' })).toEqual(['b']);
    expect(await changedAfter('panel:updated', { id: 'chat-a', sessionId: 'pane-a', type: 'chat' })).toEqual(['a']);
    expect(await changedAfter('panel:deleted', { panelId: 'browser-b', sessionId: 'pane-b' })).toEqual(['b']);
    expect(await changedAfter('panel:layoutChanged', { sessionId: 'pane-a' })).toEqual(['a']);
    expect(await changedAfter('chat-tab:view', { panelId: 'chat-b', status: 'working' })).toEqual(['b']);
    expect(await changedAfter('orchestration-sessions:changed', { sessionId: 'a', kind: 'reordered' })).toEqual([]);
    expect(await changedAfter('orchestration-sessions:changed', { sessionId: 'b', kind: 'selected' })).toEqual([]);
    expect(await changedAfter('terminal:output', { panelId: 'chat-a', data: 'x' })).toEqual([]);
  });

  it('lists a Session archived or deleted on the host no more, so the desktop drops it', async () => {
    const host = fakeHost([hostSession('a'), hostSession('b')]);
    const service = new SessionSnapshotService(host.sources);
    const first = await service.snapshots({});
    host.byId.get('a')!.record.archived = true;
    host.byId.delete('b');
    service.send('orchestration-sessions:changed', { sessionId: 'a', kind: 'archived' });

    const second = await service.snapshots({ since: first.revision });

    expect(second.sessionIds).toEqual([]);
    expect(second.snapshots).toEqual([]);
  });

  it('announces a change at once, then at most once a second per Session with its latest revision', async () => {
    const host = fakeHost([hostSession('a'), hostSession('b')]);
    const service = new SessionSnapshotService(host.sources);
    await service.snapshots({});
    const chatEvent = (panelId: string) => service.send('chat-tab:event', { panelId, generation: 1, revision: 1, change: { type: 'replace', message: message(0) } });

    chatEvent('chat-a');
    expect(host.announced.map(notice => notice.sessionId)).toEqual(['a']);
    // A chat streaming for 2.5 s: 25 events, one tenth of a second apart, beside one change to b.
    for (let tick = 0; tick < 25; tick += 1) {
      vi.advanceTimersByTime(100);
      chatEvent('chat-a');
      if (tick === 3) chatEvent('chat-b');
    }
    vi.advanceTimersByTime(1000);

    const forA = host.announced.filter(notice => notice.sessionId === 'a');
    expect(forA).toHaveLength(4);
    expect(host.announced.filter(notice => notice.sessionId === 'b')).toHaveLength(1);
    // Each notice carries a newer revision, and the last one the revision the next read reports.
    expect(forA.map(notice => notice.revision)).toEqual([...forA.map(notice => notice.revision)].sort((left, right) => left - right));
    const latest = await service.snapshots({ since: forA[forA.length - 2]!.revision });
    expect(latest.snapshots.find(snapshot => snapshot.sessionId === 'a')?.revision).toBe(forA[forA.length - 1]!.revision);
  });

  it('announces nothing for a change it cannot place in a chat Session', async () => {
    const host = fakeHost([hostSession('a')]);
    const service = new SessionSnapshotService(host.sources);
    await service.snapshots({});

    service.send('panel:updated', { id: 'other', sessionId: 'some-worker-pane', type: 'terminal' });
    service.send('chat-tab:event', { panelId: 'unknown', generation: 1, revision: 1 });
    service.send('orchestration-sessions:changed', { sessionId: '', kind: 'updated' });
    vi.advanceTimersByTime(2000);

    expect(host.announced).toEqual([]);
  });

  it('places a change in a Session created after its last read', async () => {
    const host = fakeHost([hostSession('a')]);
    const service = new SessionSnapshotService(host.sources);
    await service.snapshots({});
    const added = hostSession('b');
    host.byId.set('b', added);

    service.send('orchestration-sessions:changed', { sessionId: 'b', kind: 'created' });
    await vi.runOnlyPendingTimersAsync();
    service.send('chat-tab:event', { panelId: 'chat-b', generation: 1, revision: 1 });
    await vi.advanceTimersByTimeAsync(1500);

    expect(host.announced.map(notice => notice.sessionId)).toEqual(['b', 'b']);
  });

  it('places a Session created while an earlier read of the list was still running', async () => {
    const host = fakeHost([hostSession('a')]);
    const list = host.sources.sessions;
    let release: () => void = () => undefined;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const sessions = vi.spyOn(host.sources, 'sessions').mockImplementationOnce(async () => {
      // Listed before b was created, and answered only after.
      const listed = await list();
      await gate;
      return listed;
    });
    const service = new SessionSnapshotService(host.sources);
    const first = service.snapshots({});
    host.byId.set('b', hostSession('b'));

    service.send('orchestration-sessions:changed', { sessionId: 'b', kind: 'created' });
    release();
    await first;
    await vi.runOnlyPendingTimersAsync();

    expect(sessions).toHaveBeenCalledTimes(2);
    expect(host.announced.map(notice => notice.sessionId)).toEqual(['b']);
  });

  it('replaces an attachment\'s large inline bytes with their length and leaves small ones alone', async () => {
    const session = hostSession('a', { messages: 0 });
    const image = 'x'.repeat(300_000);
    session.messages.push({
      id: 'with-image', role: 'user', parts: [
        { type: 'text', text: 'look' },
        { type: 'content', content: { type: 'image', mimeType: 'image/png', data: image } },
        { type: 'content', content: { type: 'image', mimeType: 'image/png', data: 'small' } },
        { type: 'tool', id: 't', title: 'read', status: 'completed', content: [{ type: 'content', content: { type: 'resource', resource: { uri: 'file:///a.pdf', blob: image } } }] },
      ],
    });
    const host = fakeHost([session]);
    const service = new SessionSnapshotService(host.sources);

    const [snapshot] = (await service.snapshots({})).snapshots;
    const parts = snapshot.chat.transcript!.messages[0]!.parts;

    expect(parts[1]).toEqual({ type: 'content', content: { type: 'image', mimeType: 'image/png', omitted: { field: 'data', length: 300_000 } } });
    expect(parts[2]).toEqual({ type: 'content', content: { type: 'image', mimeType: 'image/png', data: 'small' } });
    expect(parts[3]).toMatchObject({ content: [{ content: { resource: { uri: 'file:///a.pdf', omitted: { field: 'blob', length: 300_000 } } } }] });
    expect(JSON.stringify(snapshot).length).toBeLessThan(10_000);
    // The host's own conversation keeps its bytes.
    expect(JSON.stringify(session.messages)).toContain(image);
  });

  it('reads the Session list again only after a Session changed, or once it is a minute old', async () => {
    const host = fakeHost([hostSession('a')]);
    const sessions = vi.spyOn(host.sources, 'sessions');
    const service = new SessionSnapshotService(host.sources);
    await service.snapshots({});

    service.send('chat-tab:event', { panelId: 'chat-a', generation: 1, revision: 1 });
    await service.snapshots({});
    expect(sessions).toHaveBeenCalledTimes(1);

    host.byId.get('a')!.record.name = 'Renamed';
    service.send('orchestration-sessions:changed', { sessionId: 'a', kind: 'updated' });
    const [renamed] = (await service.snapshots({})).snapshots;
    expect(renamed.session.name).toBe('Renamed');

    const reads = sessions.mock.calls.length;
    vi.advanceTimersByTime(61_000);
    await service.snapshots({});
    expect(sessions).toHaveBeenCalledTimes(reads + 1);
  });

  it('stops announcing once disposed', async () => {
    const host = fakeHost([hostSession('a')]);
    const service = new SessionSnapshotService(host.sources);
    await service.snapshots({});
    service.send('chat-tab:event', { panelId: 'chat-a', generation: 1, revision: 1 });
    service.send('chat-tab:event', { panelId: 'chat-a', generation: 1, revision: 2 });

    service.dispose();
    vi.advanceTimersByTime(2000);

    expect(host.announced).toHaveLength(1);
  });
});
