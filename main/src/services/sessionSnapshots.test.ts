import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionSnapshotService, type SessionSnapshotSources } from './sessionSnapshots';
import type { OrchestrationSessionSummary } from '../../../shared/types/orchestrationSession';
import type { ChatTabView } from '../../../shared/types/chatTab';
import type { AgentChatMessage } from '../../../shared/types/agentChat';
import type { SessionPanelLayout, ToolPanel } from '../../../shared/types/panels';
import type { JsonObject } from '../../../shared/validation/boundaryDecoder';
import type { SessionSnapshotHeld, SessionSnapshotsResult } from '../../../shared/types/sessionSnapshot';

/** One Session on the host: its record, its Pane's tabs, its layout and its chat's whole conversation. */
interface HostSession {
  record: OrchestrationSessionSummary;
  tabs: ToolPanel[];
  layout: SessionPanelLayout | null;
  messages: AgentChatMessage[];
  generation: number;
  /** The chat transcript's revision: it rises with every change to a message. */
  revision: number;
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
    revision: options.messages ?? 3,
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
        transcript: { panelId, generation: session.generation, revision: session.revision, start: session.messages.length - window.length, messages: structuredClone(window) },
        messageCount: session.messages.length,
      };
      return view;
    },
    announce: (sessionId, revision) => { announced.push({ sessionId, revision }); },
  };
  /** Appends or replaces one message, as the chat tab would, and tells the service with the tab's event. */
  const write = (service: SessionSnapshotService, sessionId: string, next: AgentChatMessage) => {
    const session = byId.get(sessionId)!;
    const found = session.messages.findIndex(entry => entry.id === next.id);
    const index = found >= 0 ? found : session.messages.length;
    session.messages[index] = next;
    session.revision += 1;
    service.send('chat-tab:event', { panelId: `chat-${sessionId}`, generation: session.generation, revision: session.revision, index, change: { type: 'replace', message: next } });
  };
  return { sources, byId, announced, chatReads, write };
}

/** What a desktop holds after an answer: each Session's conversation, message count and transcript revision. */
function heldAfter(answer: SessionSnapshotsResult): Record<string, SessionSnapshotHeld> {
  return Object.fromEntries(answer.snapshots.map(snapshot => [snapshot.sessionId, {
    generation: snapshot.chat.transcript!.generation,
    count: snapshot.chat.transcript!.start + snapshot.chat.transcript!.messages.length,
    revision: snapshot.chat.transcript!.revision,
  }]));
}

