import Database from 'better-sqlite3-multiple-ciphers';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_NOTIFY_SETTINGS, type NotifyItem, type NotifyQuestion, type NotifyResult, type NotifySource } from '../../../../shared/types/notify';
import { PaneError } from '../../../../shared/paneError';
import { ApprovalStore } from '../approvals/approvalStore';
import { ASKING_TAB_CLOSED, NotifyQueue, type NotifyQueueEnvironment } from './notifyQueue';

const session = { id: 's1', name: 'Doozy', paneId: 'sp', orchestrator: true };
const orchestrator: NotifySource = { name: 'Session: Doozy', agent: 'Claude', paneId: 'sp', panelId: 'orch', session };
const worker: NotifySource = { name: 'doozy-overhaul', agent: 'Claude', paneId: 'wp', panelId: 'w1', session: { id: 's1', name: 'Doozy', paneId: 'sp' } };
const q20: NotifyQuestion = {
  ui: 'options',
  title: 'Q-20: Turn on the new-agent switch for dev QA, and merge as one train?',
  context: 'One UPDATE in my status file keeps the person\'s test on the new agent.',
  questions: [
    { title: 'May I turn the new-agent switch on for the dev QA workspace?', choices: [{ label: 'Yes, turn it on', detail: 'One UPDATE on dev QA only.' }, { label: 'Not yet' }] },
    { title: 'Merge #2470–#2480 as one train, or gate each lower PR too?', choices: [{ label: 'One train', recommended: true }, { label: 'Gate each lower PR' }] },
  ],
};

