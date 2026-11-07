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
