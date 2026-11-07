import { describe, expect, it } from 'vitest';
import type { NotifyItem } from '../../../../shared/types/notify';
import { WorkspaceJournal } from '../workspaceJournal';
import { connectAutopilotEvents, NO_ANSWER, type AutopilotEventSession } from './autopilotEvents';

const AUTOPILOT_KINDS = ['item.created', 'item.answered', 'session.created', 'session.archived', 'orchestrator.turn_ended'] as const;

function item(id: string, overrides: Partial<NotifyItem> = {}): NotifyItem {
  return {
    id,
    ui: 'approve',
    title: `Ship ${id}?`,
    state: 'waiting',
    createdAt: 1,
    source: { paneId: 'pane-1', panelId: 'panel-1', name: 'Worker', agent: 'Claude', session: { id: 's-1', name: 'Release', paneId: 'session-pane-1' } },
    ...overrides,
  };
}

interface FakeState {
  waiting: NotifyItem[];
  items: NotifyItem[];
  sessions: AutopilotEventSession[];
}

function setup() {
  const journal = new WorkspaceJournal();
  const state: FakeState = { waiting: [], items: [], sessions: [] };
  const notifyListeners = new Set<() => void>();
  const sessionListeners = new Set<() => void>();
  const disconnect = connectAutopilotEvents({
    journal,
    notify: {
      waiting: () => state.waiting,
      items: () => state.items,
      subscribe: (listener) => { notifyListeners.add(listener); return () => notifyListeners.delete(listener); },
    },
    sessions: {
      list: async () => state.sessions,
      subscribe: (listener) => { sessionListeners.add(listener); return () => sessionListeners.delete(listener); },
    },
  });
  const notifyChanged = () => { for (const listener of notifyListeners) listener(); };
  const sessionsChanged = async () => { for (const listener of sessionListeners) listener(); await settle(); };
  const read = () => journal.readAfter(0, { kinds: [...AUTOPILOT_KINDS] }).entries;
  return { journal, state, notifyChanged, sessionsChanged, read, disconnect, notifyListeners };
}

const settle = () => new Promise(resolve => setTimeout(resolve, 0));