describe('NotifyQueue replies (the reply contract)', () => {
  let db: Database.Database;
  let store: ApprovalStore;
  let typed: Array<[string, string]>;
  let tabs: Map<string, 'delivered' | 'busy' | 'gone' | 'unsupported'>;
  let gone: Map<string, string>;
  let autopilot: { panelId: string } | undefined;
  let closedTabs: Set<string>;

  const queueWith = (extra: Partial<NotifyQueueEnvironment> = {}) => new NotifyQueue({
    // The floating strip is off by default; these tests read it.
    settings: () => ({ ...DEFAULT_NOTIFY_SETTINGS, showOutsidePane: true }),
    showOutsideSupported: true,
    shortcutRegistered: () => true,
    instructionFiles: () => [],
    machine: 'mini',
    store,
    askerGone: (item: NotifyItem) => gone.get(item.source.panelId ?? ''),
    typeIntoTab: async (panelId, text) => {
      const outcome = tabs.get(panelId) ?? 'delivered';
      if (outcome === 'delivered') typed.push([panelId, text]);
      return outcome;
    },
    tabAlive: panelId => !closedTabs.has(panelId),
    autopilotReader: () => autopilot,
    ...extra,
  });
  const item = (queue: NotifyQueue, id: string) => queue.snapshot().items.find(candidate => candidate.id === id);
  /** Posts Q-20 from the orchestrator's tab after a restart: no open call, so lines go to the tab. */
  const restoredQ20 = () => {
    const first = queueWith();
    void first.ask({ question: q20, source: orchestrator, id: 'q20' });
    first.dispose();
    return queueWith();
  };

  beforeEach(() => {
    vi.useFakeTimers();
    db = new Database(':memory:');
    store = new ApprovalStore(db, 'mini');
    typed = [];
    tabs = new Map();
    gone = new Map();
    autopilot = undefined;
    closedTabs = new Set();
  });
  afterEach(() => {
    db.close();
    vi.useRealTimers();
  });

  it('J5: picks alone are the answer, typed as today with every pick', async () => {
    const queue = restoredQ20();
    queue.run({ type: 'answer', id: 'q20', answer: { picks: ['Yes, turn it on', 'One train'] } });
    await vi.advanceTimersByTimeAsync(3_000);
    expect(typed).toEqual([['orch', 'answer: Q-20 → Yes, turn it on · One train (by you)']]);
    expect(item(queue, 'q20')).toMatchObject({ state: 'answered', answerSummary: 'Yes, turn it on · One train' });
    expect(item(queue, 'q20')?.reply).toBeUndefined();
  });

  it('J5: an open call gets every pick back', async () => {
    const queue = queueWith();
    const call = queue.ask({ question: q20, source: orchestrator, id: 'q20' });
    queue.run({ type: 'answer', id: 'q20', answer: { picks: ['Not yet', 'Gate each lower PR'] } });
    await vi.advanceTimersByTimeAsync(3_000);
    await expect(call).resolves.toEqual({ answer: 'Not yet · Gate each lower PR', answers: ['Not yet', 'Gate each lower PR'] });
  });

  it('refuses picks that leave a question out', () => {
    const queue = restoredQ20();
    expect(() => queue.run({ type: 'answer', id: 'q20', answer: { picks: ['Yes, turn it on'] } })).toThrow(/each of the 2 questions/);
  });

  it('J6: typed text is a reply, typed once into the asker\'s tab, and answers the approval with the picks once it lands', async () => {
    const queue = restoredQ20();
    queue.run({ type: 'answer', id: 'q20', answer: { picks: ['Yes, turn it on', 'One train'], text: 'Turn it on only if it can be undone' } });
    await vi.advanceTimersByTimeAsync(1);
    expect(typed).toEqual([['orch', 'reply: Q-20 → "Turn it on only if it can be undone" (picked: Yes, turn it on · One train) (by you)']]);
    expect(item(queue, 'q20')).toMatchObject({ state: 'answered', reply: { state: 'answer', reader: { kind: 'asker', panelId: 'orch' } }, answerSummary: 'Yes, turn it on · One train — "Turn it on only if it can be undone"' });
    expect(queue.snapshot().queue).not.toContain('q20');

    // --took answer still works, and changes nothing.
    expect(queue.took({ panelId: 'orch' }, 'Q-20', 'answer')).toEqual({ took: 'answer', id: 'q20' });
    expect(item(queue, 'q20')).toMatchObject({ state: 'answered', reply: { state: 'answer' } });
    queue.sweep();
    await vi.advanceTimersByTimeAsync(1);
    expect(typed).toHaveLength(1);
  });

  it('F-1: a reply typed between resume rounds goes to the tab, since the call may never resume, and a late --resume still gets it', async () => {
    const queue = queueWith();
    const first = queue.ask({ question: q20, source: orchestrator, id: 'q20', returnAfterMs: 50_000 });
    await vi.advanceTimersByTimeAsync(50_000);
    expect(await first).toMatchObject({ waiting: true, id: 'q20' });
    queue.run({ type: 'answer', id: 'q20', answer: { picks: ['Yes, turn it on', 'One train'], text: 'Only if it can be undone' } });
    await vi.advanceTimersByTimeAsync(120_000);
    queue.sweep();
    await vi.advanceTimersByTimeAsync(1);
    expect(typed).toEqual([['orch', 'reply: Q-20 → "Only if it can be undone" (picked: Yes, turn it on · One train) (by you)']]);
    expect(item(queue, 'q20')).toMatchObject({ state: 'answered', delivered: { via: 'tab' }, reply: { state: 'answer', reader: { kind: 'asker', panelId: 'orch' } } });
    expect(await queue.ask({ resume: 'q20', source: orchestrator })).toMatchObject({ answer: 'Yes, turn it on · One train', note: 'Only if it can be undone' });
  });

  it('F-1: a reply to a card whose call was killed reaches the tab, and a later --resume still gets it', async () => {
    const queue = queueWith();
    const controller = new AbortController();
    void queue.ask({ question: q20, source: orchestrator, id: 'q20' }, controller.signal);
    controller.abort();
    queue.run({ type: 'answer', id: 'q20', answer: { picks: ['Yes, turn it on', 'One train'], text: 'Only if it can be undone' } });
    await vi.advanceTimersByTimeAsync(1);
    expect(typed).toEqual([['orch', 'reply: Q-20 → "Only if it can be undone" (picked: Yes, turn it on · One train) (by you)']]);
    expect(await queue.ask({ resume: 'q20', source: orchestrator })).toMatchObject({ answer: 'Yes, turn it on · One train', note: 'Only if it can be undone' });
  });

  it('review Should-Fix: --close drops a reply still waiting for the busy asking tab, so it is never typed later', async () => {
    const queue = restoredQ20();
    tabs.set('orch', 'busy');
    queue.run({ type: 'answer', id: 'q20', answer: { picks: [], text: 'Why one train?' } });
    await vi.advanceTimersByTimeAsync(1);
    expect(typed).toEqual([]);
    expect(queue.withdrawByAsker({ paneId: 'sp', panelId: 'orch' }, 'Q-20')).toEqual({ closed: true, id: 'q20' });
    tabs.set('orch', 'delivered');
    queue.flushTabMessages();
    queue.sweep();
    await vi.advanceTimersByTimeAsync(61_000);
    expect(typed).toEqual([]);
    expect(item(queue, 'q20')).toMatchObject({ state: 'expired', closed: { reason: 'its asker withdrew it' } });
  });

  it('review Should-Fix: --close is refused while the reply is being typed into the tab, and the reply then lands as the answer', async () => {
    let land: ((outcome: 'delivered') => void) | undefined;
    const first = queueWith();
    void first.ask({ question: q20, source: orchestrator, id: 'q20' });
    first.dispose();
    const queue = queueWith({
      typeIntoTab: (panelId, text) => new Promise((resolve) => {
        land = (outcome) => {
          typed.push([panelId, text]);
          resolve(outcome);
        };
      }),
    });
    queue.run({ type: 'answer', id: 'q20', answer: { picks: [], text: 'Only if it can be undone' } });
    await vi.advanceTimersByTimeAsync(1);
    expect(land).toBeDefined();
    expect(() => queue.withdrawByAsker({ paneId: 'sp', panelId: 'orch' }, 'Q-20')).toThrow(expect.objectContaining({ code: 'ERR_NOTIFY_ANSWERED' }));
    expect(item(queue, 'q20')?.state).toBe('waiting');
    land?.('delivered');
    await vi.advanceTimersByTimeAsync(1);
    expect(typed).toEqual([['orch', 'reply: Q-20 → "Only if it can be undone" (by you)']]);
    expect(item(queue, 'q20')).toMatchObject({ state: 'answered', reply: { state: 'answer' } });
    expect(() => queue.withdrawByAsker({ paneId: 'sp', panelId: 'orch' }, 'Q-20')).toThrow(expect.objectContaining({ code: 'ERR_NOTIFY_GONE' }));
  });

  it('J6: a busy tab gets the reply when it is next idle, still once', async () => {
    const queue = restoredQ20();
    tabs.set('orch', 'busy');
    queue.run({ type: 'answer', id: 'q20', answer: { picks: [], text: 'Why one train?' } });
    await vi.advanceTimersByTimeAsync(1);
    expect(typed).toEqual([]);
    expect(item(queue, 'q20')).toMatchObject({ state: 'waiting', reply: { state: 'reading' } });
    queue.sweep();
    await vi.advanceTimersByTimeAsync(1);
    tabs.set('orch', 'delivered');
    queue.flushTabMessages();
    await vi.advanceTimersByTimeAsync(1);
    expect(typed).toEqual([['orch', 'reply: Q-20 → "Why one train?" (by you)']]);
    expect(item(queue, 'q20')).toMatchObject({ state: 'answered', answerSummary: 'Why one train?' });
  });

  it('returns a reply to an open call, which records it as the answer', async () => {
    const queue = queueWith();
    const call = queue.ask({ question: q20, source: orchestrator, id: 'q20' });
    queue.run({ type: 'answer', id: 'q20', answer: { picks: [], text: 'Can it be undone?' } });
    const result: NotifyResult = await call;
    expect(result).toMatchObject({ reply: 'Can it be undone?', id: 'q20' });
    // Its continuation id is its own: never the reply's public id, which every screen sees (F-6).
    expect('replyId' in result && result.replyId).toEqual(expect.any(String));
    expect('replyId' in result && result.replyId).not.toBe(item(queue, 'q20')?.reply?.id);
    expect('next' in result && 'replyId' in result && result.next).toContain(`--took ${'replyId' in result ? result.replyId : ''} question`);
    expect(typed).toEqual([]);
    expect(item(queue, 'q20')).toMatchObject({ state: 'answered', answerSummary: 'Can it be undone?', reply: { state: 'answer', reader: { kind: 'asker' } } });
  });

  it('a reply taken as the answer comes back ready again when its reader updates it, with or without --took question', async () => {
    for (const tookFirst of [true, false]) {
      const queue = queueWith();
      const call = queue.ask({ question: q20, source: orchestrator, id: 'q20' });
      queue.run({ type: 'answer', id: 'q20', answer: { picks: [], text: 'Can it be undone?' } });
      const result = await call;
      if (!('replyId' in result)) throw new Error(`expected a reply result, got ${JSON.stringify(result)}`);
      if (tookFirst) {
        expect(queue.took({}, result.replyId, 'question')).toMatchObject({ took: 'question', id: 'q20' });
        expect(item(queue, 'q20')).toMatchObject({ state: 'waiting', reply: { state: 'question', status: 'Getting more context…' } });
      }
      const updated = queue.update({}, result.replyId, { asked: 'Can it be undone?', whatChanged: 'Added the undo path', context: 'One reverse UPDATE undoes it.' });
      expect(item(queue, 'q20')).toMatchObject({ state: 'waiting', version: 2, context: 'One reverse UPDATE undoes it.' });
      expect(item(queue, 'q20')?.readyAgain).toBeDefined();
      expect(item(queue, 'q20')?.answerSummary).toBeUndefined();
      expect(queue.snapshot().queue).toContain('q20');
      queue.run({ type: 'answer', id: 'q20', answer: { picks: ['Yes, turn it on', 'One train'] } });
      await vi.advanceTimersByTimeAsync(3_000);
      await expect(updated).resolves.toEqual({ answer: 'Yes, turn it on · One train', answers: ['Yes, turn it on', 'One train'] });
      queue.dispose();
    }
  });

  it('F-6 (D-294): a reader outside Pane continues with the reply id its call was given; nobody else can use the approval\'s id', async () => {
    const outside: NotifySource = { name: 'release-scripts', agent: 'Claude', cwd: '/tmp/release' };
    const queue = queueWith();
    const call = queue.ask({ question: { ui: 'options', title: 'Q-50: Tag the release?', choices: [{ label: 'Tag it' }, { label: 'Wait' }] }, source: outside, id: 'q50' });
    queue.run({ type: 'answer', id: 'q50', answer: { picks: [], text: 'What goes in it?' } });
    const result = await call;
    if (!('replyId' in result)) throw new Error(`expected a reply result, got ${JSON.stringify(result)}`);
    expect(result.next).toContain(`--took ${result.replyId} question`);
    // Not by the approval's id or Q-n alone: that names the approval, not the reader.
    expect(() => queue.took({}, 'q50', 'question')).toThrow(/Only the agent reading/);
    expect(() => queue.took({ panelId: 'some-tab' }, 'Q-50', 'question')).toThrow(/Only the agent reading/);
    const took = queue.took({}, result.replyId, 'question');
    expect(took).toMatchObject({ took: 'question', id: 'q50' });
    // Its next step names the reply id too, since that's what this reader is known by.
    expect('next' in took && took.next).toContain(`--update ${result.replyId} `);
    const updated = queue.update({}, result.replyId, { asked: 'What goes in it?', whatChanged: 'Listed the commits', context: 'Eight commits since 2.4.215.' });
    expect(item(queue, 'q50')).toMatchObject({ version: 2, context: 'Eight commits since 2.4.215.' });
    queue.run({ type: 'answer', id: 'q50', answer: { picks: ['Tag it'] } });
    await vi.advanceTimersByTimeAsync(3_000);
    await expect(updated).resolves.toEqual({ answer: 'Tag it' });
  });

  it('F-6: the id a reader outside Pane continues with is in no snapshot, so another tab can\'t use what it sees', async () => {
    const outside: NotifySource = { name: 'release-scripts', agent: 'Claude', cwd: '/tmp/release' };
    const queue = queueWith();
    const call = queue.ask({ question: { ui: 'options', title: 'Q-50: Tag the release?', choices: [{ label: 'Tag it' }, { label: 'Wait' }] }, source: outside, id: 'q50' });
    queue.run({ type: 'answer', id: 'q50', answer: { picks: [], text: 'What goes in it?' } });
    const result = await call;
    if (!('replyId' in result)) throw new Error(`expected a reply result, got ${JSON.stringify(result)}`);
    const seen = item(queue, 'q50')?.reply?.id;
    if (!seen) throw new Error('expected the reply to be shared');
    // What every screen and phone gets never holds the continuation id.
    expect(JSON.stringify(queue.sharedState())).not.toContain(result.replyId);
    expect(JSON.stringify(queue.snapshot())).not.toContain(result.replyId);
    expect(() => queue.took({ panelId: 'some-tab' }, seen, 'answer')).toThrow(/Only the agent reading|no waiting approval/);
    expect(() => queue.update({ panelId: 'some-tab' }, seen, { asked: 'x', whatChanged: 'y' })).toThrow(/Only the agent reading|no waiting approval/);
    expect(() => queue.took({}, seen, 'answer')).toThrow(/Only the agent reading|no waiting approval/);
    expect(item(queue, 'q50')).toMatchObject({ state: 'answered', reply: { state: 'answer' } });
    expect(queue.took({}, result.replyId, 'answer')).toMatchObject({ took: 'answer', id: 'q50' });
  });

  it('an update answering a typed question must quote it; the asker\'s own update quotes nothing', async () => {
    const queue = restoredQ20();
    // The asker refreshes its own card (a loop's next run, say): no question of the person's to quote.
    queue.update({ panelId: 'orch' }, 'Q-20', { asked: '', whatChanged: 'Two more items' });
    expect(item(queue, 'q20')).toMatchObject({ version: 2, revision: { asked: '', whatChanged: ['Two more items'] } });

    queue.run({ type: 'answer', id: 'q20', answer: { picks: [], text: 'Which two?' } });
    await vi.advanceTimersByTimeAsync(1);
    queue.took({ panelId: 'orch' }, 'Q-20', 'question');
    expect(() => queue.update({ panelId: 'orch' }, 'Q-20', { asked: ' ', whatChanged: 'Named them' })).toThrow(/didn't say what it was/);
    expect(item(queue, 'q20')).toMatchObject({ version: 2 });
  });

  it('a dismissed card reopened by --took question counts as open for its Session again, and the row says so', async () => {
    const queue = restoredQ20();
    queue.run({ type: 'dismiss', id: 'q20' });
    expect(item(queue, 'q20')?.dismissedAt).toBeDefined();
    expect(store.readItem('q20')?.dismissedAt).toBeDefined();
    queue.run({ type: 'answer', id: 'q20', answer: { picks: [], text: 'Can it be undone?' } });
    await vi.advanceTimersByTimeAsync(1);
    expect(item(queue, 'q20')).toMatchObject({ state: 'answered', reply: { state: 'answer' } });

    queue.took({ panelId: 'orch' }, 'Q-20', 'question');
    expect(item(queue, 'q20')).toMatchObject({ state: 'waiting', reply: { state: 'question' } });
    expect(item(queue, 'q20')?.dismissedAt).toBeUndefined();
    expect(store.readItem('q20')?.dismissedAt).toBeUndefined();
  });

  it('J7: --took question, then --update makes v2 with the question, what changed and v1 kept', async () => {
    const queue = restoredQ20();
    queue.run({ type: 'answer', id: 'q20', answer: { picks: [], text: 'Can the switch be turned off again if the test goes badly?' } });
    await vi.advanceTimersByTimeAsync(1);
    expect(queue.took({ panelId: 'orch' }, 'Q-20', 'question')).toMatchObject({ took: 'question', id: 'q20' });
    expect(item(queue, 'q20')?.reply).toMatchObject({ state: 'question', status: 'Getting more context…' });

    const v1 = structuredClone(item(queue, 'q20'));
    const updated = queue.update({ panelId: 'orch' }, 'Q-20', {
      asked: 'Can the switch be turned off again if the test goes badly?',
      whatChanged: 'Reworded "Yes, turn it on"\nAdded "Yes, and turn it off after my test"\nRemoved "Gate each lower PR"',
      questions: [
        { title: q20.questions?.[0].title ?? '', choices: [{ label: 'Yes, turn it on', detail: 'One UPDATE; the reverse UPDATE turns it off at any time.' }, { label: 'Yes, and turn it off after my test' }, { label: 'Not yet' }] },
        { title: q20.questions?.[1].title ?? '', choices: [{ label: 'One train', recommended: true }] },
      ],
    });
    const v2 = item(queue, 'q20');
    expect(v2).toMatchObject({ state: 'waiting', version: 2, revision: { asked: 'Can the switch be turned off again if the test goes badly?', by: 'the Doozy orchestrator' } });
    expect(v2?.revision?.whatChanged).toHaveLength(3);
    expect(v2?.readyAgain).toBeDefined();
    expect(v2?.reply).toBeUndefined();
    expect(v2?.versions).toEqual([{ version: 1, title: v1?.title, context: v1?.context, questions: v1?.questions, at: v1?.createdAt }]);
    // Ready again: back in the pager, and a quiet notice on the strip.
    expect(queue.snapshot().queue).toContain('q20');
    expect(queue.snapshot().strip).toMatchObject({ kind: 'updated', itemId: 'q20' });

    queue.run({ type: 'answer', id: 'q20', answer: { picks: ['Yes, and turn it off after my test', 'One train'] } });
    await vi.advanceTimersByTimeAsync(3_000);
    await expect(updated).resolves.toEqual({ answer: 'Yes, and turn it off after my test · One train', answers: ['Yes, and turn it off after my test', 'One train'] });
    expect(item(queue, 'q20')?.readyAgain).toBeUndefined();
  });

  it('keeps at most 10 versions, folding the ones after the oldest', () => {
    const queue = restoredQ20();
    for (let round = 0; round < 12; round += 1) {
      void queue.update({ panelId: 'orch' }, 'q20', { asked: `question ${round}`, whatChanged: `change ${round}`, context: `context ${round}` });
    }
    const latest = item(queue, 'q20');
    expect(latest?.version).toBe(13);
    expect(latest?.versions).toHaveLength(9);
    expect(latest?.versions?.[0].version).toBe(1);
    expect(latest?.versions?.at(-1)?.version).toBe(12);
  });

  it('J8: "It was a question" reopens an answer and sends only a correction', async () => {
    const queue = restoredQ20();
    queue.run({ type: 'answer', id: 'q20', answer: { picks: ['Yes, turn it on', 'One train'], text: 'only if it can be undone' } });
    await vi.advanceTimersByTimeAsync(1);
    queue.took({ panelId: 'orch' }, 'Q-20', 'answer');
    queue.run({ type: 'fix-reply', id: 'q20', as: 'question' });
    await vi.advanceTimersByTimeAsync(1);
    expect(typed.map(([, text]) => text)).toEqual([
      'reply: Q-20 → "only if it can be undone" (picked: Yes, turn it on · One train) (by you)',
      'correction: Q-20 → that was a question: "only if it can be undone" (by you)',
    ]);
    expect(item(queue, 'q20')).toMatchObject({ state: 'waiting', reply: { state: 'question', fixed: 'question' } });
  });

  it('J8: "It was my answer" answers a reply taken as a question, with the typed text', async () => {
    const queue = restoredQ20();
    queue.run({ type: 'answer', id: 'q20', answer: { picks: [], text: 'Yes, one train' } });
    await vi.advanceTimersByTimeAsync(1);
    queue.took({ panelId: 'orch' }, 'Q-20', 'question');
    queue.run({ type: 'fix-reply', id: 'q20', as: 'answer' });
    await vi.advanceTimersByTimeAsync(1);
    expect(typed.map(([, text]) => text)).toEqual([
      'reply: Q-20 → "Yes, one train" (by you)',
      'correction: Q-20 → that was your answer: "Yes, one train" (by you)',
    ]);
    expect(item(queue, 'q20')).toMatchObject({ state: 'answered', answerSummary: 'Yes, one train', reply: { state: 'answer', fixed: 'answer' } });
  });

  it('J10: a relayed worker question stays open when only its tab closed, since its orchestrator can still read', () => {
    const queue = queueWith();
    queue.addWorkerQuestion({ id: 'in-1', question: 'Q-21: which region?', source: worker, at: Date.now() });
    void queue.ask({ relays: 'in-1', question: { ui: 'options', title: 'Q-21: which region?', choices: [{ label: 'eu-west' }, { label: 'us-east' }] }, source: orchestrator });
    expect(item(queue, 'in-1')?.relayedBy).toEqual({ panelId: 'orch', name: 'the Doozy orchestrator' });
    gone.set('w1', ASKING_TAB_CLOSED);
    tabs.set('w1', 'gone');
    queue.sweep();
    expect(item(queue, 'in-1')?.state).toBe('waiting');
  });

  it('a reply an older Pane delivered but nobody took becomes the answer on the next sweep, typed no second time', async () => {
    const first = queueWith();
    void first.ask({ question: q20, source: orchestrator, id: 'q20' });
    first.dispose();
    const saved = store.readItem('q20');
    if (!saved) throw new Error('expected q20 in the store');
    store.saveItem({ ...saved, reply: { id: 'r-old', text: 'Green', at: Date.now(), state: 'reading', reader: { kind: 'asker', panelId: 'orch', name: 'the Doozy orchestrator' }, deliveredAt: Date.now() } });
    const queue = queueWith();
    queue.sweep();
    await vi.advanceTimersByTimeAsync(1);
    expect(typed).toEqual([]);
    expect(item(queue, 'q20')).toMatchObject({ state: 'answered', answerSummary: 'Green', reply: { state: 'answer' } });
  });

  it('J10: a reply on a relayed worker question reaches the worker\'s tab and answers the relay call, like a pick', async () => {
    const queue = queueWith();
    queue.addWorkerQuestion({ id: 'in-1', question: 'Q-21: which region?', source: worker, at: Date.now() });
    const relay = queue.ask({ relays: 'in-1', question: { ui: 'ask', title: 'Q-21: which region?' }, source: orchestrator });
    queue.run({ type: 'answer', id: 'in-1', answer: { picks: [], text: 'eu-west' } });
    await vi.advanceTimersByTimeAsync(1);
    expect(typed).toEqual([['w1', 'reply: Q-21 → "eu-west" (by you)']]);
    await expect(relay).resolves.toEqual({ answer: 'eu-west' });
    expect(item(queue, 'in-1')).toMatchObject({ state: 'answered', answerSummary: 'eu-west', reply: { state: 'answer', reader: { kind: 'asker', panelId: 'w1' } } });
  });

  it('J10: a reply the worker gets between its relay\'s resume rounds reaches the next --resume as the answer', async () => {
    const queue = queueWith();
    queue.addWorkerQuestion({ id: 'in-1', question: 'Q-21: which region?', source: worker, at: Date.now() });
    const relay = queue.ask({ relays: 'in-1', question: { ui: 'ask', title: 'Q-21: which region?' }, source: orchestrator, returnAfterMs: 60_000 });
    await vi.advanceTimersByTimeAsync(60_000);
    await expect(relay).resolves.toMatchObject({ waiting: true, id: 'in-1' });
    queue.run({ type: 'answer', id: 'in-1', answer: { picks: [], text: 'eu-west' } });
    await vi.advanceTimersByTimeAsync(1);
    expect(typed).toEqual([['w1', 'reply: Q-21 → "eu-west" (by you)']]);
    await expect(queue.ask({ resume: 'in-1', source: orchestrator })).resolves.toEqual({ answer: 'eu-west' });
  });

  it('J10: a worker that takes a relayed reply as a question keeps its card open through the orchestrator\'s ack, and the orchestrator hears the real answer', async () => {
    const queue = queueWith();
    queue.addWorkerQuestion({ id: 'in-1', question: 'Q-21: which region?', source: worker, at: Date.now() });
    const relay = queue.ask({ relays: 'in-1', question: { ui: 'ask', title: 'Q-21: which region?' }, source: orchestrator });
    queue.run({ type: 'answer', id: 'in-1', answer: { picks: [], text: 'what is latency like in eu-west?' } });
    await vi.advanceTimersByTimeAsync(1);
    await expect(relay).resolves.toEqual({ answer: 'what is latency like in eu-west?' });
    expect(queue.took({ panelId: 'w1' }, 'Q-21', 'question')).toMatchObject({ took: 'question' });
    await vi.advanceTimersByTimeAsync(1);
    expect(typed).toContainEqual(['orch', 'reopened: Q-21 → doozy-overhaul took "what is latency like in eu-west?" as a question and is updating the card (by doozy-overhaul)']);
    // The orchestrator acks the answer its relay returned: the reopened card stays.
    queue.endWorkerQuestion('in-1', 'its orchestrator dealt with it', true);
    expect(item(queue, 'in-1')?.state).toBe('waiting');
    void queue.update({ panelId: 'w1' }, 'Q-21', { asked: 'what is latency like in eu-west?', whatChanged: 'Added latency per region', context: 'eu-west: 40 ms; us-east: 90 ms.' });
    queue.run({ type: 'answer', id: 'in-1', answer: { picks: [], text: 'eu-west' } });
    await vi.advanceTimersByTimeAsync(1);
    expect(item(queue, 'in-1')).toMatchObject({ state: 'answered', answerSummary: 'eu-west' });
    expect(typed).toContainEqual(['orch', 'correction: Q-21 → eu-west (by you)']);
  });

  it('J10: a late ack leaves a reopened worker card open while the person\'s reply to its new version waits for the worker', async () => {
    const queue = queueWith();
    queue.addWorkerQuestion({ id: 'in-1', question: 'Q-21: which region?', source: worker, at: Date.now() });
    void queue.ask({ relays: 'in-1', question: { ui: 'ask', title: 'Q-21: which region?' }, source: orchestrator });
    queue.run({ type: 'answer', id: 'in-1', answer: { picks: [], text: 'what is latency like in eu-west?' } });
    await vi.advanceTimersByTimeAsync(1);
    queue.took({ panelId: 'w1' }, 'Q-21', 'question');
    void queue.update({ panelId: 'w1' }, 'Q-21', { asked: 'what is latency like in eu-west?', whatChanged: 'Added latency per region' });
    tabs.set('w1', 'busy');
    queue.run({ type: 'answer', id: 'in-1', answer: { picks: [], text: 'eu-west then' } });
    await vi.advanceTimersByTimeAsync(1);
    expect(item(queue, 'in-1')?.reply?.state).toBe('reading');
    queue.endWorkerQuestion('in-1', 'its orchestrator dealt with it', true);
    expect(item(queue, 'in-1')?.state).toBe('waiting');
  });

  it('J10: an orchestrator that read the reply and updated the card gets the answer on its own call, with no correction line', async () => {
    const queue = queueWith();
    queue.addWorkerQuestion({ id: 'in-1', question: 'Q-21: which region?', source: worker, at: Date.now() });
    const relay = queue.ask({ relays: 'in-1', question: { ui: 'options', title: 'Q-21: which region?', choices: [{ label: 'eu' }, { label: 'us' }] }, source: orchestrator });
    gone.set('w1', ASKING_TAB_CLOSED);
    closedTabs.add('w1');
    queue.run({ type: 'answer', id: 'in-1', answer: { picks: [], text: 'what is latency like?' } });
    await vi.advanceTimersByTimeAsync(1);
    await expect(relay).resolves.toMatchObject({ reply: 'what is latency like?' });
    queue.took({ panelId: 'orch' }, 'Q-21', 'question');
    const updated = queue.update({ panelId: 'orch' }, 'Q-21', { asked: 'what is latency like?', whatChanged: 'Added latency per region' });
    queue.run({ type: 'answer', id: 'in-1', answer: { picks: ['eu'] } });
    await vi.advanceTimersByTimeAsync(3_000);
    await expect(updated).resolves.toEqual({ answer: 'eu' });
    expect(typed.filter(([panel]) => panel === 'orch')).toEqual([]);
  });

  it('a call in resume rounds that read a reply never gets it back as the answer after it was reopened', async () => {
    const queue = queueWith();
    const first = queue.ask({ question: q20, source: orchestrator, id: 'q20', returnAfterMs: 50_000 });
    await vi.advanceTimersByTimeAsync(50_000);
    await expect(first).resolves.toMatchObject({ waiting: true });
    const resumed = queue.ask({ resume: 'q20', source: orchestrator, returnAfterMs: 50_000 });
    queue.run({ type: 'answer', id: 'q20', answer: { picks: [], text: 'Can it be undone?' } });
    const result = await resumed;
    if (!('replyId' in result)) throw new Error(`expected a reply result, got ${JSON.stringify(result)}`);
    queue.took({}, result.replyId, 'question');
    const updated = queue.update({}, result.replyId, { asked: 'Can it be undone?', whatChanged: 'Added the undo path' }, 50_000);
    await vi.advanceTimersByTimeAsync(50_000);
    await expect(updated).resolves.toMatchObject({ waiting: true });
    let settled: NotifyResult | undefined;
    const next = queue.ask({ resume: 'q20', source: orchestrator, returnAfterMs: 50_000 });
    void next.then((value) => { settled = value; });
    await vi.advanceTimersByTimeAsync(1);
    expect(settled).toBeUndefined();
    queue.run({ type: 'answer', id: 'q20', answer: { picks: ['Yes, turn it on', 'One train'] } });
    await vi.advanceTimersByTimeAsync(3_000);
    await expect(next).resolves.toEqual({ answer: 'Yes, turn it on · One train', answers: ['Yes, turn it on', 'One train'] });
  });

  it('--took Q-n question reopens the newest answered card when a tab asked that Q-n twice', async () => {
    const queue = queueWith();
    const ask = (id: string, title: string) => queue.ask({ question: { ui: 'ask', title }, source: orchestrator, id });
    const first = ask('run-1', 'Q-1: first run?');
    queue.run({ type: 'answer', id: 'run-1', answer: { picks: [], text: 'yes' } });
    await first;
    await vi.advanceTimersByTimeAsync(60_000);
    const second = ask('run-2', 'Q-1: second run?');
    queue.run({ type: 'answer', id: 'run-2', answer: { picks: [], text: 'which one do you mean?' } });
    await second;
    expect(queue.took({ panelId: 'orch' }, 'Q-1', 'question')).toMatchObject({ took: 'question', id: 'run-2' });
    expect(item(queue, 'run-1')?.state).toBe('answered');
  });

  it('a loop\'s later run cannot reopen a card the person answered by typing, but still reaches its own and a waiting one', async () => {
    const queue = queueWith({ sameLoop: () => true });
    const run1: NotifySource = { name: 'nightly', agent: 'Claude', paneId: 'run-1', panelId: 'r1' };
    const run2: NotifySource = { name: 'nightly', agent: 'Claude', paneId: 'run-2', panelId: 'r2' };
    const asked = queue.ask({ question: { ui: 'ask', title: 'Q-1: ship tonight?' }, source: run1, id: 'first' });
    queue.run({ type: 'answer', id: 'first', answer: { picks: [], text: 'yes, after the backup' } });
    await asked;
    expect(() => queue.took({ paneId: 'run-2', panelId: 'r2' }, 'Q-1', 'question')).toThrow(/Only the agent reading/);
    expect(item(queue, 'first')).toMatchObject({ state: 'answered', answerSummary: 'yes, after the backup' });
    // Its own card with the same Q-n is still its own to reopen.
    const own = queue.ask({ question: { ui: 'ask', title: 'Q-1: ship tonight?' }, source: run2, id: 'second' });
    queue.run({ type: 'answer', id: 'second', answer: { picks: [], text: 'which build?' } });
    await own;
    expect(queue.took({ paneId: 'run-2', panelId: 'r2' }, 'Q-1', 'question')).toMatchObject({ took: 'question', id: 'second' });
    expect(item(queue, 'first')?.state).toBe('answered');
  });

  it('an agent cannot reopen a reply the person marked as their answer', async () => {
    const queue = restoredQ20();
    queue.run({ type: 'answer', id: 'q20', answer: { picks: [], text: 'One train' } });
    await vi.advanceTimersByTimeAsync(1);
    queue.took({ panelId: 'orch' }, 'Q-20', 'question');
    queue.run({ type: 'fix-reply', id: 'q20', as: 'answer' });
    expect(() => queue.took({ panelId: 'orch' }, 'Q-20', 'question')).toThrow(/no waiting approval/);
    expect(item(queue, 'q20')).toMatchObject({ state: 'answered', reply: { fixed: 'answer' } });
  });

  it('J10: with the asker gone, the reply goes to the relaying orchestrator; with that gone too, to Autopilot; else unread', async () => {
    const queue = queueWith();
    queue.addWorkerQuestion({ id: 'in-1', question: 'Q-21: which region?', source: worker, at: Date.now() });
    const relay = new AbortController();
    void queue.ask({ relays: 'in-1', question: { ui: 'ask', title: 'Q-21: which region?' }, source: orchestrator }, relay.signal);
    // The worker's tab is closed; the orchestrator's relay call still waits.
    gone.set('w1', ASKING_TAB_CLOSED);
    closedTabs.add('w1');
    tabs.set('w1', 'gone');
    queue.sweep();
    expect(item(queue, 'in-1')?.state).toBe('waiting');
    queue.run({ type: 'answer', id: 'in-1', answer: { picks: [], text: 'eu-west, but ask about latency' } });
    await vi.advanceTimersByTimeAsync(1);
    // Its relay call is open, so the reply is that call's result.
    expect(item(queue, 'in-1')?.reply?.reader).toEqual({ kind: 'orchestrator', name: 'the Doozy orchestrator' });
    expect(queue.took({ panelId: 'orch' }, 'Q-21', 'answer')).toMatchObject({ took: 'answer' });
  });

  it('J10: Autopilot reads when no one else can, and with Autopilot off the reply waits unread', async () => {
    const queue = restoredQ20();
    tabs.set('orch', 'gone');
    autopilot = { panelId: 'autopilot-chat' };
    queue.run({ type: 'answer', id: 'q20', answer: { picks: [], text: 'why?' } });
    await vi.advanceTimersByTimeAsync(1);
    expect(typed).toEqual([['autopilot-chat', 'reply: Q-20 → "why?" (by you)']]);
    expect(item(queue, 'q20')?.reply?.reader?.kind).toBe('autopilot');

    const other = restoredQ20();
    autopilot = undefined;
    tabs.set('orch', 'gone');
    other.run({ type: 'answer', id: 'q20', answer: { picks: [], text: 'why?' } });
    await vi.advanceTimersByTimeAsync(1);
    expect(item(other, 'q20')?.reply?.state).toBe('unread');
    // Picks still answer.
    other.run({ type: 'answer', id: 'q20', answer: { picks: ['Not yet', 'One train'] } });
    expect(item(other, 'q20')?.state).toBe('sent');
  });

  it('an unread reply goes to the first reader that comes back', async () => {
    const queue = restoredQ20();
    tabs.set('orch', 'gone');
    queue.run({ type: 'answer', id: 'q20', answer: { picks: [], text: 'why?' } });
    await vi.advanceTimersByTimeAsync(1);
    expect(item(queue, 'q20')?.reply?.state).toBe('unread');
    autopilot = { panelId: 'autopilot-chat' };
    queue.sweep();
    await vi.advanceTimersByTimeAsync(1);
    expect(typed).toEqual([['autopilot-chat', 'reply: Q-20 → "why?" (by you)']]);
    expect(item(queue, 'q20')).toMatchObject({ state: 'answered', reply: { state: 'answer', reader: { kind: 'autopilot' } } });
  });

  it('J11: --took and --update from an unrelated tab fail with a code and a next step, and change nothing', async () => {
    const queue = restoredQ20();
    queue.run({ type: 'answer', id: 'q20', answer: { picks: [], text: 'why?' } });
    await vi.advanceTimersByTimeAsync(1);
    const refused = (run: () => void): PaneError | undefined => {
      try {
        run();
      } catch (error) {
        if (error instanceof PaneError) return error;
        throw error;
      }
      return undefined;
    };
    const took = refused(() => queue.took({ panelId: 'stranger' }, 'Q-20', 'answer'));
    expect(took).toMatchObject({ code: 'ERR_NOTIFY_NOT_READER' });
    expect(took?.next).toBeTruthy();
    const updated = refused(() => { void queue.update({ panelId: 'stranger' }, 'Q-20', { asked: 'x', whatChanged: 'y' }); });
    expect(updated).toMatchObject({ code: 'ERR_NOTIFY_NOT_READER' });
    expect(item(queue, 'q20')).toMatchObject({ state: 'answered', reply: { state: 'answer' } });
    expect(item(queue, 'q20')?.version).toBeUndefined();
  });

  it('J12: a built-in question in a chat tab takes typed text as its answer, "Sent to" its agent', async () => {
    const queue = queueWith();
    const call = queue.ask({ id: 'chat:c1:q', question: { ui: 'options', title: 'Which tests?', choices: [{ label: 'Unit' }, { label: 'E2E' }], replyIsAnswer: true }, source: { ...orchestrator, panelId: 'c1', agent: 'Claude' } });
    queue.run({ type: 'answer', id: 'chat:c1:q', answer: { picks: [], text: 'Both, unit first' } });
    await vi.advanceTimersByTimeAsync(3_000);
    await expect(call).resolves.toEqual({ answer: 'Both, unit first' });
    expect(item(queue, 'chat:c1:q')).toMatchObject({ state: 'answered', reply: { state: 'sent', reader: { name: 'Claude' } } });
  });

  it('J12: a chat tab question that takes only its choices refuses typed text, and still takes a pick', async () => {
    const queue = queueWith();
    const call = queue.ask({ id: 'chat:c1:q', question: { ui: 'options', title: 'Which colour?', choices: [{ label: 'Red' }, { label: 'Blue' }], optionsOnly: true }, source: { ...orchestrator, panelId: 'c1' } });
    expect(() => queue.run({ type: 'answer', id: 'chat:c1:q', answer: { picks: [], text: 'Teal' } })).toThrow(/only one of its options/);
    expect(item(queue, 'chat:c1:q')).toMatchObject({ state: 'waiting' });
    queue.run({ type: 'answer', id: 'chat:c1:q', answer: { picks: ['Blue'] } });
    await vi.advanceTimersByTimeAsync(3_000);
    await expect(call).resolves.toEqual({ answer: 'Blue' });
  });

  it('F-2: a reply still waiting for a busy tab is replaced, and only the newer line is ever typed', async () => {
    const queue = restoredQ20();
    tabs.set('orch', 'busy');
    queue.run({ type: 'answer', id: 'q20', answer: { picks: [], text: 'A' } });
    await vi.advanceTimersByTimeAsync(1);
    queue.run({ type: 'answer', id: 'q20', answer: { picks: [], text: 'B' } });
    await vi.advanceTimersByTimeAsync(1);
    tabs.set('orch', 'delivered');
    queue.flushTabMessages();
    await vi.advanceTimersByTimeAsync(1);
    expect(typed).toEqual([['orch', 'reply: Q-20 → "B" (by you)']]);
  });

  it('F-2: a second reply is refused while the first is still being typed into its reader\'s tab', async () => {
    let release: (outcome: 'delivered') => void = () => undefined;
    const queue = (() => {
      const first = queueWith();
      void first.ask({ question: q20, source: orchestrator, id: 'q20' });
      first.dispose();
      return queueWith({
        typeIntoTab: (panelId, text) => new Promise((resolve) => {
          release = (outcome) => {
            typed.push([panelId, text]);
            resolve(outcome);
          };
        }),
      });
    })();
    queue.run({ type: 'answer', id: 'q20', answer: { picks: [], text: 'A: Do not proceed' } });
    await vi.advanceTimersByTimeAsync(1);
    // A is on its way into the tab: B can't replace it.
    expect(() => queue.run({ type: 'answer', id: 'q20', answer: { picks: [], text: 'B: What will be deleted?' } })).toThrow(/getting your last reply/);
    release('delivered');
    await vi.advanceTimersByTimeAsync(1);
    expect(typed).toEqual([['orch', 'reply: Q-20 → "A: Do not proceed" (by you)']]);
    expect(item(queue, 'q20')).toMatchObject({ state: 'answered', answerSummary: 'A: Do not proceed' });
  });

  it('F-2: a line its tab turned away as busy releases the reply, so a newer one can replace it', async () => {
    let outcome: 'busy' | 'delivered' = 'busy';
    const queue = (() => {
      const first = queueWith();
      void first.ask({ question: q20, source: orchestrator, id: 'q20' });
      first.dispose();
      return queueWith({
        typeIntoTab: async (panelId, text) => {
          if (outcome === 'delivered') typed.push([panelId, text]);
          return outcome;
        },
      });
    })();
    queue.run({ type: 'answer', id: 'q20', answer: { picks: [], text: 'A' } });
    await vi.advanceTimersByTimeAsync(1);
    // Turned away as busy, A was never typed: B replaces it.
    queue.run({ type: 'answer', id: 'q20', answer: { picks: [], text: 'B' } });
    await vi.advanceTimersByTimeAsync(1);
    outcome = 'delivered';
    queue.flushTabMessages();
    await vi.advanceTimersByTimeAsync(1);
    expect(typed).toEqual([['orch', 'reply: Q-20 → "B" (by you)']]);
  });

  it('F-3: partial picks keep their positions, in the line, the record and an open call\'s result', async () => {
    const queue = queueWith();
    const call = queue.ask({ question: q20, source: orchestrator, id: 'q20' });
    queue.run({ type: 'answer', id: 'q20', answer: { picks: ['', 'One train'], text: 'Only the train for now' } });
    await expect(call).resolves.toMatchObject({ reply: 'Only the train for now', picks: ['', 'One train'] });
    expect(item(queue, 'q20')?.reply?.picks).toEqual(['', 'One train']);
    const restored = restoredQ20();
    restored.run({ type: 'answer', id: 'q20', answer: { picks: ['', 'One train'], text: 'Only the train' } });
    await vi.advanceTimersByTimeAsync(1);
    expect(typed.at(-1)).toEqual(['orch', 'reply: Q-20 → "Only the train" (picked: — · One train) (by you)']);
  });

  it('F-7: an updated version gets its own 15 minutes to wait, counted from the update', async () => {
    const queue = restoredQ20();
    queue.run({ type: 'answer', id: 'q20', answer: { picks: [], text: 'why?' } });
    await vi.advanceTimersByTimeAsync(1);
    queue.took({ panelId: 'orch' }, 'Q-20', 'question');
    await vi.advanceTimersByTimeAsync(16 * 60_000);
    const updated = queue.update({ panelId: 'orch' }, 'Q-20', { asked: 'why?', whatChanged: 'Explained', context: 'Because.' }, 50_000);
    await vi.advanceTimersByTimeAsync(50_000);
    await expect(updated).resolves.toMatchObject({ waiting: true, id: 'q20' });
    expect(item(queue, 'q20')?.state).toBe('waiting');
  });

  it('J21: versions, the reply state and how it was taken survive a restart', async () => {
    const queue = restoredQ20();
    queue.run({ type: 'answer', id: 'q20', answer: { picks: [], text: 'why?' } });
    await vi.advanceTimersByTimeAsync(1);
    queue.took({ panelId: 'orch' }, 'Q-20', 'question');
    void queue.update({ panelId: 'orch' }, 'Q-20', { asked: 'why?', whatChanged: 'Explained the switch' , context: 'Because.' });
    queue.dispose();
    const after = queueWith();
    expect(item(after, 'q20')).toMatchObject({ version: 2, context: 'Because.', revision: { asked: 'why?' }, versions: [{ version: 1 }] });
    await vi.advanceTimersByTimeAsync(1);
    expect(typed).toHaveLength(1);
  });

  it('a note on a picked answer is no longer dropped from its line', async () => {
    const queue = restoredQ20();
    const single = queueWith();
    void single.ask({ question: { ui: 'options', title: 'Q-4: ship?', choices: [{ label: 'Yes' }, { label: 'No' }] }, source: orchestrator, id: 'q4' });
    single.dispose();
    const after = queueWith();
    after.run({ type: 'answer', id: 'q4', answer: { choice: 'Yes', note: 'after lunch' } });
    await vi.advanceTimersByTimeAsync(3_000);
    expect(typed).toContainEqual(['orch', 'answer: Q-4 → Yes — "after lunch" (by you)']);
    queue.dispose();
  });
  describe('a Q-n two Sessions share, read by Autopilot', () => {
    const otherSession = { id: 's2', name: 'Firecracker Grain', paneId: 'sp2', orchestrator: true };
    const otherOrchestrator: NotifySource = { name: 'Session: Firecracker Grain', agent: 'Claude', paneId: 'sp2', panelId: 'orch2', session: otherSession };
    const q1 = (title: string): NotifyQuestion => ({ ui: 'options', title: `Q-1: ${title}`, choices: [{ label: 'Yes', recommended: true }, { label: 'No' }] });
    /** Each Session's orchestrator asks its own Q-1, then its tab closes, so Autopilot reads what the person types. */
    const twoQ1s = () => {
      const first = queueWith();
      void first.ask({ question: q1('Ship the Doozy build?'), source: orchestrator, id: 'a1' });
      void first.ask({ question: q1('Merge the Grain fix?'), source: otherOrchestrator, id: 'b1' });
      first.dispose();
      tabs.set('orch', 'gone');
      tabs.set('orch2', 'gone');
      autopilot = { panelId: 'autopilot-chat' };
      return queueWith();
    };
    const refusal = (run: () => void): PaneError => {
      try {
        run();
      } catch (error) {
        if (error instanceof PaneError) return error;
        throw error;
      }
      throw new Error('expected a refusal');
    };

    it('refuses --took and --update by Q-n when both replies went to Autopilot, names both ids, and changes nothing', async () => {
      const queue = twoQ1s();
      queue.run({ type: 'answer', id: 'a1', answer: { picks: [], text: 'why?' } });
      queue.run({ type: 'answer', id: 'b1', answer: { picks: [], text: 'what for?' } });
      await vi.advanceTimersByTimeAsync(1);
      expect(item(queue, 'a1')?.reply?.reader?.kind).toBe('autopilot');
      expect(item(queue, 'b1')?.reply?.reader?.kind).toBe('autopilot');
      const before = [item(queue, 'a1'), item(queue, 'b1')];

      const took = refusal(() => queue.took({ panelId: 'autopilot-chat' }, 'Q-1', 'question'));
      expect(took.code).toBe('ERR_NOTIFY_AMBIGUOUS');
      expect(took.message).toContain('a1');
      expect(took.message).toContain('b1');
      expect(took.next).toMatch(/id/);
      const update = refusal(() => queue.update({ panelId: 'autopilot-chat' }, 'Q-1', { asked: 'why?', whatChanged: ['Said why'] }));
      expect(update.code).toBe('ERR_NOTIFY_AMBIGUOUS');
      expect([item(queue, 'a1'), item(queue, 'b1')]).toEqual(before);

      // Its id still names one card.
      expect(queue.took({ panelId: 'autopilot-chat' }, 'b1', 'question')).toMatchObject({ took: 'question', id: 'b1' });
      expect(item(queue, 'a1')).toEqual(before[0]);
      queue.dispose();
    });

    it('F-1: refuses a Q-1 Autopilot itself asked about two Sessions, both replies taken as answers, naming both ids', async () => {
      const autopilotSource: NotifySource = { name: 'Autopilot', agent: 'Claude', panelId: 'autopilot-chat', autopilot: true };
      const first = queueWith();
      void first.ask({ question: { ...q1('Ship the Doozy build?'), connected: { kind: 'session', id: session.id, name: session.name, paneId: session.paneId } }, source: autopilotSource, id: 'ap-a' });
      void first.ask({ question: { ...q1('Merge the Grain fix?'), connected: { kind: 'session', id: otherSession.id, name: otherSession.name, paneId: otherSession.paneId } }, source: autopilotSource, id: 'ap-b' });
      first.dispose();
      const queue = queueWith();
      queue.run({ type: 'answer', id: 'ap-a', answer: { picks: [], text: 'only after lunch' } });
      queue.run({ type: 'answer', id: 'ap-b', answer: { picks: [], text: 'what for?' } });
      await vi.advanceTimersByTimeAsync(1);
      expect(item(queue, 'ap-a')?.reply).toMatchObject({ state: 'answer', reader: { panelId: 'autopilot-chat' } });
      expect(item(queue, 'ap-b')?.reply).toMatchObject({ state: 'answer', reader: { panelId: 'autopilot-chat' } });
      const before = [item(queue, 'ap-a'), item(queue, 'ap-b')];

      const took = refusal(() => queue.took({ panelId: 'autopilot-chat' }, 'Q-1', 'question'));
      expect(took.code).toBe('ERR_NOTIFY_AMBIGUOUS');
      expect(took.message).toContain('ap-a (Doozy)');
      expect(took.message).toContain('ap-b (Firecracker Grain)');
      expect(refusal(() => queue.update({ panelId: 'autopilot-chat' }, 'Q-1', { asked: 'why?', whatChanged: ['Said why'] })).code).toBe('ERR_NOTIFY_AMBIGUOUS');
      expect([item(queue, 'ap-a'), item(queue, 'ap-b')]).toEqual(before);
      queue.dispose();
    });

    it('takes the card whose reply went to Autopilot when the other Session\'s Q-1 only waits', async () => {
      const queue = twoQ1s();
      queue.run({ type: 'answer', id: 'b1', answer: { picks: [], text: 'what for?' } });
      await vi.advanceTimersByTimeAsync(1);
      expect(item(queue, 'a1')?.reply).toBeUndefined();
      expect(queue.took({ panelId: 'autopilot-chat' }, 'Q-1', 'question')).toMatchObject({ took: 'question', id: 'b1' });
      expect(item(queue, 'a1')?.state).toBe('waiting');
      queue.dispose();
    });
  });
});
