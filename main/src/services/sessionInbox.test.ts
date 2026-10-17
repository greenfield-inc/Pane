import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MAX_INBOX_ITEMS_PER_SESSION, SessionInbox } from './sessionInbox';
import { WorkspaceJournal } from './workspaceJournal';
import type { RunpaneWorkspaceEntry } from '../../../shared/types/runpaneOrchestration';

type Entry = Omit<RunpaneWorkspaceEntry, 'gen' | 'at'>;

describe('SessionInbox', () => {
  let directory: string;
  let filePath: string;
  let journal: WorkspaceJournal;
  const members = new Map<string, string[]>([['pane-1', ['session-a']], ['pane-2', ['session-a', 'session-b']]]);
  const open = () => {
    const inbox = new SessionInbox(filePath, { sessionIdsFor: paneId => members.get(paneId) ?? [] });
    inbox.attach(journal);
    return inbox;
  };
  const entry = (kind: Entry['kind'], paneId = 'pane-1', extra: Partial<Entry> = {}): Entry =>
    ({ kind, paneId, paneName: paneId, panelId: `${paneId}-panel`, agentType: 'claude', source: 'agent', ...extra });

  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pane-inbox-'));
    filePath = path.join(directory, 'session-inbox.json');
    journal = new WorkspaceJournal();
  });
  afterEach(() => fs.rmSync(directory, { recursive: true, force: true }));

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

  it('ignores replayed entries and caps each Session', () => {
    const inbox = open();
    journal.append(entry('agent.report.missing', 'pane-1', { replay: true }));
    expect(inbox.list('session-a')).toEqual([]);

    for (let index = 0; index <= MAX_INBOX_ITEMS_PER_SESSION; index += 1) {
      journal.append(entry('agent.report.missing', 'pane-1', { panelId: `panel-${index}` }));
    }
    const items = inbox.list('session-a');
    expect(items).toHaveLength(MAX_INBOX_ITEMS_PER_SESSION);
    expect(items[0].panelId).toBe('panel-1');
  });
});
