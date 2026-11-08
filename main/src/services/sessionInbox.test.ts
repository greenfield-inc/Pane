import Database from 'better-sqlite3-multiple-ciphers';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ApprovalStore } from './approvals/approvalStore';
import { SessionInbox, type SessionInboxStore } from './sessionInbox';
import { WorkspaceJournal } from './workspaceJournal';
import type { RunpaneWorkspaceEntry } from '../../../shared/types/runpaneOrchestration';

type Entry = Omit<RunpaneWorkspaceEntry, 'gen' | 'at'>;

describe('SessionInbox', () => {
  let db: Database.Database;
  let journal: WorkspaceJournal;
  const members = new Map<string, string[]>([['pane-1', ['session-a']], ['pane-2', ['session-a', 'session-b']]]);
  const open = () => {
    const inbox = new SessionInbox(new ApprovalStore(db, 'mini'), { sessionIdsFor: paneId => members.get(paneId) ?? [], itemsPerSession: () => 3 });
    inbox.attach(journal);
    return inbox;
  };
  const entry = (kind: Entry['kind'], paneId = 'pane-1', extra: Partial<Entry> = {}): Entry =>
    ({ kind, paneId, paneName: paneId, panelId: `${paneId}-panel`, agentType: 'claude', source: 'agent', ...extra });

  beforeEach(() => {
    db = new Database(':memory:');
    journal = new WorkspaceJournal();
  });
  afterEach(() => db.close());

  it('keeps reports, missing reports and questions per Session until acknowledged, across restarts', () => {
    const inbox = open();
    journal.append(entry('agent.report', 'pane-1', { report: { state: 'ready', pr: 12, reportedAt: '2026-10-15T10:00:00.000Z' } }));
    journal.append(entry('agent.report.missing', 'pane-2', { reason: 'ready', lastOutput: 'Done.' }));
    journal.append(entry('agent.busy', 'pane-1'));
    journal.append({ kind: 'pane.created', paneId: 'pane-3', paneName: 'Other', source: 'session' });

    const items = inbox.list('session-a');
    expect(items.map(item => [item.kind, item.paneId])).toEqual([['report', 'pane-1'], ['report.missing', 'pane-2']]);
    expect(items[0].report).toMatchObject({ state: 'ready', pr: 12 });
    expect(items[1]).toMatchObject({ reason: 'ready', lastOutput: 'Done.' });
    expect(inbox.list('session-b').map(item => item.kind)).toEqual(['report.missing']);

    inbox.dispose();
    const reopened = open();
    expect(reopened.list('session-a').map(item => item.id)).toEqual(items.map(item => item.id));
    expect(reopened.ack([items[0].id, 'in-unknown'], 'session-a')).toEqual({ acknowledged: [items[0].id], unknown: ['in-unknown'] });
    expect(reopened.list('session-a').map(item => item.kind)).toEqual(['report.missing']);
    expect(reopened.ackAll('session-b')).toHaveLength(1);
    expect(reopened.list('session-b')).toEqual([]);
  });

  it('lists every Session’s items and tells listeners when a report arrives or is acknowledged', () => {
    const inbox = open();
    let heard = 0;
    const stop = inbox.subscribe(() => { heard += 1; });
    journal.append(entry('agent.report', 'pane-2', { report: { state: 'blocked', question: 'Invoice id or number?', reportedAt: '2026-10-15T10:00:00.000Z' } }));
    expect(heard).toBe(1);
    expect(inbox.all().map(item => [item.sessionId, item.report?.question])).toEqual([['session-a', 'Invoice id or number?'], ['session-b', 'Invoice id or number?']]);

    inbox.ackAll('session-a');
    expect(heard).toBe(2);
    expect(inbox.all().map(item => item.sessionId)).toEqual(['session-b']);
    stop();
    inbox.ackAll('session-b');
    expect(heard).toBe(2);
  });

  it('keeps its items in memory through a failed write, and refuses an acknowledgement it could not save', () => {
    const store = new ApprovalStore(db, 'mini');
    let failing = false;
    const flaky: SessionInboxStore = {
      unackedInboxItems: () => store.unackedInboxItems(),
      saveInboxItem: (item, name) => store.saveInboxItem(item, name),
      ackInboxItem: (id, at, decision) => store.ackInboxItem(id, at, decision),
      dropInboxItem: (id, at) => store.dropInboxItem(id, at),
      meta: key => store.meta(key),
      setMeta: (key, value) => store.setMeta(key, value),
      recordDecision: (id, decision) => store.recordDecision(id, decision),
      transaction: (writes) => {
        if (failing) throw new Error('disk full');
        store.transaction(writes);
      },
    };
    const inbox = new SessionInbox(flaky, { sessionIdsFor: paneId => members.get(paneId) ?? [], itemsPerSession: () => 3 });
    inbox.attach(journal);
    journal.append(entry('agent.report', 'pane-1', { report: { state: 'done', summary: 'A done', reportedAt: '2026-10-15T10:00:00.000Z' } }));
    const [handled] = inbox.list('session-a');
    inbox.ack([handled.id], 'session-a');
    failing = true;
    journal.append(entry('agent.report', 'pane-1', { report: { state: 'done', summary: 'B done', reportedAt: '2026-10-15T10:01:00.000Z' } }));
    const [pending] = inbox.list('session-a');
    expect(pending.report?.summary).toBe('B done');
    expect(() => inbox.ack([pending.id], 'session-a')).toThrow(/remain unacknowledged/);
    expect(inbox.list('session-a').map(item => item.id)).toEqual([pending.id]);
    inbox.dispose();
  });

  it('says how a worker question left, for its card', () => {
    const inbox = open();
    const ended: Array<[string, string, string | undefined]> = [];
    inbox.subscribeEnded(({ id, how, decision }) => ended.push([id, how, decision]));
    const report = (question: string) => ({ report: { state: 'blocked' as const, question, reportedAt: '2026-10-15T10:00:00.000Z' } });
    journal.append(entry('agent.report', 'pane-1', report('Q-1: a?')));
    const [first] = inbox.list('session-a');
    journal.append(entry('agent.report', 'pane-1', report('Q-2: b?')));
    expect(ended).toEqual([[first.id, 'moved-on', undefined]]);
    const [second] = inbox.list('session-a');
    inbox.ack([second.id], 'session-a', 'D-9');
    expect(ended[1]).toEqual([second.id, 'acked', 'D-9']);
    inbox.dispose();
  });

  it('replaces a missing report with the report that follows it', () => {
    const inbox = open();
    journal.append(entry('agent.report.missing'));
    journal.append(entry('agent.report', 'pane-1', { report: { state: 'done', reportedAt: '2026-10-15T10:00:00.000Z' } }));
    journal.append(entry('agent.report', 'pane-1', { report: { state: 'failed', reportedAt: '2026-10-15T10:01:00.000Z' } }));

    expect(inbox.list('session-a').map(item => [item.kind, item.report?.state])).toEqual([['report', 'failed']]);
  });

  it('drops a question once its panel moves on', () => {
    const inbox = open();
    journal.append(entry('agent.blocked', 'pane-1', { reason: 'live_blocked_form', screenLines: ['Pick one', '❯ 1. Yes'] }));
    expect(inbox.list('session-a')).toEqual([expect.objectContaining({ kind: 'blocked', screenLines: ['Pick one', '❯ 1. Yes'] })]);

    journal.append(entry('agent.busy'));
    expect(inbox.list('session-a')).toEqual([]);
  });

  it('ignores replayed entries and keeps the newest items of each Session', () => {
    const inbox = open();
    journal.append(entry('agent.report.missing', 'pane-1', { replay: true }));
    expect(inbox.list('session-a')).toEqual([]);

    for (let index = 0; index < 5; index += 1) {
      journal.append(entry('agent.report.missing', 'pane-1', { panelId: `panel-${index}` }));
    }
    expect(inbox.list('session-a').map(item => item.panelId)).toEqual(['panel-2', 'panel-3', 'panel-4']);
  });
});
