import Database from 'better-sqlite3-multiple-ciphers';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { NotifyItem } from '../../../../shared/types/notify';
import type { RunpaneInboxItem } from '../../../../shared/types/runpaneOrchestration';
import { APPROVAL_RETENTION_MS, ApprovalStore } from './approvalStore';

const item = (over: Partial<NotifyItem> = {}): NotifyItem => ({
  id: 'a1', ui: 'ask', title: 'Q-7: ship it?', state: 'waiting', createdAt: 1_000,
  source: { name: 'pane', agent: 'Claude', paneId: 'p1', panelId: 't1', session: { id: 's1', name: 'Sales', paneId: 'sp', orchestrator: true } },
  ...over,
});

const report = (over: Partial<RunpaneInboxItem> = {}): RunpaneInboxItem => ({
  id: 'in-1', sessionId: 's1', kind: 'report', at: '2026-11-04T10:00:00.000Z', paneId: 'p1', paneName: 'worker', panelId: 't1',
  report: { state: 'done', reportedAt: '2026-11-04T10:00:00.000Z' },
  ...over,
});

describe('ApprovalStore', () => {
  let db: Database.Database;
  let store: ApprovalStore;
  beforeEach(() => {
    db = new Database(':memory:');
    store = new ApprovalStore(db, 'mini');
  });
  afterEach(() => db.close());

  it('keeps a card with its origin and connected Session across a reopen of the store', () => {
    store.saveItem(item());
    const [saved] = new ApprovalStore(db, 'mini').openItems();
    expect(saved.title).toBe('Q-7: ship it?');
    expect(saved.originKind).toBe('orchestrator');
    expect(saved.connected).toEqual({ kind: 'session', id: 's1', name: 'Sales', paneId: 'sp' });
  });

  it('links an item outside a Session to its Pane, Autopilot or the machine, never to nothing', () => {
    store.saveItem(item({ id: 'pane', source: { name: 'wt', agent: 'Codex', paneId: 'p2' } }));
    store.saveItem(item({ id: 'auto', source: { name: 'Autopilot', agent: 'Claude', autopilot: true } }));
    store.saveItem(item({ id: 'outside', source: { name: 'folder', agent: 'Agent' } }));
    const byId = new Map(store.openItems().map(saved => [saved.id, saved.connected]));
    expect(byId.get('pane')).toEqual({ kind: 'pane', id: 'p2', name: 'wt' });
    expect(byId.get('auto')).toEqual({ kind: 'autopilot', id: 'autopilot', name: 'Autopilot' });
    expect(byId.get('outside')).toEqual({ kind: 'machine', id: 'mini', name: 'folder' });
  });

  it('refuses a row with an empty connected link', () => {
    expect(() => store.saveItem(item({ connected: { kind: 'machine', id: '', name: '' } }))).toThrow(/CHECK/);
    expect(store.count()).toBe(0);
  });

  it('lets only the first answer or close through', () => {
    store.saveItem(item());
    const answered = item({ state: 'answered', resolvedAt: 2_000, answeredBy: { by: 'autopilot', because: 'D-1' } });
    expect(store.claim(answered)).toBe(true);
    expect(store.claim(item({ state: 'expired', resolvedAt: 2_001, closed: { by: 'you', reason: '', at: 2_001 } }))).toBe(false);
    expect(store.readItem('a1')?.answeredBy?.by).toBe('autopilot');
    expect(store.readItem('a1')?.closed).toBeUndefined();
  });

  it('shares one row between a worker question and its inbox report', () => {
    const blocked = report({ report: { state: 'blocked', question: 'Q-39: run it?', reportedAt: '2026-11-04T10:00:00.000Z' } });
    store.saveInboxItem(blocked, 'Sales');
    store.saveItem(item({ id: 'in-1', originKind: 'worker', title: 'Q-39: run it?', connected: { kind: 'session', id: 's1', name: 'Sales', paneId: 'sp' } }));
    expect(store.count()).toBe(1);
    expect(store.unackedInboxItems().map(saved => saved.id)).toEqual(['in-1']);
    expect(store.openItems().map(saved => saved.id)).toEqual(['in-1']);
    store.ackInboxItem('in-1', 5_000);
    expect(store.unackedInboxItems()).toEqual([]);
    expect(store.openItems().map(saved => saved.id)).toEqual(['in-1']);
  });

  it('lists an answered worker question until its D-n is recorded', () => {
    store.saveItem(item({ id: 'w', originKind: 'worker', state: 'answered', resolvedAt: 2_000 }));
    expect(store.unrecordedAnswers('s1').map(saved => saved.id)).toEqual(['w']);
    expect(store.recordDecision('w', 'D-147')).toBe(true);
    expect(store.unrecordedAnswers('s1')).toEqual([]);
    expect(store.readItem('w')?.decision).toBe('D-147');
  });

  it('keeps an answered item for 7 days and then drops it', () => {
    const answeredAt = 10 * 24 * 60 * 60_000;
    store.saveItem(item({ state: 'answered', resolvedAt: answeredAt }));
    expect(store.prune(answeredAt + 6 * 24 * 60 * 60_000)).toBe(0);
    expect(store.answeredRecord('s1').map(saved => saved.id)).toEqual(['a1']);
    expect(store.prune(answeredAt + APPROVAL_RETENTION_MS + 1)).toBe(1);
    expect(store.answeredRecord('s1')).toEqual([]);
  });

  it('stays inside the budget at 5,000 rows', () => {
    const insert = db.transaction(() => {
      for (let index = 0; index < 5_000; index += 1) {
        store.saveItem(item({ id: `row-${index}`, state: index % 25 === 0 ? 'waiting' : 'answered', resolvedAt: 2_000, createdAt: index }));
      }
    });
    insert();
    let start = performance.now();
    expect(store.openItems().length).toBe(200);
    expect(performance.now() - start).toBeLessThan(50);
    start = performance.now();
    store.saveItem(item({ id: 'row-0', state: 'answered', resolvedAt: 3_000 }));
    expect(performance.now() - start).toBeLessThan(5);
  });
});

