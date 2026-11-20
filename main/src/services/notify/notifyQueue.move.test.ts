import Database from 'better-sqlite3-multiple-ciphers';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_NOTIFY_SETTINGS, type NotifyQuestion, type NotifyResult, type NotifySource } from '../../../../shared/types/notify';
import { ApprovalStore } from '../approvals/approvalStore';
import { NotifyQueue } from './notifyQueue';

/** A Session's approvals moving between two machines, each with its own queue and table (T-44). */

const session = { id: 's1', name: 'Sales', paneId: 'sp', orchestrator: true };
const orchestrator: NotifySource = { name: 'Session: Sales', agent: 'Claude', paneId: 'sp', panelId: 'orch', session };
const ask = (title: string): NotifyQuestion => ({ ui: 'ask', title });

describe('NotifyQueue moving a Session\'s approvals', () => {
  const dbs: Database.Database[] = [];
  const typed: Array<[string, string, string]> = [];

  /** One machine: its own table, and the lines it types into its tabs. */
  function machine(name: string) {
    const db = new Database(':memory:');
    dbs.push(db);
    const store = new ApprovalStore(db, name);
    const queue = new NotifyQueue({
      settings: () => DEFAULT_NOTIFY_SETTINGS, showOutsideSupported: true, shortcutRegistered: () => true, instructionFiles: () => [],
      machine: name, store, askerGone: () => undefined, inUse: () => true,
      typeIntoTab: async (panelId, text) => { typed.push([name, panelId, text]); return 'delivered'; },
    });
    return { store, queue, item: (id: string) => queue.snapshot().items.find(candidate => candidate.id === id) };
  }

  beforeEach(() => {
    vi.useFakeTimers();
    typed.length = 0;
  });
  afterEach(() => {
    for (const db of dbs.splice(0)) db.close();
    vi.useRealTimers();
  });

  it('a held card outlives its tab stopping, moves, and its answer on the other machine reaches the moved tab', async () => {
    const a = machine('mini');
    const b = machine('studio');
    const controller = new AbortController();
    let result: NotifyResult | undefined;
    void a.queue.ask({ question: ask('Q-5: ship?'), source: orchestrator }, controller.signal).then(value => { result = value; });
    const [{ id }] = a.queue.snapshot().items;

    expect(a.queue.holdForMove([id])).toEqual([id]);
    // The move stops the tab: its call ends and the tab is paused. Neither ends a held card.
    controller.abort();
    a.queue.withdrawForPanels(['orch']);
    expect(a.item(id)?.state).toBe('waiting');

    const taken = a.queue.takeForMove([id], 'studio');
    expect(taken.stayed).toEqual([]);
    expect(taken.carried.map(card => card.id)).toEqual([id]);
    // Nothing left on the source: no card in Approvals, and its row says where it went.
    expect(a.queue.snapshot().queue).toEqual([]);
    expect(a.item(id)).toBeUndefined();
    expect(a.store.readItem(id)).toMatchObject({ state: 'expired', closed: { by: 'pane', reason: 'it moved with its Session to studio' } });
    expect(a.store.openItems()).toEqual([]);

    b.queue.takeIn(taken.carried);
    expect(b.item(id)).toMatchObject({ state: 'waiting', machine: 'studio', title: 'Q-5: ship?' });
    expect(b.queue.snapshot().queue).toEqual([id]);
    b.queue.run({ type: 'answer', id, answer: { text: 'Yes' } });
    await vi.advanceTimersByTimeAsync(3_000);
    expect(typed).toEqual([['studio', 'orch', 'answer: Q-5 → Yes (by you)']]);
    expect(b.store.readItem(id)).toMatchObject({ state: 'answered', delivered: { via: 'tab' } });
    // The source's call, if any had still been open, was never told the question expired.
    expect(result?.state).not.toBe('expired');
  });

  it('a move that doesn\'t happen puts the card back, waiting, and its answer still reaches the tab', async () => {
    const a = machine('mini');
    void a.queue.ask({ question: ask('Q-6: deploy?'), source: orchestrator });
    const [{ id }] = a.queue.snapshot().items;
    a.queue.holdForMove([id]);
    const taken = a.queue.takeForMove([id], 'studio');
    a.queue.takeIn(taken.carried);
    expect(a.item(id)?.state).toBe('waiting');
    a.queue.run({ type: 'answer', id, answer: { text: 'Now' } });
    await vi.advanceTimersByTimeAsync(3_000);
    expect(typed).toEqual([['mini', 'orch', 'answer: Q-6 → Now (by you)']]);
  });

  it('a card answered mid-move stays on the source with its answer, and never moves (fail safe)', async () => {
    const a = machine('mini');
    void a.queue.ask({ question: ask('Q-7: merge?'), source: orchestrator });
    const [{ id }] = a.queue.snapshot().items;
    a.queue.holdForMove([id]);
    // The person answers while the move stops tabs: the answer is in its Undo hold when the move packs.
    a.queue.run({ type: 'answer', id, answer: { text: 'Merge it' } });
    const taken = a.queue.takeForMove([id], 'studio');
    expect(taken.carried).toEqual([]);
    expect(taken.stayed).toEqual([expect.objectContaining({ id, title: 'Q-7: merge?', answer: 'Merge it' })]);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(a.store.readItem(id)).toMatchObject({ state: 'answered', answeredBy: { by: 'you' } });
  });

  it('releasing a hold lets the tab\'s pause end its card as before', () => {
    const a = machine('mini');
    void a.queue.ask({ question: ask('Q-8: retry?'), source: orchestrator });
    const [{ id }] = a.queue.snapshot().items;
    a.queue.holdForMove([id]);
    a.queue.releaseMoveHold([id]);
    a.queue.withdrawForPanels(['orch']);
    expect(a.store.readItem(id)?.state).toBe('expired');
  });

  it('takes in a card once: a second arrival of the same card changes nothing', () => {
    const a = machine('mini');
    const b = machine('studio');
    void a.queue.ask({ question: ask('Q-9: go?'), source: orchestrator });
    const [{ id }] = a.queue.snapshot().items;
    a.queue.holdForMove([id]);
    const { carried } = a.queue.takeForMove([id], 'studio');
    b.queue.takeIn(carried);
    b.queue.takeIn(carried);
    expect(b.queue.snapshot().queue).toEqual([id]);
  });
});