describe('connectAutopilotEvents', () => {
  it('says why an item left: its receipt names who closed it, and only a stopped asker reads as no answer', () => {
    const { state, notifyChanged, read } = setup();
    state.waiting = ['a', 'b', 'c'].map(id => item(id));
    notifyChanged();
    state.items = [
      item('a', { state: 'expired', closed: { by: 'autopilot', reason: 'no build behind it', at: 1 } }),
      item('b', { state: 'expired', closed: { by: 'pane', reason: 'Session archived', at: 1 } }),
      item('c', { state: 'expired', closed: { by: 'pane', reason: 'the asker stopped waiting', at: 1 } }),
    ];
    state.waiting = [];
    notifyChanged();
    expect(read().filter(entry => entry.kind === 'item.answered').map(entry => entry.reason)).toEqual([
      'Closed by Autopilot: no build behind it: Ship a?',
      'Closed: Session archived: Ship b?',
      `${NO_ANSWER}Ship c?`,
    ]);
  });

  it('says who brought back an item that was closed', () => {
    const { state, notifyChanged, read } = setup();
    state.waiting = [item('a', { reopened: { by: 'you', at: 1, closedBy: 'autopilot', closedReason: 'stale' } })];
    notifyChanged();
    expect(read().map(entry => entry.reason)).toEqual(['Reopened by you, after Autopilot closed it (stale): Ship a?']);
  });

  it('journals item.created when a question starts waiting and item.answered when it stops', () => {
    const s = setup();
    s.state.waiting = [item('n-1')];
    s.notifyChanged();
    s.notifyChanged();
    expect(s.read()).toMatchObject([{
      kind: 'item.created', itemId: 'n-1', paneId: 'pane-1', paneName: 'Worker', panelId: 'panel-1',
      sessionId: 's-1', sessionName: 'Release', reason: 'Ship n-1?', source: 'agent',
    }]);

    s.state.waiting = [];
    s.state.items = [item('n-1', { state: 'answered', title: 'Ship n-1? (answered)' })];
    s.notifyChanged();
    expect(s.read().map(entry => [entry.kind, entry.itemId, entry.reason])).toEqual([
      ['item.created', 'n-1', 'Ship n-1?'],
      ['item.answered', 'n-1', 'Ship n-1? (answered)'],
    ]);
  });

  it('says an item that expired was not answered: its asker stopped waiting', () => {
    const s = setup();
    s.state.waiting = [item('n-3')];
    s.notifyChanged();
    s.state.waiting = [];
    s.state.items = [item('n-3', { state: 'expired' })];
    s.notifyChanged();
    expect(s.read().map(entry => [entry.kind, entry.reason])).toEqual([
      ['item.created', 'Ship n-3?'],
      ['item.answered', `${NO_ANSWER}Ship n-3?`],
    ]);
  });

  it('skips item.created for Autopilot\'s own questions but journals their answers', () => {
    const s = setup();
    const own = item('n-2', { source: { name: 'Autopilot', agent: 'Claude', autopilot: true } });
    s.state.waiting = [own];
    s.notifyChanged();
    expect(s.read()).toEqual([]);
    s.state.waiting = [];
    s.notifyChanged();
    expect(s.read()).toMatchObject([{ kind: 'item.answered', itemId: 'n-2', paneId: '', paneName: 'Autopilot' }]);
  });

  it('journals session.created and session.archived against a baseline read', async () => {
    const s = setup();
    s.state.sessions = [{ id: 's-0', name: 'Existing', paneId: 'sp-0' }];
    await settle();
    expect(s.read()).toEqual([]);

    s.state.sessions = [{ id: 's-0', name: 'Existing', paneId: 'sp-0' }, { id: 's-1', name: 'Release', paneId: 'sp-1' }];
    await s.sessionsChanged();
    s.state.sessions = [{ id: 's-0', name: 'Existing', paneId: 'sp-0', archived: true }, { id: 's-1', name: 'Release', paneId: 'sp-1' }];
    await s.sessionsChanged();
    await s.sessionsChanged();
    expect(s.read().map(entry => [entry.kind, entry.sessionId, entry.paneId, entry.paneName])).toEqual([
      ['session.created', 's-1', 'sp-1', 'Release'],
      ['session.archived', 's-0', 'sp-0', 'Existing'],
    ]);
  });

  it('journals orchestrator.turn_ended when a Session orchestrator goes from working to idle', async () => {
    const s = setup();
    s.state.sessions = [{ id: 's-1', name: 'Release', paneId: 'sp-1' }];
    await s.sessionsChanged();
    const status = (paneId: string, state: string, reason: string | null = 'rule') =>
      s.journal.send('panel:agentStatus', { panelId: `${paneId}-panel`, sessionId: paneId, state, reason });

    status('sp-1', 'idle');
    status('sp-1', 'working');
    status('sp-1', 'idle');
    // A worker Pane is not an orchestrator; a process starting is not a turn.
    status('worker', 'working');
    status('worker', 'idle');
    status('sp-1', 'working');
    status('sp-1', 'idle', 'exit');
    expect(s.read()).toMatchObject([{
      kind: 'orchestrator.turn_ended', paneId: 'sp-1', panelId: 'sp-1-panel', sessionId: 's-1', sessionName: 'Release', from: 'working', to: 'idle',
    }]);
  });

  it('delivers the kinds only to watches that list them, and wakes such a watch at once', async () => {
    const s = setup();
    const waiting = s.journal.waitAfter(0, { kinds: ['item.created'], agentsOnly: true }, 5_000, 256, 'autopilot');
    s.state.waiting = [item('n-3')];
    s.notifyChanged();
    const result = await waiting;
    expect(result.timedOut).toBe(false);
    expect(result.entries.map(entry => entry.kind)).toEqual(['item.created']);
    // A default watch, an agents-only watch, and a Session-scoped watch without kinds never see them.
    expect(s.journal.readAfter(0, {}).entries).toEqual([]);
    expect(s.journal.readAfter(0, { agentsOnly: true }).entries).toEqual([]);
    expect(s.journal.readAfter(0, { sessionId: 's-1' }).entries).toEqual([]);
    expect(s.journal.readAfter(0, { kinds: ['agent.report', 'agent.blocked', 'panel.exited', 'pane.gone'] }).entries).toEqual([]);
  });

  it('stops journalling once disconnected', () => {
    const s = setup();
    s.disconnect();
    expect(s.notifyListeners.size).toBe(0);
    s.state.waiting = [item('n-4')];
    s.notifyChanged();
    expect(s.read()).toEqual([]);
  });
});