// T-51 PR 5: the owning machine's install id (AppConfig.machineId) beside the hostname-style `machine`, which drifts.
describe('ApprovalStore install id', () => {
  let db: Database.Database;
  beforeEach(() => { db = new Database(':memory:'); });
  afterEach(() => db.close());

  const columns = () => (db.prepare('PRAGMA table_info(approvals)').all() as Array<{ name: string; notnull: number; dflt_value: unknown }>);
  const rowOf = (id: string) => db.prepare('SELECT machine, install_id, todo_id FROM approvals WHERE id = ?').get(id);
  // The approvals table as the first build with it made it: no todo_id, no install_id.
  const createOldestTable = () => db.prepare(`CREATE TABLE approvals (
    id TEXT PRIMARY KEY, machine TEXT NOT NULL,
    connected_kind TEXT NOT NULL CHECK (connected_kind IN ('session', 'pane', 'autopilot', 'machine')),
    connected_id TEXT NOT NULL CHECK (length(connected_id) > 0), connected_name TEXT NOT NULL,
    origin_kind TEXT NOT NULL CHECK (origin_kind IN ('orchestrator', 'worker', 'autopilot', 'claude-prompt', 'pane', 'agent')),
    session_id TEXT, pane_id TEXT, panel_id TEXT, addressee TEXT NOT NULL CHECK (addressee IN ('person', 'orchestrator')),
    qn TEXT, state TEXT NOT NULL, item_json TEXT, report_json TEXT, inbox_session_id TEXT, acked_at INTEGER, answered_by TEXT,
    closed_by TEXT, closed_reason TEXT, stale_since INTEGER, rewritten_from TEXT, rewritten_as TEXT, delivered_via TEXT,
    delivered_at INTEGER, decision TEXT, created_at INTEGER NOT NULL, ended_at INTEGER)`).run();
  // What an older Pane (with todo_id, before install_id) runs to save a card.
  const olderSave = (id: string, todoId: number | null) => db.prepare(`
    INSERT INTO approvals (id, machine, connected_kind, connected_id, connected_name, origin_kind, addressee, state, item_json, created_at, todo_id)
    VALUES (@id, 'Tylers-MacBook-Pro', 'session', 's1', 'Sales', 'orchestrator', 'person', 'waiting', @item_json, 1000, @todo_id)
    ON CONFLICT(id) DO UPDATE SET machine = excluded.machine, state = excluded.state, item_json = excluded.item_json, todo_id = COALESCE(excluded.todo_id, approvals.todo_id)`)
    .run({ id, todo_id: todoId, item_json: JSON.stringify(item({ id })) });

  it('stores this machine\'s install id beside its name on a card and on an inbox report', () => {
    const store = new ApprovalStore(db, 'mini', 'install-mini');
    store.saveItem(item({ todo: { number: 28, title: 'BAA' } }));
    store.saveInboxItem(report(), 'Sales');
    expect(rowOf('a1')).toEqual({ machine: 'mini', install_id: 'install-mini', todo_id: 28 });
    expect(rowOf('in-1')).toEqual({ machine: 'mini', install_id: 'install-mini', todo_id: null });
  });

  it('leaves it empty when this machine has no install id yet', () => {
    new ApprovalStore(db, 'mini').saveItem(item());
    expect(rowOf('a1')).toEqual({ machine: 'mini', install_id: null, todo_id: null });
  });

  it('upgrades an older table: adds an optional column, rewrites no todo_id and fills no install id in', () => {
    createOldestTable();
    db.prepare('ALTER TABLE approvals ADD COLUMN todo_id INTEGER').run();
    olderSave('q-84', 28);
    olderSave('q-85', null);
    new ApprovalStore(db, 'mini', 'install-mini');
    const added = columns().find(column => column.name === 'install_id');
    expect(added).toMatchObject({ notnull: 0, dflt_value: null });
    expect(rowOf('q-84')).toEqual({ machine: 'Tylers-MacBook-Pro', install_id: null, todo_id: 28 });
    expect(rowOf('q-85')).toEqual({ machine: 'Tylers-MacBook-Pro', install_id: null, todo_id: null });
    // Twice is the same as once.
    new ApprovalStore(db, 'mini', 'install-mini');
    expect(columns().filter(column => column.name === 'install_id')).toHaveLength(1);
  });

  it('upgrades the oldest table too, adding todo_id and install_id', () => {
    createOldestTable();
    new ApprovalStore(db, 'mini', 'install-mini');
    expect(columns().map(column => column.name)).toEqual(expect.arrayContaining(['todo_id', 'install_id']));
  });

  it('an older Pane on the upgraded table still saves and reads, and keeps the install id it does not know', () => {
    const store = new ApprovalStore(db, 'mini', 'install-mini');
    store.saveItem(item({ todo: { number: 28, title: 'BAA' } }));
    olderSave('a1', null);
    olderSave('older', 5);
    expect(rowOf('a1')).toEqual({ machine: 'Tylers-MacBook-Pro', install_id: 'install-mini', todo_id: 28 });
    expect(rowOf('older')).toEqual({ machine: 'Tylers-MacBook-Pro', install_id: null, todo_id: 5 });
    expect(new ApprovalStore(db, 'mini', 'install-mini').openItems().map(saved => saved.id)).toEqual(['a1', 'older']);
  });
});
