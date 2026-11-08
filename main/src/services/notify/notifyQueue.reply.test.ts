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
    settings: () => DEFAULT_NOTIFY_SETTINGS,
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

  it('J6: typed text is a reply, typed once into the asker\'s tab, and --took answer records it with the note', async () => {
    const queue = restoredQ20();
    queue.run({ type: 'answer', id: 'q20', answer: { picks: ['Yes, turn it on', 'One train'], text: 'Turn it on only if it can be undone' } });
    await vi.advanceTimersByTimeAsync(1);
    expect(typed).toEqual([['orch', 'reply: Q-20 → "Turn it on only if it can be undone" (picked: Yes, turn it on · One train) (by you)']]);
    expect(item(queue, 'q20')).toMatchObject({ state: 'waiting', reply: { state: 'reading', reader: { kind: 'asker', panelId: 'orch' } } });
    expect(item(queue, 'q20')?.reply?.deliveredAt).toBeDefined();
    // Being read: the pager moves past it.
    expect(queue.snapshot().queue).not.toContain('q20');

    expect(queue.took({ panelId: 'orch' }, 'Q-20', 'answer')).toEqual({ took: 'answer', id: 'q20' });
    expect(item(queue, 'q20')).toMatchObject({ state: 'answered', reply: { state: 'answer' }, answerSummary: 'Yes, turn it on · One train — "Turn it on only if it can be undone"' });
    queue.sweep();
    await vi.advanceTimersByTimeAsync(1);
    expect(typed).toHaveLength(1);
  });

  it('J6: a busy tab gets the reply when it is next idle, still once', async () => {
    const queue = restoredQ20();
    tabs.set('orch', 'busy');
    queue.run({ type: 'answer', id: 'q20', answer: { picks: [], text: 'Why one train?' } });
    await vi.advanceTimersByTimeAsync(1);
    expect(typed).toEqual([]);
    expect(item(queue, 'q20')?.reply?.deliveredAt).toBeUndefined();
    queue.sweep();
    await vi.advanceTimersByTimeAsync(1);
    tabs.set('orch', 'delivered');
    queue.flushTabMessages();
    await vi.advanceTimersByTimeAsync(1);
    expect(typed).toEqual([['orch', 'reply: Q-20 → "Why one train?" (by you)']]);
  });

  it('returns a reply to an open call, which ends while the approval keeps waiting', async () => {
    const queue = queueWith();
    const call = queue.ask({ question: q20, source: orchestrator, id: 'q20' });
    queue.run({ type: 'answer', id: 'q20', answer: { picks: [], text: 'Can it be undone?' } });
    const result: NotifyResult = await call;
    expect(result).toMatchObject({ reply: 'Can it be undone?', id: 'q20' });
    expect('next' in result && result.next).toMatch(/--took q20 answer/);
    expect(typed).toEqual([]);
    expect(item(queue, 'q20')).toMatchObject({ state: 'waiting', reply: { state: 'reading', reader: { kind: 'asker' } } });
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
    expect(v2).toMatchObject({ state: 'waiting', version: 2, revision: { asked: 'Can the switch be turned off again if the test goes badly?', by: 'Session: Doozy' } });
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

  it('passes a reply its reader leaves unread for 10 minutes to Autopilot', async () => {
    const queue = restoredQ20();
    queue.run({ type: 'answer', id: 'q20', answer: { picks: [], text: 'why?' } });
    await vi.advanceTimersByTimeAsync(1);
    autopilot = { panelId: 'autopilot-chat' };
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    queue.sweep();
    await vi.advanceTimersByTimeAsync(1);
    expect(typed.map(([panel]) => panel)).toEqual(['orch', 'autopilot-chat']);
    expect(queue.took({ panelId: 'autopilot-chat' }, 'Q-20', 'answer')).toMatchObject({ took: 'answer' });
  });

  it('J11: --took and --update from an unrelated tab fail with a code and a next step, and change nothing', async () => {
    const queue = restoredQ20();
    queue.run({ type: 'answer', id: 'q20', answer: { picks: [], text: 'why?' } });
    await vi.advanceTimersByTimeAsync(1);
    const refused = (run: () => unknown) => {
      try {
        run();
      } catch (error) {
        return error;
      }
      return undefined;
    };
    const took = refused(() => queue.took({ panelId: 'stranger' }, 'Q-20', 'answer'));
    expect(took).toBeInstanceOf(PaneError);
    expect(took).toMatchObject({ code: 'ERR_NOTIFY_NOT_READER' });
    expect((took as PaneError).next).toBeTruthy();
    const updated = refused(() => queue.update({ panelId: 'stranger' }, 'Q-20', { asked: 'x', whatChanged: 'y' }));
    expect(updated).toMatchObject({ code: 'ERR_NOTIFY_NOT_READER' });
    expect(item(queue, 'q20')).toMatchObject({ state: 'waiting', reply: { state: 'reading' } });
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
});