function tool(id: string, status: 'in_progress' | 'completed'): AgentChatMessage {
  return { id: `tool:${id}`, role: 'assistant', parts: [{ type: 'tool', id, title: `run ${id}`, status }] };
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

    expect((await service.snapshots({ since: first.revision, epoch: first.epoch })).snapshots).toEqual([]);

    vi.advanceTimersByTime(10);
    host.byId.get('b')!.messages.push(message(3));
    service.send('chat-tab:event', { panelId: 'chat-b', generation: 1, revision: 4, change: { type: 'replace', message: message(3) } });
    const second = await service.snapshots({ since: first.revision, epoch: first.epoch });

    expect(second.sessionIds).toEqual(['a', 'b']);
    expect(second.snapshots.map(snapshot => snapshot.sessionId)).toEqual(['b']);
    expect(second.revision).toBeGreaterThan(first.revision);
  });

  it('sends only the messages added or changed since what the desktop holds', async () => {
    const host = fakeHost([hostSession('a', { messages: 10 })]);
    const service = new SessionSnapshotService(host.sources);
    const first = await service.snapshots({});
    vi.advanceTimersByTime(10);
    host.write(service, 'a', message(10));
    host.write(service, 'a', message(11));

    const [snapshot] = (await service.snapshots({ since: first.revision, epoch: first.epoch, held: heldAfter(first) })).snapshots;

    expect(snapshot.chat.transcript?.start).toBe(10);
    expect(snapshot.chat.transcript?.messages.map(entry => entry.id)).toEqual(['m10', 'm11']);
    expect(snapshot.chat.messageCount).toBe(12);
  });

  it('sends an update to an earlier message, such as a tool call that finished after later ones began', async () => {
    const host = fakeHost([hostSession('a', { messages: 2 })]);
    const service = new SessionSnapshotService(host.sources);
    await service.snapshots({});
    // Two tool calls run side by side; the desktop reads while both are pending.
    host.write(service, 'a', tool('a', 'in_progress'));
    host.write(service, 'a', tool('b', 'in_progress'));
    vi.advanceTimersByTime(10);
    const pending = await service.snapshots({});

    vi.advanceTimersByTime(10);
    host.write(service, 'a', tool('a', 'completed'));
    const [update] = (await service.snapshots({ since: pending.revision, epoch: pending.epoch, held: heldAfter(pending) })).snapshots;

    expect(update.chat.transcript?.start).toBe(2);
    expect(update.chat.transcript?.messages.map(entry => entry.id)).toEqual(['tool:a', 'tool:b']);
    expect(update.chat.transcript?.messages[0]?.parts[0]).toMatchObject({ status: 'completed' });
  });

  it('sends nothing more of a chat whose messages did not change, though its Session did', async () => {
    const host = fakeHost([hostSession('a', { messages: 5 })]);
    const service = new SessionSnapshotService(host.sources);
    const first = await service.snapshots({});
    vi.advanceTimersByTime(10);
    service.send('panel:layoutChanged', { sessionId: 'pane-a' });

    const [snapshot] = (await service.snapshots({ since: first.revision, epoch: first.epoch, held: heldAfter(first) })).snapshots;

    expect(snapshot.chat.transcript?.start).toBe(5);
    expect(snapshot.chat.transcript?.messages).toEqual([]);
  });

  it('sends the whole window when the desktop holds another conversation, a gap, or changes from before it was watching', async () => {
    const host = fakeHost([hostSession('a', { messages: 60 })]);
    const service = new SessionSnapshotService(host.sources);
    const first = await service.snapshots({});
    const held = (change: Partial<SessionSnapshotHeld>) => ({ since: first.revision - 1, epoch: first.epoch, held: { a: { ...heldAfter(first).a!, ...change } } });

    const [otherConversation] = (await service.snapshots(held({ generation: 0 }))).snapshots;
    const [gap] = (await service.snapshots(held({ count: 5 }))).snapshots;
    // Messages may have changed before this host started watching the chat: nothing says which.
    const [unwatched] = (await service.snapshots(held({ revision: 40 }))).snapshots;

    for (const snapshot of [otherConversation, gap, unwatched]) {
      expect(snapshot.chat.transcript?.start).toBe(30);
      expect(snapshot.chat.transcript?.messages).toHaveLength(30);
    }
  });

  it('sends everything again to a desktop whose last answer came from before this host started', async () => {
    const host = fakeHost([hostSession('a', { messages: 5 })]);
    const before = new SessionSnapshotService(host.sources);
    const first = await before.snapshots({});
    // The host restarts with its clock set back: its revisions are lower than the desktop's `since`.
    vi.setSystemTime(new Date('2026-11-26T11:00:00.000Z'));
    const after = new SessionSnapshotService(host.sources);

    const answer = await after.snapshots({ since: first.revision, epoch: first.epoch, held: heldAfter(first) });

    expect(answer.epoch).not.toBe(first.epoch);
    expect(answer.snapshots.map(snapshot => snapshot.sessionId)).toEqual(['a']);
    expect(answer.snapshots[0]?.chat.transcript?.messages).toHaveLength(5);
  });

  it('keeps listing a Session whose chat cannot be read yet, and sends it once it can', async () => {
    const host = fakeHost([hostSession('a')]);
    const chat = host.sources.chat;
    vi.spyOn(host.sources, 'chat').mockImplementationOnce(() => undefined);
    const service = new SessionSnapshotService(host.sources);

    const first = await service.snapshots({});
    expect(first.sessionIds).toEqual(['a']);
    expect(first.snapshots).toEqual([]);
    vi.mocked(host.sources.chat).mockImplementation(chat);

    const second = await service.snapshots({ since: first.revision, epoch: first.epoch });
    expect(second.snapshots.map(snapshot => snapshot.sessionId)).toEqual(['a']);
  });

  it('sends tabs as the read-only projection: names and kinds of chat and terminal tabs, never their screens, launch input or files', async () => {
    const session = hostSession('a');
    const secrets = { screenText: 'export OPENAI_API_KEY=sk-live-123', initialInput: 'first prompt with a key', initialCommand: 'claude --api-key sk-live-123', selectionText: 'selected secret', content: 'unsaved file body' };
    session.tabs.push(
      { id: 'term', sessionId: 'pane-a', type: 'terminal', title: 'Terminal', state: { isActive: false, customState: { ...secrets, cwd: '/repo', isCliPanel: true } }, metadata: { createdAt: '', lastActiveAt: '', position: 1 } },
      { id: 'file', sessionId: 'pane-a', type: 'explorer', title: 'notes.md', state: { isActive: false, customState: { content: 'unsaved file body' } }, metadata: { createdAt: '', lastActiveAt: '', position: 2 } },
    );
    Object.assign(session.tabs[0]!.state, { customState: { ...secrets, agent: 'claude', status: 'idle' } });
    const host = fakeHost([session]);
    const service = new SessionSnapshotService(host.sources);

    const [snapshot] = (await service.snapshots({})).snapshots;
    const sent = JSON.stringify(snapshot.tabs);

    expect(snapshot.tabs.map(tab => [tab.id, tab.type, tab.title])).toEqual([['chat-a', 'chat', 'Claude'], ['term', 'terminal', 'Terminal']]);
    for (const [field, value] of Object.entries(secrets)) {
      expect(sent).not.toContain(field);
      expect(sent).not.toContain(value);
    }
    expect(snapshot.tabs[1]?.state.customState).toEqual({ cwd: '/repo', isCliPanel: true });
  });

  it('leaves a Session\'s launch settings out of its record (D-11)', async () => {
    const session = hostSession('a');
    Object.assign(session.record, { launchCommand: 'claude --api-key sk-live-123', customResume: { command: 'resume --key sk' }, openingPrompt: 'start with sk-live-123', profile: 'a profile' });
    const host = fakeHost([session]);
    const service = new SessionSnapshotService(host.sources);

    const [snapshot] = (await service.snapshots({})).snapshots;

    for (const field of ['launchCommand', 'customResume', 'openingPrompt', 'profile']) expect(snapshot.session).not.toHaveProperty(field);
    expect(JSON.stringify(snapshot)).not.toContain('sk-live-123');
    expect(snapshot.session.name).toBe('Session a');
  });

  it('raises a Session\'s revision on a change to its record, tabs, layout or chat, and not on its order or selection', async () => {
    const host = fakeHost([hostSession('a'), hostSession('b')]);
    const service = new SessionSnapshotService(host.sources);
    const first = await service.snapshots({});
    let since = first.revision;
    const changedAfter = async (channel: string, payload: JsonObject) => {
      vi.advanceTimersByTime(5);
      service.send(channel, payload);
      const result = await service.snapshots({ since, epoch: first.epoch });
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

    const second = await service.snapshots({ since: first.revision, epoch: first.epoch });

    expect(second.sessionIds).toEqual([]);
    expect(second.snapshots).toEqual([]);
  });

  it('announces a change at once, then at most once a second per Session with its latest revision', async () => {
    const host = fakeHost([hostSession('a'), hostSession('b')]);
    const service = new SessionSnapshotService(host.sources);
    const firstAnswer = await service.snapshots({});
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
    const latest = await service.snapshots({ since: forA[forA.length - 2]!.revision, epoch: firstAnswer.epoch });
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

  it('replaces any string over 4 KB outside a message\'s text with its length, wherever it is', async () => {
    const session = hostSession('a', { messages: 0 });
    const big = 'x'.repeat(60_000);
    const longText = 'y'.repeat(9_000);
    session.messages.push({
      id: 'heavy', role: 'assistant', parts: [
        { type: 'text', text: longText },
        { type: 'content', content: { type: 'image', mimeType: 'image/png', data: big } },
        { type: 'content', content: { type: 'image', mimeType: 'image/png', data: 'small' } },
        { type: 'content', content: { type: 'image', mimeType: 'image/png', uri: `data:image/png;base64,${big}` } },
        { type: 'tool', id: 't', title: 'read', status: 'completed',
          input: { path: '/a.png', body: big },
          output: [{ type: 'image', data: big }],
          content: [{ type: 'content', content: { type: 'resource', resource: { uri: 'file:///a.pdf', blob: big, text: big } } }, big] },
      ],
    });
    const host = fakeHost([session]);
    const service = new SessionSnapshotService(host.sources);

    const [snapshot] = (await service.snapshots({})).snapshots;
    const parts = snapshot.chat.transcript!.messages[0]!.parts;
    const omitted = (field: string) => ({ omitted: { field, length: 60_000 } });

    expect(parts[0]).toEqual({ type: 'text', text: longText });
    expect(parts[1]).toEqual({ type: 'content', content: { type: 'image', mimeType: 'image/png', data: omitted('data') } });
    expect(parts[2]).toEqual({ type: 'content', content: { type: 'image', mimeType: 'image/png', data: 'small' } });
    expect(parts[3]).toEqual({ type: 'content', content: { type: 'image', mimeType: 'image/png', uri: { omitted: { field: 'uri', length: 60_000 + 'data:image/png;base64,'.length } } } });
    expect(parts[4]).toMatchObject({
      input: { path: '/a.png', body: omitted('body') },
      output: [{ type: 'image', data: omitted('data') }],
      content: [{ content: { resource: { uri: 'file:///a.pdf', blob: omitted('blob'), text: omitted('text') } } }, omitted('1')],
    });
    expect(JSON.stringify(snapshot).length).toBeLessThan(15_000);
    // The host's own conversation keeps its bytes.
    expect(JSON.stringify(session.messages)).toContain(big);
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
