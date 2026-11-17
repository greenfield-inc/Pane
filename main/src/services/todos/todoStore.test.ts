import Database from 'better-sqlite3-multiple-ciphers';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ApprovalStore } from '../approvals/approvalStore';
import { ensureApprovalsSchema } from '../../database/approvalsSchema';
import { ensureTodosSchema } from '../../database/todosSchema';
import { TODO_RETENTION_MS, TodoStore } from './todoStore';

const person = { kind: 'person' as const, name: 'you' };

describe('TodoStore', () => {
  let db: Database.Database;
  let store: TodoStore;
  beforeEach(() => {
    db = new Database(':memory:');
    store = new TodoStore(db);
  });
  afterEach(() => db.close());

  it('numbers to-dos T-1, T-2 … and never hands a number out twice, even after a closed one is deleted', () => {
    const first = store.create({ title: 'One', requester: person, createdBy: 'you', now: 1 });
    const second = store.create({ title: 'Two', requester: person, createdBy: 'you', now: 2 });
    expect([first.ref, second.ref]).toEqual(['T-1', 'T-2']);
    store.update(second.number, { state: 'done', closedAt: 3 }, 3);
    expect(store.pruneClosed(3 + TODO_RETENTION_MS + 1)).toBe(1);
    expect(store.create({ title: 'Three', requester: person, createdBy: 'you', now: 4 }).ref).toBe('T-3');
  });

  it('keeps a to-do, its done-when list, requester and assignee as written', () => {
    const created = store.create({
      title: 'Invoice PDFs', summary: '**Bold**', doneWhen: [{ text: 'PDF renders', met: false }], sessionId: 's1',
      requester: { kind: 'orchestrator', sessionId: 'sA', panelId: 'tA', name: 'Billing orchestrator' }, projectId: 4, agent: 'claude', createdBy: 'Billing orchestrator', now: 10,
    });
    const updated = store.update(created.number, { state: 'in_progress', startedAt: 11, assignee: { panelId: 'w1', paneId: 'p1', name: 'implementer' }, doneWhen: [{ text: 'PDF renders', met: true }] }, 11);
    expect(updated).toMatchObject({
      title: 'Invoice PDFs', summary: '**Bold**', state: 'in_progress', sessionId: 's1', projectId: 4, agent: 'claude', startedAt: 11, updatedAt: 11,
      requester: { kind: 'orchestrator', sessionId: 'sA', panelId: 'tA', name: 'Billing orchestrator' },
      assignee: { panelId: 'w1', paneId: 'p1', name: 'implementer' }, doneWhen: [{ text: 'PDF renders', met: true }],
    });
  });

  it('nests sub-to-dos under their parent and in its Session; only the parent owns the Session', () => {
    const parent = store.create({ title: 'Parent', sessionId: 's1', requester: person, createdBy: 'you', now: 1 });
    const child = store.create({ title: 'Child', sessionId: 's1', parentNumber: parent.number, requester: person, createdBy: 'orchestrator', now: 2 });
    expect(store.children(parent.number).map(todo => todo.number)).toEqual([child.number]);
    expect(store.ownerOfSession('s1')?.number).toBe(parent.number);
    expect(store.ownSessionIds()).toEqual(['s1']);
  });

  it('detaches an attachment without losing its record', () => {
    const todo = store.create({ title: 'T', requester: person, createdBy: 'you', now: 1 });
    const added = store.attach({ todoNumber: todo.number, kind: 'plan', target: '/tmp/plan.html', machine: 'mini', label: 'Plan', addedBy: 'planner', source: 'attached', now: 2 });
    expect(store.attachments(todo.number)).toHaveLength(1);
    expect(store.detach(added.id, 3)).toBe(true);
    expect(store.attachments(todo.number)).toEqual([]);
    expect(store.attachment(added.id)).toMatchObject({ target: '/tmp/plan.html', removedAt: 3 });
  });

  it('reads waiting approvals linked to a to-do, and forgets the link when the to-do is pruned', () => {
    const approvals = new ApprovalStore(db, 'mini');
    approvals.saveItem({ id: 'a1', ui: 'ask', title: 'Q-11: Merge #1352?', state: 'waiting', createdAt: 5, source: { name: 'w', agent: 'Claude', paneId: 'p', panelId: 't' } });
    const todo = store.create({ title: 'T', requester: person, createdBy: 'you', now: 1 });
    store.linkApproval('a1', todo.number);
    expect(store.waitingApprovals()).toEqual([{ id: 'a1', todoNumber: todo.number, title: 'Q-11: Merge #1352?', qn: 'Q-11', createdAt: 5 }]);
    store.update(todo.number, { state: 'dropped', closedAt: 6 }, 6);
    store.pruneClosed(6 + TODO_RETENTION_MS + 1);
    expect(store.todoOfApproval('a1')).toBeUndefined();
    expect(approvals.readItem('a1')?.title).toBe('Q-11: Merge #1352?');
  });

  it('marks a message delivered once', () => {
    const todo = store.create({ title: 'T', requester: person, createdBy: 'you', now: 1 });
    const message = store.addActivity({ todoNumber: todo.number, kind: 'message', authorKind: 'person', authorName: 'you', body: 'hi', toTab: 't1', toName: 'orchestrator', now: 2 });
    expect(store.undelivered().map(row => row.id)).toEqual([message.id]);
    store.markDelivered(message.id, 3);
    store.markDelivered(message.id, 9);
    expect(store.activityItem(message.id)?.deliveredAt).toBe(3);
    expect(store.undelivered()).toEqual([]);
  });
});

