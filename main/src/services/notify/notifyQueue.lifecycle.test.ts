import Database from 'better-sqlite3-multiple-ciphers';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_NOTIFY_SETTINGS, type NotifyCardsOnStatus, type NotifyItem, type NotifyQuestion, type NotifyResult, type NotifySource } from '../../../../shared/types/notify';
import { ApprovalStore } from '../approvals/approvalStore';
import { cardsOnStatus, NotifyQueue, type NotifyQueueEnvironment } from './notifyQueue';
import type { MachineState } from '../../../../shared/types/machineConnections';

const DAY = 24 * 60 * 60_000;
const session = { id: 's1', name: 'Sales', paneId: 'sp', orchestrator: true };
const orchestrator: NotifySource = { name: 'Session: Sales', agent: 'Claude', paneId: 'sp', panelId: 'orch', session };
const worker: NotifySource = { name: 'workos-sso', agent: 'Claude', paneId: 'wp', panelId: 'w1', session: { id: 's1', name: 'Sales', paneId: 'sp' } };
const ask = (title: string): NotifyQuestion => ({ ui: 'ask', title });

describe('NotifyQueue with its store', () => {
  let db: Database.Database;
  let store: ApprovalStore;
  let typed: Array<[string, string]>;
  let gone: Map<string, string>;
  let tabState: 'delivered' | 'busy' | 'gone' | 'unsupported' | 'outdated';
  let using: boolean;

  const queueWith = (extra: Partial<NotifyQueueEnvironment> = {}) => new NotifyQueue({
    // The floating strip is off by default; these tests are about it.
    settings: () => ({ ...DEFAULT_NOTIFY_SETTINGS, showOutsidePane: true }),
    showOutsideSupported: true,
    shortcutRegistered: () => true,
    instructionFiles: () => [],
    machine: 'mini',
    store,
    askerGone: (item: NotifyItem) => gone.get(item.source.panelId ?? ''),
    inUse: () => using,
    typeIntoTab: async (panelId, text) => {
      if (tabState === 'delivered') typed.push([panelId, text]);
      return tabState;
    },
    ...extra,
  });
  const item = (queue: NotifyQueue, id: string) => queue.snapshot().items.find(candidate => candidate.id === id);

  beforeEach(() => {
    vi.useFakeTimers();
    db = new Database(':memory:');
    store = new ApprovalStore(db, 'mini');
    typed = [];
    gone = new Map();
    tabState = 'delivered';
    using = true;
  });
  afterEach(() => {
    db.close();
    vi.useRealTimers();
  });

  it('a card Pane withdraws stops waiting, says why, and stays closed after a restart', async () => {
    const queue = queueWith();
    const result = queue.ask({ question: { ui: 'options', title: 'Disk almost full', choices: [{ label: 'Not now' }] }, source: { name: 'Pane', agent: 'Pane' }, id: 'disk-1' });
    queue.withdraw('disk-1', 'free disk is back above the warning line');
    await expect(result).resolves.toMatchObject({ unavailable: 'free disk is back above the warning line' });
    const closed = { state: 'expired', closed: { by: 'pane', reason: 'free disk is back above the warning line' } };
    expect(item(queue, 'disk-1')).toMatchObject(closed);
    expect(queue.snapshot().queue).toEqual([]);
    queue.dispose();
    expect(item(queueWith(), 'disk-1')).toMatchObject(closed);
  });

  it('a card whose asker has no tab, such as a removed profile run, ends at the next start instead of waiting', () => {
    const before = queueWith();
    void before.ask({ question: { ui: 'options', title: 'Ship it?', choices: [{ label: 'Yes' }, { label: 'No' }], optionsOnly: true }, source: { name: 'greenfield run', agent: 'Pane profile', paneId: 'p1' }, id: 'run-card' });
    expect(item(before, 'run-card')).toMatchObject({ state: 'waiting' });

    const after = queueWith();
    expect(item(after, 'run-card')).toMatchObject({ state: 'expired', closed: { by: 'pane', reason: 'the asker stopped waiting' } });
    expect(after.snapshot().queue).toEqual([]);
    expect(store.readItem('run-card')?.state).toBe('expired');
  });

  it('J6: an item outlives a restart, and its answer goes to the tab once', async () => {
    const before = queueWith();
    void before.ask({ question: ask('Q-5: ship?'), source: orchestrator });
    const [{ id }] = before.snapshot().items;
    before.dispose();

    const after = queueWith();
    expect(item(after, id)).toMatchObject({ state: 'waiting', originKind: 'orchestrator', connected: { kind: 'session', id: 's1' } });
    expect(after.snapshot().queue).toEqual([id]);
    after.run({ type: 'answer', id, answer: { text: 'Yes' } });
    await vi.advanceTimersByTimeAsync(3_000);
    expect(typed).toEqual([['orch', 'answer: Q-5 → Yes (by you)']]);
    expect(item(after, id)).toMatchObject({ state: 'answered', delivered: { via: 'tab' }, answeredBy: { by: 'you' } });
    after.sweep();
    await vi.advanceTimersByTimeAsync(1);
    expect(typed).toHaveLength(1);
  });

  it('holds an answer for a busy tab, then types it when the tab is at its prompt', async () => {
    const queue = queueWith();
    queue.addWorkerQuestion({ id: 'in-1', question: 'Q-39: run the script?', source: worker, at: Date.now() });
    tabState = 'busy';
    queue.run({ type: 'answer', id: 'in-1', answer: { text: 'Go' } });
    await vi.advanceTimersByTimeAsync(3_000);
    expect(typed).toEqual([]);
    expect(item(queue, 'in-1')?.delivered).toBeUndefined();
    tabState = 'delivered';
    queue.flushTabMessages();
    await vi.advanceTimersByTimeAsync(1);
    expect(typed).toEqual([['w1', 'answer: Q-39 → Go (by you)']]);
    expect(item(queue, 'in-1')?.delivered?.via).toBe('tab');
  });

  it('ends an answer that can never be typed, says why, and does not try again after a restart', async () => {
    const queue = queueWith();
    queue.addWorkerQuestion({ id: 'in-1', question: 'Q-7: which region?', source: worker, at: Date.now() });
    tabState = 'gone';
    queue.run({ type: 'answer', id: 'in-1', answer: { text: 'eu-west' } });
    await vi.advanceTimersByTimeAsync(3_000);
    expect(item(queue, 'in-1')?.delivered).toBeUndefined();
    expect(item(queue, 'in-1')?.undelivered?.reason).toBe('its tab closed');
    queue.dispose();

    let tries = 0;
    const after = queueWith({ typeIntoTab: async () => { tries += 1; return 'delivered'; } });
    after.sweep();
    await vi.advanceTimersByTimeAsync(10);
    expect(tries).toBe(0);
    after.dispose();
  });

  it("says when Pane can't see what runs in the asking tab", async () => {
    const queue = queueWith();
    queue.addWorkerQuestion({ id: 'in-1', question: 'Q-8: retry?', source: worker, at: Date.now() });
    tabState = 'unsupported';
    queue.run({ type: 'answer', id: 'in-1', answer: { text: 'Yes' } });
    await vi.advanceTimersByTimeAsync(3_000);
    expect(typed).toEqual([]);
    expect(item(queue, 'in-1')?.undelivered?.reason).toBe("Pane can't see what runs in its tab");
    queue.dispose();
  });

  it("says to update Pane on the asking tab's machine when that Pane is too old to type into it", async () => {
    const queue = queueWith();
    queue.addWorkerQuestion({ id: 'in-1', question: 'Q-8: retry?', source: worker, at: Date.now() });
    tabState = 'outdated';
    queue.run({ type: 'answer', id: 'in-1', answer: { text: 'Yes' } });
    await vi.advanceTimersByTimeAsync(3_000);
    expect(typed).toEqual([]);
    expect(item(queue, 'in-1')?.undelivered?.reason).toBe('the Pane on its machine is too old to type into its tab; update Pane there');
    queue.dispose();
  });

  it('does not spin on a tab that stays busy: two messages owed wait for its next idle', async () => {
    const queue = queueWith();
    queue.addWorkerQuestion({ id: 'in-1', question: 'Q-1: a?', source: worker, at: Date.now() });
    queue.addWorkerQuestion({ id: 'in-2', question: 'Q-2: b?', source: worker, at: Date.now() });
    let tries = 0;
    const busy = queueWith({ typeIntoTab: async () => { tries += 1; return 'busy'; } });
    busy.agentAct({ type: 'agent-answer', id: 'in-1', answer: { text: 'x' }, because: 'D-1' });
    busy.agentAct({ type: 'agent-answer', id: 'in-2', answer: { text: 'y' }, because: 'D-2' });
    await vi.advanceTimersByTimeAsync(10);
    expect(tries).toBeLessThanOrEqual(2);
    queue.dispose();
    busy.dispose();
  });

  it('delivers everything owed to one tab in order once it takes them', async () => {
    const queue = queueWith();
    queue.addWorkerQuestion({ id: 'in-1', question: 'Q-1: a?', source: worker, at: Date.now() });
    queue.addWorkerQuestion({ id: 'in-2', question: 'Q-2: b?', source: worker, at: Date.now() });
    queue.agentAct({ type: 'agent-answer', id: 'in-1', answer: { text: 'x' }, because: 'D-1' });
    queue.agentAct({ type: 'agent-close', id: 'in-2', reason: 'done' });
    await vi.advanceTimersByTimeAsync(10);
    expect(typed.map(([, text]) => text)).toEqual(['answer: Q-1 → x (by Autopilot)', 'closed: Q-2 (by Autopilot): done']);
  });

  it('J6: Pane stopping its server does not close what is waiting', async () => {
    const before = queueWith();
    const controller = new AbortController();
    void before.ask({ question: ask('Q-5: ship?'), source: orchestrator }, controller.signal);
    const [{ id }] = before.snapshot().items;
    before.prepareForQuit();
    controller.abort();
    before.dispose();
    expect(store.readItem(id)?.state).toBe('waiting');
    expect(queueWith().snapshot().queue).toEqual([id]);
  });

  it('clears the inbox item of a worker question closed because its asker is gone', () => {
    const gonePanels: string[] = [];
    const queue = queueWith({ workerQuestionGone: id => gonePanels.push(id) });
    queue.addWorkerQuestion({ id: 'in-1', question: 'Q-1: a?', source: worker, at: Date.now() });
    gone.set('w1', 'the asking tab was closed');
    queue.sweep();
    expect(gonePanels).toEqual(['in-1']);
  });

  it('types an answer as one line, whatever it holds', async () => {
    const queue = queueWith();
    queue.addWorkerQuestion({ id: 'in-1', question: 'Q-1: a?', source: worker, at: Date.now() });
    queue.agentAct({ type: 'agent-answer', id: 'in-1', answer: { text: 'yes\nrm -rf\u0003x' }, because: 'D-1' });
    await vi.advanceTimersByTimeAsync(1);
    expect(typed[0][1]).toBe('answer: Q-1 → yes rm -rf x (by Autopilot)');
  });

  it('J7: a worker question is answerable at once, and rings after the grace, not before', async () => {
    const queue = queueWith();
    const chimes = vi.fn();
    queue.on('chime', chimes);
    queue.addWorkerQuestion({ id: 'in-1', question: 'Q-39: run?', source: worker, at: Date.now() });
    const first = queue.snapshot();
    // Quiet until it rings: answerable in Approvals, not in the round (F-6).
    expect(first.queue).toEqual([]);
    expect(first.hidden).toEqual(['in-1']);
    expect(first.strip).toBeNull();
    expect(item(queue, 'in-1')).toMatchObject({ ui: 'ask', originKind: 'worker', quiet: true });
    expect(chimes).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(chimes).toHaveBeenCalledTimes(1);
    expect(queue.snapshot().strip).toEqual({ kind: 'question', itemId: 'in-1' });
  });

  it('J8: a relay improves the same card and its call waits; the answer reaches the worker and the orchestrator', async () => {
    const queue = queueWith();
    queue.addWorkerQuestion({ id: 'in-1', question: 'Q-39: run?', source: worker, at: Date.now() });
    const relayed = queue.ask({ relays: 'in-1', question: { ui: 'options', title: 'Q-39: run the script?', choices: [{ label: 'Run', recommended: true }, { label: 'Stop' }] }, source: orchestrator });
    expect(queue.snapshot().items).toHaveLength(1);
    expect(item(queue, 'in-1')).toMatchObject({ ui: 'options', quiet: undefined, source: { name: 'workos-sso' } });
    queue.run({ type: 'answer', id: 'in-1', answer: { choice: 'Run' } });
    await vi.advanceTimersByTimeAsync(3_000);
    expect(await relayed).toEqual({ answer: 'Run' });
    expect(typed).toEqual([['w1', 'answer: Q-39 → Run (by you)']]);
    expect(queue.recordDecision('in-1', 'D-147')).toBe(true);
    expect(item(queue, 'in-1')?.decision).toBe('D-147');
  });

  it("a relay call that ends lets go of the worker's card, which keeps waiting and still answers the worker", async () => {
    const queue = queueWith();
    queue.addWorkerQuestion({ id: 'in-1', question: 'Q-39: run?', source: worker, at: Date.now() });
    const controller = new AbortController();
    void queue.ask({ relays: 'in-1', question: { ui: 'options', title: 'Q-39: run the script?', choices: [{ label: 'Run', recommended: true }, { label: 'Stop' }] }, source: orchestrator }, controller.signal);
    controller.abort();
    expect(item(queue, 'in-1')).toMatchObject({ state: 'waiting', title: 'Q-39: run the script?' });
    queue.run({ type: 'answer', id: 'in-1', answer: { choice: 'Run' } });
    await vi.advanceTimersByTimeAsync(3_000);
    expect(typed).toEqual([['w1', 'answer: Q-39 → Run (by you)']]);
  });

  it('a relay of a worker question asked over 15 minutes ago still waits its full round before returning', async () => {
    const queue = queueWith();
    queue.addWorkerQuestion({ id: 'in-1', question: 'Q-39: run?', source: worker, at: Date.now() - 20 * 60_000 });
    let result: unknown;
    void queue.ask({ relays: 'in-1', returnAfterMs: 50_000, question: { ui: 'options', title: 'Q-39: run the script?', choices: [{ label: 'Run', recommended: true }, { label: 'Stop' }] }, source: orchestrator }).then((value) => { result = value; });
    await vi.advanceTimersByTimeAsync(49_000);
    expect(result).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(result).toMatchObject({ waiting: true, id: 'in-1' });
    expect(item(queue, 'in-1')).toMatchObject({ state: 'waiting' });
  });

  it('a relay of an item already ended returns unavailable and posts nothing', async () => {
    const queue = queueWith();
    const result = await queue.ask({ relays: 'nope', question: ask('Q-1: x?'), source: orchestrator });
    expect(result).toMatchObject({ unavailable: expect.stringContaining('no waiting worker question') });
    expect(queue.snapshot().items).toEqual([]);
  });

  it('J18: a call that ends closes its item with the reason', async () => {
    const queue = queueWith();
    const controller = new AbortController();
    void queue.ask({ question: ask('Q-2: x?'), source: orchestrator }, controller.signal);
    const [{ id }] = queue.snapshot().items;
    controller.abort();
    expect(item(queue, id)).toMatchObject({ state: 'expired', closed: { by: 'pane', reason: 'the asker stopped waiting' } });
    expect(store.readItem(id)?.closed?.reason).toBe('the asker stopped waiting');
  });

  it('J17: the sweep closes what its asker left, without telling the asker', async () => {
    const queue = queueWith();
    void queue.ask({ question: ask('Q-2: x?'), source: orchestrator });
    const [{ id }] = queue.snapshot().items;
    gone.set('orch', 'Session archived');
    queue.sweep();
    await vi.advanceTimersByTimeAsync(1);
    expect(item(queue, id)).toMatchObject({ state: 'expired', closed: { by: 'pane', reason: 'Session archived' } });
    expect(queue.snapshot().queue).toEqual([]);
    expect(typed).toEqual([]);
  });

  it('leaves a saved item alone when its tab sits idle: only an open call can be abandoned', async () => {
    const queue = queueWith();
    queue.addWorkerQuestion({ id: 'in-1', question: 'Q-39: run?', source: worker, at: Date.now() });
    queue.panelStatus('w1', true);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(item(queue, 'in-1')?.state).toBe('waiting');
  });

  it('does not bring back a worker question already answered and off the list', async () => {
    const before = queueWith();
    before.addWorkerQuestion({ id: 'in-1', question: 'Q-39: run?', source: worker, at: Date.now() });
    before.agentAct({ type: 'agent-answer', id: 'in-1', answer: { text: 'Go' }, because: 'D-1' });
    before.dispose();
    await vi.advanceTimersByTimeAsync(2 * DAY);
    const after = queueWith();
    after.addWorkerQuestion({ id: 'in-1', question: 'Q-39: run?', source: worker, at: Date.now() - 2 * DAY });
    expect(after.snapshot().queue).toEqual([]);
    expect(store.readItem('in-1')?.state).toBe('answered');
  });

  it('J18: a worker that moved on closes its card', () => {
    const queue = queueWith();
    queue.addWorkerQuestion({ id: 'in-1', question: 'Q-39: run?', source: worker, at: Date.now() });
    queue.endWorkerQuestion('in-1', 'the worker moved on');
    expect(item(queue, 'in-1')?.closed?.reason).toBe('the worker moved on');
  });

  it('J19: the same tab asking the same Q-n after a restart joins the card', async () => {
    const before = queueWith();
    void before.ask({ question: ask('Q-5: ship?'), source: orchestrator });
    const [{ id }] = before.snapshot().items;
    before.dispose();
    const after = queueWith();
    const again = after.ask({ question: ask('Q-5: ship it?'), source: orchestrator });
    expect(after.snapshot().items.map(candidate => candidate.id)).toEqual([id]);
    after.run({ type: 'answer', id, answer: { text: 'Yes' } });
    await vi.advanceTimersByTimeAsync(3_000);
    expect(await again).toEqual({ answer: 'Yes' });
    expect(typed).toEqual([]);
    expect(item(after, id)?.delivered?.via).toBe('call');
  });

  it('J23: three days unanswered goes stale: hidden, never rings, still answerable', async () => {
    const queue = queueWith();
    void queue.ask({ question: ask('Q-2: old?'), source: orchestrator });
    const [{ id }] = queue.snapshot().items;
    await vi.advanceTimersByTimeAsync(3 * DAY);
    queue.sweep();
    expect(item(queue, id)?.staleSince).toBeDefined();
    expect(queue.snapshot().hidden).toEqual([id]);
    expect(queue.snapshot().strip).toBeNull();
    // The Answer-all round and its shortcut skip it, as the counts do.
    expect(queue.snapshot().queue).toEqual([]);
    expect(queue.hasWaiting()).toBe(false);
    queue.run({ type: 'answer', id, answer: { text: 'x' } });
    expect(item(queue, id)?.state).toBe('sent');
  });

  it('J24: closing tells an open call, or a tab with no call', async () => {
    const queue = queueWith();
    const call = queue.ask({ question: ask('Q-2: x?'), source: orchestrator });
    const [{ id }] = queue.snapshot().items;
    queue.run({ type: 'close', id });
    expect(await call).toMatchObject({ unavailable: 'The person closed this question.' });
    expect(item(queue, id)?.closed).toMatchObject({ by: 'you' });
    expect(typed).toEqual([]);

    queue.addWorkerQuestion({ id: 'in-1', question: 'Q-39: run?', source: worker, at: Date.now() });
    queue.run({ type: 'close', id: 'in-1' });
    await vi.advanceTimersByTimeAsync(1);
    expect(typed).toEqual([['w1', 'closed: Q-39 (by you)']]);
  });

  it('closes waiting for the same tab reach it as one line, still one line when the reason has a newline', async () => {
    const queue = queueWith();
    tabState = 'busy';
    for (const n of [39, 40, 41]) {
      queue.addWorkerQuestion({ id: `in-${n}`, question: `Q-${n}: run?`, source: worker, at: Date.now() });
      queue.run({ type: 'close', id: `in-${n}`, reason: 'loop run\nreviewed' });
    }
    await vi.advanceTimersByTimeAsync(1);
    tabState = 'delivered';
    queue.flushTabMessages();
    await vi.advanceTimersByTimeAsync(1);
    expect(typed).toEqual([['w1', 'closed: Q-39, Q-40, Q-41 (by you): loop run reviewed']]);
  });

  it('J27: Answered holds 24 hours, while the store keeps the record', async () => {
    const queue = queueWith();
    queue.addWorkerQuestion({ id: 'in-1', question: 'Q-39: run?', source: worker, at: Date.now() });
    queue.agentAct({ type: 'agent-answer', id: 'in-1', answer: { text: 'Go' }, because: 'D-1' });
    await vi.advanceTimersByTimeAsync(DAY + 1);
    expect(item(queue, 'in-1')).toBeUndefined();
    expect(store.answeredRecord('s1').map(saved => saved.id)).toEqual(['in-1']);
  });

  it('J12: Autopilot answers at once with its reason, and Override sends the correction', async () => {
    const queue = queueWith();
    queue.addWorkerQuestion({ id: 'in-1', question: 'Q-39: run?', source: worker, at: Date.now() });
    queue.agentAct({ type: 'agent-answer', id: 'in-1', answer: { text: 'Go' }, because: 'D-22' });
    await vi.advanceTimersByTimeAsync(1);
    expect(item(queue, 'in-1')).toMatchObject({ state: 'answered', answeredBy: { by: 'autopilot', because: 'D-22' } });
    expect(typed).toEqual([['w1', 'answer: Q-39 → Go (by Autopilot)']]);
    queue.run({ type: 'override', id: 'in-1', answer: { text: 'Stop' } });
    await vi.advanceTimersByTimeAsync(1);
    expect(typed[1]).toEqual(['w1', 'correction: Q-39 → Stop (by you)']);
    expect(item(queue, 'in-1')?.corrections).toMatchObject([{ summary: 'Stop', by: 'you' }]);
  });

  it('J13: Autopilot is refused a permission prompt, and the item is unchanged', () => {
    const queue = queueWith();
    void queue.ask({ id: 'p1', question: { ui: 'options', title: 'Run rm?', choices: [{ label: 'Yes' }, { label: 'No' }], agentPrompt: { yes: 'Yes', no: 'No' } }, source: { ...worker, panelId: 'c1' } });
    expect(() => queue.agentAct({ type: 'agent-answer', id: 'p1', answer: { choice: 'Yes' }, because: 'x' })).toThrow(expect.objectContaining({ code: 'AUTOPILOT_CANNOT_ANSWER' }));
    expect(() => queue.agentAct({ type: 'agent-close', id: 'p1', reason: 'x' })).toThrow(expect.objectContaining({ code: 'AUTOPILOT_CANNOT_ANSWER' }));
    expect(item(queue, 'p1')?.state).toBe('waiting');
  });

  it('Autopilot is refused answering or rewriting a secret card; it may close one (secrets #1014)', () => {
    const saved: string[] = [];
    const queue = queueWith({ secrets: { exists: () => false, save: async (_project, _name, value) => { saved.push(value); } } });
    void queue.ask({ id: 's1', question: { ui: 'secret', title: 'Stripe key', secret: { project: 'stripe', name: 'KEY' } }, source: worker });
    expect(() => queue.agentAct({ type: 'agent-answer', id: 's1', answer: { text: 'sk_guess' }, because: 'x' })).toThrow(expect.objectContaining({ code: 'AUTOPILOT_CANNOT_ANSWER' }));
    expect(() => queue.agentAct({ type: 'agent-rewrite', id: 's1', question: ask('Paste the key here') })).toThrow(expect.objectContaining({ code: 'AUTOPILOT_CANNOT_ANSWER' }));
    expect(item(queue, 's1')?.state).toBe('waiting');
    expect(saved).toEqual([]);
    queue.agentAct({ type: 'agent-close', id: 's1', reason: 'not needed any more' });
    expect(item(queue, 's1')?.state).toBe('expired');
  });

  it('J14: Autopilot closes with a reason the person can reopen', async () => {
    const queue = queueWith();
    queue.addWorkerQuestion({ id: 'in-1', question: 'Q-39: run?', source: worker, at: Date.now() });
    queue.agentAct({ type: 'agent-close', id: 'in-1', reason: 'the PR merged' });
    await vi.advanceTimersByTimeAsync(1);
    expect(item(queue, 'in-1')?.closed).toMatchObject({ by: 'autopilot', reason: 'the PR merged' });
    expect(typed).toEqual([['w1', 'closed: Q-39 (by Autopilot): the PR merged']]);
    queue.run({ type: 'reopen', id: 'in-1' });
    expect(item(queue, 'in-1')).toMatchObject({ state: 'waiting' });
    expect(item(queue, 'in-1')?.closed).toBeUndefined();
    expect(queue.snapshot().queue).toEqual(['in-1']);
  });

  it('a stale item the person reopens waits in the open, and counts its three days from the Reopen', async () => {
    const queue = queueWith();
    queue.addWorkerQuestion({ id: 'in-1', question: 'Q-40: still needed?', source: worker, at: Date.now() });
    await vi.advanceTimersByTimeAsync(4 * DAY);
    queue.sweep();
    queue.agentAct({ type: 'agent-close', id: 'in-1', reason: 'stale' });
    queue.run({ type: 'reopen', id: 'in-1' });
    queue.sweep();
    expect(item(queue, 'in-1')?.staleSince).toBeUndefined();
    expect(queue.snapshot().hidden).toEqual([]);
    await vi.advanceTimersByTimeAsync(3 * DAY);
    queue.sweep();
    expect(item(queue, 'in-1')?.staleSince).toBeDefined();
  });

  it('refuses to reopen an item asked from outside Pane: its call ended, so no one would get the answer', () => {
    const queue = queueWith();
    const controller = new AbortController();
    void queue.ask({ question: ask('Q-41: outside?'), source: { name: 'scripts', agent: 'Claude' } }, controller.signal);
    const [{ id }] = queue.snapshot().items;
    queue.run({ type: 'close', id });
    expect(() => queue.run({ type: 'reopen', id })).toThrow(expect.objectContaining({ code: 'ERR_NOTIFY_ASKER_GONE' }));
    expect(item(queue, id)?.state).toBe('expired');
  });

  it('refuses a teammate acting as Autopilot, so no receipt reads "by Autopilot" for someone else', () => {
    const queue = queueWith();
    queue.addWorkerQuestion({ id: 'in-1', question: 'Q-42: deploy?', source: worker, at: Date.now() });
    expect(() => queue.runRemote({ type: 'agent-answer', id: 'in-1', answer: { text: 'yes' }, because: 'trust me' }, 'build-mac', 'teammate@example.com'))
      .toThrow(expect.objectContaining({ code: 'ERR_NOTIFY_NOT_AUTOPILOT' }));
    expect(item(queue, 'in-1')?.state).toBe('waiting');
    queue.runRemote({ type: 'agent-answer', id: 'in-1', answer: { text: 'yes' }, because: 'D-9' }, 'mini', null);
    expect(item(queue, 'in-1')?.answeredBy).toMatchObject({ by: 'autopilot', because: 'D-9' });
  });

  it('a reopened item says who reopened it and what it reversed, and a device names where', () => {
    const queue = queueWith();
    queue.addWorkerQuestion({ id: 'in-1', question: 'Q-39: run?', source: worker, at: Date.now() });
    queue.agentAct({ type: 'agent-close', id: 'in-1', reason: 'stale' });
    queue.runRemote({ type: 'reopen', id: 'in-1' }, 'iPhone');
    expect(item(queue, 'in-1')?.reopened).toMatchObject({ by: 'you', device: 'iPhone', closedBy: 'autopilot', closedReason: 'stale' });
    expect(new ApprovalStore(db, 'mini').readItem('in-1')?.reopened?.closedBy).toBe('autopilot');
  });

  it('an Autopilot close keeps its receipt when the asker stops waiting straight after', async () => {
    const queue = queueWith();
    const controller = new AbortController();
    void queue.ask({ question: ask('Q-2: x?'), source: orchestrator }, controller.signal);
    const [{ id }] = queue.snapshot().items;
    queue.agentAct({ type: 'agent-close', id, reason: 'no build behind it' });
    controller.abort();
    queue.sweep();
    expect(item(queue, id)?.closed).toMatchObject({ by: 'autopilot', reason: 'no build behind it' });
    expect(store.readItem(id)?.closed?.by).toBe('autopilot');
  });

  it('an Autopilot close just after the asker stopped still reads as Autopilot\'s, and nothing is typed', async () => {
    const queue = queueWith();
    const controller = new AbortController();
    void queue.ask({ question: ask('Q-2: x?'), source: orchestrator }, controller.signal);
    const [{ id }] = queue.snapshot().items;
    controller.abort();
    queue.agentAct({ type: 'agent-close', id, reason: 'no build behind it' });
    await vi.advanceTimersByTimeAsync(1);
    expect(item(queue, id)?.closed).toMatchObject({ by: 'autopilot', reason: 'no build behind it' });
    expect(store.readItem(id)?.closed?.by).toBe('autopilot');
    expect(typed).toEqual([]);
  });

  it('first write still wins over a close by anyone else: Autopilot does not replace the person', () => {
    const queue = queueWith();
    queue.addWorkerQuestion({ id: 'in-1', question: 'Q-1: a?', source: worker, at: Date.now() });
    queue.run({ type: 'close', id: 'in-1', reason: 'mine' });
    expect(() => queue.agentAct({ type: 'agent-close', id: 'in-1', reason: 'late' })).toThrow(expect.objectContaining({ code: 'ERR_NOTIFY_EXPIRED' }));
    expect(item(queue, 'in-1')?.closed).toMatchObject({ by: 'you', reason: 'mine' });
  });

  it('J14: a rewrite closes the old item, links both, and the answer reaches the original asker', async () => {
    const queue = queueWith();
    const call = queue.ask({ question: ask('Q-9: thing?'), source: orchestrator });
    const [{ id }] = queue.snapshot().items;
    const { id: fresh } = queue.agentAct({ type: 'agent-rewrite', id, question: { ui: 'options', title: 'Q-9: Ship on Friday?', choices: [{ label: 'Yes' }, { label: 'No' }] } });
    expect(item(queue, id)).toMatchObject({ state: 'expired', rewrittenAs: { id: fresh }, closed: { by: 'autopilot' } });
    expect(item(queue, fresh)).toMatchObject({ state: 'waiting', rewrittenFrom: { id, qn: 'Q-9' }, source: { panelId: 'orch' } });
    queue.run({ type: 'answer', id: fresh, answer: { choice: 'Yes' } });
    await vi.advanceTimersByTimeAsync(3_000);
    expect(await call).toEqual({ answer: 'Yes' });
    expect(() => queue.run({ type: 'reopen', id })).toThrow(expect.objectContaining({ code: 'ERR_NOTIFY_REWRITTEN' }));
  });

  it('J30: only the first answer or close counts, and the loser hears who won', () => {
    const queue = queueWith();
    queue.addWorkerQuestion({ id: 'in-1', question: 'Q-39: run?', source: worker, at: Date.now() });
    queue.runRemote({ type: 'agent-answer', id: 'in-1', answer: { text: 'A' }, because: 'D-1', machine: 'studio' }, 'studio');
    const late = () => queue.runRemote({ type: 'agent-answer', id: 'in-1', answer: { text: 'B' }, because: 'D-2', machine: 'book' }, 'book');
    expect(late).toThrow(expect.objectContaining({ code: 'ERR_NOTIFY_ANSWERED', message: 'Already answered by Autopilot on studio. Nothing was sent.' }));
    expect(() => queue.runRemote({ type: 'agent-close', id: 'in-1', reason: 'x' }, 'book')).toThrow(expect.objectContaining({ code: 'ERR_NOTIFY_ANSWERED' }));
    expect(store.readItem('in-1')?.answerSummary).toBe('A');
  });

  it('J30: a row another writer already claimed beats this one, and memory takes its version', () => {
    const queue = queueWith();
    queue.addWorkerQuestion({ id: 'in-1', question: 'Q-39: run?', source: worker, at: Date.now() });
    const row = store.readItem('in-1');
    if (!row) throw new Error('The worker question was not saved.');
    store.claim({ ...row, state: 'answered', resolvedAt: Date.now(), answeredBy: { by: 'autopilot', because: 'first' }, answeredOn: 'studio' });
    expect(() => queue.agentAct({ type: 'agent-answer', id: 'in-1', answer: { text: 'late' }, because: 'second' })).toThrow(expect.objectContaining({ code: 'ERR_NOTIFY_ANSWERED' }));
    expect(store.readItem('in-1')?.answeredBy?.because).toBe('first');
  });

  it('J25: the upgrade closes what its asker left and offers the rest on one card', async () => {
    const queue = queueWith();
    void queue.ask({ question: ask('dead'), source: { ...worker, panelId: 'dead' } });
    void queue.ask({ question: ask('alive'), source: worker });
    const [dead, alive] = queue.snapshot().items;
    gone.set('dead', 'the asking tab was closed');
    queue.upgradeCleanup();
    expect(item(queue, dead.id)?.closed?.reason).toBe('closed on upgrade: the asking tab was closed');
    const summary = queue.snapshot().items.find(candidate => candidate.summaryOf);
    if (!summary) throw new Error('No summary card.');
    expect(summary).toMatchObject({ title: '1 older approval is still waiting', summaryOf: [alive.id] });
    queue.run({ type: 'answer', id: summary.id, answer: { choice: 'Close all' } });
    await vi.advanceTimersByTimeAsync(3_000);
    expect(item(queue, alive.id)?.closed?.by).toBe('you');
  });

  it('J4: an idle computer shows no strip and plays no chime, for its own or another machine\'s item', () => {
    using = false;
    const queue = queueWith();
    const chimes = vi.fn();
    queue.on('chime', chimes);
    queue.setPaneFocused(true);
    void queue.ask({ question: ask('Q-2: x?'), source: orchestrator });
    queue.setRemote('b', { machine: 'book', online: true, state: { machine: 'book', epoch: 'e', revision: 1, enabled: true, items: [], queue: [], hidden: [] } });
    const waiting: NotifyItem = { id: 'r1', ui: 'ask', title: 'remote', state: 'waiting', createdAt: Date.now(), source: { name: 'x', agent: 'Claude' } };
    queue.setRemote('b', { machine: 'book', online: true, state: { machine: 'book', epoch: 'e', revision: 2, enabled: true, items: [waiting], queue: ['r1'], hidden: [] } });
    expect(chimes).not.toHaveBeenCalled();
    expect(queue.snapshot().stripSurface).toBeNull();
    using = true;
    queue.pollInUse();
    expect(queue.snapshot().stripSurface).toBe('pane');
    const another = { ...waiting, id: 'r2' };
    queue.setRemote('b', { machine: 'book', online: true, state: { machine: 'book', epoch: 'e', revision: 3, enabled: true, items: [waiting, another], queue: ['r1', 'r2'], hidden: [] } });
    expect(chimes).toHaveBeenCalledTimes(1);
  });

  it('Show cards on another machine that reads this one: no strip and no chime here, the list keeps every item, and an in-use computer alerts again once it stops reading', () => {
    let cardsOn: NotifyCardsOnStatus = { kind: 'elsewhere', name: 'book' };
    const queue = queueWith({ cardsOn: () => cardsOn });
    const chimes = vi.fn();
    queue.on('chime', chimes);
    queue.setPaneFocused(true);
    void queue.ask({ question: ask('Q-2: x?'), source: orchestrator });
    const waiting: NotifyItem = { id: 'r1', ui: 'ask', title: 'remote', state: 'waiting', createdAt: Date.now(), source: { name: 'x', agent: 'Claude' } };
    const remote = (items: NotifyItem[], revision: number) => queue.setRemote('b', { machine: 'book', online: true, state: { machine: 'book', epoch: 'e', revision, enabled: true, items, queue: items.map(entry => entry.id), hidden: [] } });
    remote([], 1);
    remote([waiting], 2);

    expect(chimes).not.toHaveBeenCalled();
    expect(queue.snapshot().stripSurface).toBeNull();
    expect(queue.snapshot().queue).toHaveLength(2);
    expect(queue.snapshot().cardsOn).toEqual({ kind: 'elsewhere', name: 'book' });

    cardsOn = { kind: 'not-connected', name: 'book' };
    queue.pollInUse();
    expect(queue.snapshot().stripSurface).toBe('pane');
    void queue.ask({ question: ask('Q-3: y?'), source: orchestrator });
    expect(chimes).toHaveBeenCalledTimes(1);
  });

  describe('system notifications while Pane is in the background', () => {
    const background = () => queueWith({ settings: () => DEFAULT_NOTIFY_SETTINGS });
    const titles = (queue: NotifyQueue) => queue.takeUnannounced().map(entry => entry.title);
    const waiting: NotifyItem = { id: 'r1', ui: 'ask', title: 'remote', state: 'waiting', createdAt: 0, source: { name: 'x', agent: 'Claude' } };
    const share = (queue: NotifyQueue, revision: number, ...items: NotifyItem[]) => queue.setRemote('b', { machine: 'book', online: true, state: { machine: 'book', epoch: 'e', revision, enabled: true, items, queue: items.map(entry => entry.id), hidden: [] } });

    it('holds a question for a person who is away until they are back, and only once', () => {
      using = false;
      const queue = background();
      void queue.ask({ question: ask('Q-2: x?'), source: orchestrator });
      expect(titles(queue)).toEqual([]);
      using = true;
      expect(titles(queue)).toEqual(['Q-2: x?']);
      expect(titles(queue)).toEqual([]);
    });

    it('announces a Claude prompt once when it arrives and once when its snooze ends', () => {
      const queue = background();
      void queue.ask({ id: 'p1', question: { ui: 'options', title: 'Run npm test?', choices: [{ label: 'Yes' }, { label: 'No' }], agentPrompt: { yes: 'Yes', no: 'No' } }, source: worker });
      expect(titles(queue)).toEqual(['Run npm test?']);
      queue.run({ type: 'remind', id: 'p1', after: '10m' });
      expect(titles(queue)).toEqual([]);
      vi.advanceTimersByTime(10 * 60_000);
      expect(titles(queue)).toEqual(['Run npm test?']);
    });

    it('announces what Autopilot reworded while the person was away, once, as reworded', () => {
      using = false;
      const queue = background();
      void queue.ask({ id: 'q1', question: ask('Q-2: x?'), source: orchestrator });
      expect(titles(queue)).toEqual([]);
      queue.agentAct({ type: 'agent-rewrite', id: 'q1', question: ask('Q-2: which region?') });
      using = true;
      expect(titles(queue)).toEqual(['Q-2: which region?']);
    });

    it('announces another machine\'s snooze end, new version and nearly full disk, and nothing about its memory', () => {
      const queue = background();
      const chimes = vi.fn();
      queue.on('chime', chimes);
      share(queue, 1, { ...waiting, snoozedUntil: 1 });
      share(queue, 2, waiting);
      expect(titles(queue)).toEqual(['remote']);
      share(queue, 3, { ...waiting, readyAgain: 5 });
      share(queue, 4, { ...waiting, readyAgain: 5 });
      expect(titles(queue)).toEqual(['remote']);
      expect(chimes).not.toHaveBeenCalled();

      const health = (id: string, kind: 'disk' | 'memory', level: 'warning' | 'critical'): NotifyItem => ({ ...waiting, id, title: `${kind} ${level}`, machineHealth: { kind, level, hostname: 'book', rows: [], agentPrompt: '' } });
      share(queue, 5, health('d1', 'disk', 'warning'), health('d2', 'disk', 'critical'), health('m1', 'memory', 'critical'));
      expect(titles(queue)).toEqual(['disk critical']);
      expect(queue.snapshot().items.map(entry => entry.title)).toEqual(['disk warning', 'disk critical']);
      expect(queue.snapshot().queue).toEqual(['b:d1', 'b:d2']);
      // This computer's own nearly full disk has its own alert, even with a machine linked.
      void queue.ask({ question: { ui: 'options', title: 'Disk is almost full', choices: [{ label: 'Not now' }], machineHealth: { kind: 'disk', level: 'critical', hostname: 'mini', rows: [], agentPrompt: '' } }, source: { name: 'Pane', agent: 'Pane' } });
      expect(titles(queue)).toEqual([]);
    });
  });

  it('Show cards on this machine still waits for it to be in use (D-6)', () => {
    using = false;
    const queue = queueWith({ cardsOn: () => ({ kind: 'here' }) });
    const chimes = vi.fn();
    queue.on('chime', chimes);
    queue.setPaneFocused(true);
    void queue.ask({ question: ask('Q-2: x?'), source: orchestrator });
    expect(chimes).not.toHaveBeenCalled();
    expect(queue.snapshot().stripSurface).toBeNull();
    using = true;
    queue.pollInUse();
    expect(queue.snapshot().stripSurface).toBe('pane');
  });

  describe('cardsOnStatus', () => {
    const MINI = 'a1b2-mini';
    const BOOK = { id: 'c3d4-book', name: 'qa-macbook' };
    const config = (cardsOn: typeof BOOK | null) => ({ machineId: MINI, notify: { cardsOn } });
    const NOW = Date.parse('2026-11-12T20:00:00.000Z');
    const saved = (status: MachineState['status'], onlineSince = '2026-11-12T19:50:00.000Z'): MachineState[] => [
      { id: 'local', label: 'This computer', kind: 'local', status: 'online', offlineSince: null, installId: MINI },
      { id: 'profile-7', label: 'MacBook', kind: 'remote', status, offlineSince: null, installId: BOOK.id, onlineSince },
    ];
    const reading = (machineId: string) => machineId === BOOK.id;
    const nobody = () => false;

    it.each([
      ['nothing picked', config(null), reading, saved('online'), { kind: 'any' }],
      ['this machine picked', { ...config(null), notify: { cardsOn: { id: MINI, name: 'mini' } } }, nobody, saved('online'), { kind: 'here' }],
      ['the picked machine reads this one', config(BOOK), reading, saved('online'), { kind: 'elsewhere', name: 'MacBook' }],
      ['the picked machine answers but hasn\'t saved this one', config(BOOK), nobody, saved('online'), { kind: 'not-added', name: 'MacBook' }],
      ['the picked machine is offline', config(BOOK), nobody, saved('offline'), { kind: 'not-connected', name: 'MacBook' }],
      ['the picked machine dropped off but its stream here is still half-open', config(BOOK), reading, saved('offline'), { kind: 'not-connected', name: 'MacBook' }],
      ['the picked machine came online seconds ago and may still be reconnecting to this one', config(BOOK), nobody, saved('online', '2026-11-12T19:59:40.000Z'), { kind: 'not-connected', name: 'MacBook' }],
      ['the picked machine isn\'t saved here', config(BOOK), nobody, [], { kind: 'not-connected', name: 'qa-macbook' }],
    ])('%s', (_case, appConfig, readsHere, machines, expected) => {
      expect(cardsOnStatus(appConfig, readsHere, machines, NOW)).toEqual(expected);
    });
  });

  it('J26: a receipt names a machine as this screen\'s picker does', () => {
    const queue = queueWith();
    const state = (answeredOn: string): NotifyItem => ({ id: 'r1', ui: 'ask', title: 'x', state: 'answered', answeredOn, createdAt: Date.now(), source: { name: 'x', agent: 'Claude' } });
    const show = (answeredOn: string, revision: number) => queue.setRemote('b', { machine: 'MacBook', online: true, state: { machine: 'qa-macbook', epoch: 'e', revision, enabled: true, items: [state(answeredOn)], queue: [], hidden: [] } });
    show('qa-macbook', 1);
    expect(item(queue, 'b:r1')?.answeredOn).toBe('MacBook');
    show('mini', 2);
    expect(item(queue, 'b:r1')?.answeredOn).toBeUndefined();
    show("Parsa's iPhone", 3);
    expect(item(queue, 'b:r1')?.answeredOn).toBe("Parsa's iPhone");
  });

  it('J1: turning Approvals off ends open calls, and hides saved items until it comes back', async () => {
    let enabled = true;
    const settings = () => ({ ...DEFAULT_NOTIFY_SETTINGS, enabled });
    const queue = queueWith({ settings });
    const call: Promise<NotifyResult> = queue.ask({ question: ask('Q-2: x?'), source: orchestrator });
    queue.addWorkerQuestion({ id: 'in-1', question: 'Q-39: run?', source: worker, at: Date.now() });
    enabled = false;
    queue.turnOff();
    expect(await call).toMatchObject({ unavailable: 'Approvals were turned off in Pane.' });
    expect(queue.snapshot().queue).toEqual([]);
    expect(item(queue, 'in-1')).toBeUndefined();
    enabled = true;
    expect(item(queue, 'in-1')?.state).toBe('waiting');
  });

  it('touches the store the same few times per sweep with 500 or 5,000 waiting items', () => {
    const sweepStatements = (waiting: number) => {
      const statements: string[] = [];
      const counted = new Database(':memory:', { verbose: sql => statements.push(String(sql)) });
      store = new ApprovalStore(counted, 'mini');
      counted.transaction(() => {
        for (let index = 0; index < waiting; index += 1) {
          store.saveItem({ id: `row-${index}`, ui: 'ask', title: `t${index}`, state: 'waiting', createdAt: Date.now(), source: worker });
        }
      })();
      const queue = queueWith();
      expect(queue.snapshot().queue).toHaveLength(waiting);
      statements.length = 0;
      queue.sweep();
      const swept = [...statements];
      queue.dispose();
      counted.close();
      return swept;
    };
    // Items that need no change cost the sweep no reads or writes: its one statement is the retention prune.
    const few = sweepStatements(500);
    expect(few).toEqual([expect.stringMatching(/^DELETE FROM approvals WHERE ended_at/u)]);
    expect(sweepStatements(5_000)).toEqual(few);
  });
});