describe('to-dos migration', () => {
  it('adds the tables and approvals.todo_id to an existing database, keeping its approvals, and runs twice safely', () => {
    const db = new Database(':memory:');
    // A database from before to-dos: the approvals table without todo_id, holding a question.
    db.prepare(`CREATE TABLE approvals (id TEXT PRIMARY KEY, machine TEXT NOT NULL, connected_kind TEXT NOT NULL, connected_id TEXT NOT NULL, connected_name TEXT NOT NULL,
      origin_kind TEXT NOT NULL, session_id TEXT, pane_id TEXT, panel_id TEXT, addressee TEXT NOT NULL, qn TEXT, state TEXT NOT NULL, item_json TEXT, report_json TEXT,
      inbox_session_id TEXT, acked_at INTEGER, answered_by TEXT, closed_by TEXT, closed_reason TEXT, stale_since INTEGER, rewritten_from TEXT, rewritten_as TEXT,
      delivered_via TEXT, delivered_at INTEGER, decision TEXT, created_at INTEGER NOT NULL, ended_at INTEGER)`).run();
    db.prepare(`INSERT INTO approvals (id, machine, connected_kind, connected_id, connected_name, origin_kind, addressee, state, item_json, created_at)
      VALUES ('old', 'mini', 'machine', 'mini', 'mini', 'agent', 'person', 'waiting', ?, 1)`).run(JSON.stringify({ id: 'old', ui: 'ask', title: 'Older question', state: 'waiting', createdAt: 1, source: { name: 'w', agent: 'Claude' } }));
    for (let run = 0; run < 2; run += 1) {
      ensureApprovalsSchema(db);
      ensureTodosSchema(db);
    }
    const approvals = new ApprovalStore(db, 'mini');
    // SAFETY: PRAGMA table_info rows always carry a name.
    const columns = db.prepare('PRAGMA table_info(approvals)').all().map(column => (column as { name: string }).name);
    expect(columns).toContain('todo_id');
    // SAFETY: sqlite_master rows always carry a name.
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map(row => (row as { name: string }).name);
    expect(tables).toEqual(expect.arrayContaining(['todos', 'todo_attachments', 'todo_activity']));
    // An older Pane writes approvals with its own column list: the new column must not get in its way.
    approvals.saveItem({ id: 'new', ui: 'ask', title: 'After upgrade', state: 'waiting', createdAt: 2, source: { name: 'w', agent: 'Claude' } });
    expect(approvals.openItems().map(item => item.id)).toEqual(['old', 'new']);
    db.close();
  });
});
