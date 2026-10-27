import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NotifyQueue } from './notifyQueue';
import { DEFAULT_NOTIFY_SETTINGS, type NotifyQuestion, type NotifyResult, type NotifySettings } from '../../../../shared/types/notify';

const claude = { paneId: 'pane-1', panelId: 'panel-1', name: 'auth-refactor', agent: 'Claude' };
const codex = { paneId: 'pane-2', panelId: 'panel-2', name: 'billing-migration', agent: 'Codex' };
const sessionStore: NotifyQuestion = {
  ui: 'options',
  title: 'Which session store should the refactor use?',
  choices: [{ label: 'Postgres table', recommended: true }, { label: 'Keep Redis' }, { label: 'Stateless JWT' }],
};
const migration: NotifyQuestion = { ui: 'approve', title: 'Apply migration 0042 to staging?', detail: 'ALTER TABLE …' };

function makeQueue(overrides: Partial<NotifySettings> = {}) {
  let settings: NotifySettings = { ...DEFAULT_NOTIFY_SETTINGS, ...overrides };
  const queue = new NotifyQueue({ settings: () => settings, showOutsideSupported: true, shortcutRegistered: () => true });
  return {
    queue,
    setSettings: (next: Partial<NotifySettings>) => { settings = { ...settings, ...next }; },
  };
}

/** Starts a call and records its result when it settles. */
function ask(queue: NotifyQueue, question: NotifyQuestion, source = claude, extra: { returnAfterMs?: number; signal?: AbortSignal } = {}) {
  const results: NotifyResult[] = [];
  void queue.ask({ question, source, returnAfterMs: extra.returnAfterMs }, extra.signal).then((result) => results.push(result));
  return { get result() { return results[0]; } };
}

function onlyId(queue: NotifyQueue): string {
  const [id] = queue.snapshot().queue;
  return id;
}

describe('NotifyQueue', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 9, 26, 9, 41));
  });
  afterEach(() => vi.useRealTimers());

  it('shows one question at a time, oldest first, and the next one after an answer', async () => {
    const { queue } = makeQueue();
    const first = ask(queue, sessionStore, claude);
    vi.advanceTimersByTime(1_000);
    ask(queue, migration, codex);

    const [firstId, secondId] = queue.snapshot().queue;
    expect(queue.snapshot().strip).toEqual({ kind: 'question', itemId: firstId });

    queue.run({ type: 'answer', id: firstId, answer: { choice: 'Postgres table' } });
    expect(queue.snapshot().strip).toEqual({ kind: 'sent', itemId: firstId });
    expect(queue.snapshot().queue).toEqual([secondId]);

    await vi.advanceTimersByTimeAsync(3_000);
    expect(first.result).toEqual({ answer: 'Postgres table' });
    expect(queue.snapshot().strip).toEqual({ kind: 'question', itemId: secondId });
  });

  it('holds an answer 3 seconds, and Undo brings the question back with nothing sent', async () => {
    const { queue } = makeQueue();
    const call = ask(queue, migration);
    const id = onlyId(queue);

    queue.run({ type: 'answer', id, answer: { approved: false, note: 'Not on a Friday' } });
    await vi.advanceTimersByTimeAsync(2_900);
    expect(call.result).toBeUndefined();
    queue.run({ type: 'undo', id });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(call.result).toBeUndefined();
    expect(queue.snapshot().strip).toEqual({ kind: 'question', itemId: id });

    queue.run({ type: 'answer', id, answer: { approved: true } });
    await vi.advanceTimersByTimeAsync(3_000);
    expect(call.result).toEqual({ approved: true });
    expect(queue.snapshot().items.find(item => item.id === id)).toMatchObject({ state: 'answered', answerSummary: 'Approved' });
  });

  it('expires a question when the caller disconnects and says so on the strip for 3 seconds', async () => {
    const { queue } = makeQueue();
    const controller = new AbortController();
    const call = ask(queue, sessionStore, claude, { signal: controller.signal });
    const id = onlyId(queue);

    controller.abort();
    await vi.advanceTimersByTimeAsync(0);
    expect(call.result).toMatchObject({ unavailable: expect.any(String) });
    expect(queue.snapshot().strip).toEqual({ kind: 'expired', itemId: id });
    expect(queue.snapshot().queue).toEqual([]);

    await vi.advanceTimersByTimeAsync(3_000);
    expect(queue.snapshot().strip).toBeNull();
    expect(queue.snapshot().items.find(item => item.id === id)?.state).toBe('expired');
  });

  it('skips a question to the back of the queue and brings a reminded one back later', async () => {
    const { queue } = makeQueue();
    ask(queue, sessionStore, claude);
    ask(queue, migration, codex);
    const [first, second] = queue.snapshot().queue;

    queue.run({ type: 'skip', id: first });
    expect(queue.snapshot().queue).toEqual([second, first]);

    queue.run({ type: 'remind', id: second, after: '10m' });
    expect(queue.snapshot().strip).toEqual({ kind: 'question', itemId: first });
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(queue.snapshot().strip).toEqual({ kind: 'question', itemId: second });
  });

  it('brings a "when I switch to Pane" reminder back when Pane comes to the front, inside Pane', () => {
    const { queue } = makeQueue();
    ask(queue, sessionStore);
    const id = onlyId(queue);

    queue.run({ type: 'remind', id, after: 'pane' });
    expect(queue.snapshot().strip).toBeNull();
    queue.setPaneFocused(true);
    expect(queue.snapshot()).toMatchObject({ strip: { kind: 'question', itemId: id }, stripSurface: 'pane' });
  });

  it('returns unavailable at once while Notify is off, and to every waiting agent when it is turned off', async () => {
    const { queue, setSettings } = makeQueue({ enabled: false });
    expect(await queue.ask({ question: sessionStore, source: claude })).toEqual({ unavailable: 'Notify is off in Pane.', next: 'Ask in the terminal instead.' });

    setSettings({ enabled: true });
    const first = ask(queue, sessionStore, claude);
    const second = ask(queue, migration, codex);
    setSettings({ enabled: false });
    queue.turnOff();
    await vi.advanceTimersByTimeAsync(0);

    expect(first.result).toEqual({ unavailable: 'Notify was turned off in Pane.', next: 'Ask in the terminal instead.' });
    expect(second.result).toEqual({ unavailable: 'Notify was turned off in Pane.', next: 'Ask in the terminal instead.' });
    expect(queue.snapshot()).toMatchObject({ queue: [], strip: null });
  });

  it('shows an update on screen when nothing else is up, and sends it to the inbox while a question shows', async () => {
    const { queue } = makeQueue({ updatesHideAfterSeconds: 6 });
    const checks: NotifyQuestion = { ui: 'info', title: 'PR #812 checks passed' };

    expect(await queue.ask({ question: checks, source: claude })).toEqual({ delivered: 'screen' });
    expect(queue.snapshot().strip).toMatchObject({ kind: 'info' });
    await vi.advanceTimersByTimeAsync(6_000);
    expect(queue.snapshot().strip).toBeNull();

    ask(queue, sessionStore);
    expect(await queue.ask({ question: checks, source: claude })).toEqual({ delivered: 'inbox' });
    expect(queue.snapshot().strip).toMatchObject({ kind: 'question' });
  });

  it('pauses the countdown of an update while it is hovered', async () => {
    const { queue } = makeQueue({ updatesHideAfterSeconds: 6 });
    await queue.ask({ question: { ui: 'info', title: 'Deploy finished' }, source: claude });
    const id = queue.snapshot().items[0].id;

    queue.run({ type: 'hover-info', id, hovering: true });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(queue.snapshot().strip).toMatchObject({ kind: 'info', itemId: id, hideAt: null });
    queue.run({ type: 'hover-info', id, hovering: false });
    await vi.advanceTimersByTimeAsync(6_000);
    expect(queue.snapshot().strip).toBeNull();
  });

  it('keeps a short-limit client waiting through resume calls, then gives up after 15 minutes', async () => {
    const { queue } = makeQueue();
    let result = await (async () => {
      const call = queue.ask({ question: sessionStore, source: claude, returnAfterMs: 50_000 });
      await vi.advanceTimersByTimeAsync(50_000);
      return call;
    })();
    expect(result).toMatchObject({ waiting: true });
    const id = 'id' in result ? result.id : '';

    for (let elapsed = 50_000; elapsed < 15 * 60_000;) {
      const call = queue.ask({ resume: id, source: claude, returnAfterMs: 50_000 });
      await vi.advanceTimersByTimeAsync(50_000);
      elapsed += 50_000;
      result = await call;
      if (!('waiting' in result)) break;
      expect(queue.snapshot().strip).toEqual({ kind: 'question', itemId: id });
    }
    expect(result).toEqual({ unavailable: 'Nobody answered within 15 minutes.', next: 'Ask in the terminal instead.' });
    expect(queue.snapshot().items.find(item => item.id === id)?.state).toBe('expired');
  });

  it('delivers an answer given between two resume calls to the next one', async () => {
    const { queue } = makeQueue();
    const first = queue.ask({ question: sessionStore, source: claude, returnAfterMs: 50_000 });
    await vi.advanceTimersByTimeAsync(50_000);
    const waiting = await first;
    const id = 'id' in waiting ? waiting.id : '';

    queue.run({ type: 'answer', id, answer: { choice: 'Keep Redis', note: 'ops is busy' } });
    await vi.advanceTimersByTimeAsync(3_000);
    expect(await queue.ask({ resume: id, source: claude, returnAfterMs: 50_000 })).toEqual({ answer: 'Keep Redis', note: 'ops is busy' });
  });

  it('expires a question when no resume arrives', async () => {
    const { queue } = makeQueue();
    const first = queue.ask({ question: sessionStore, source: claude, returnAfterMs: 50_000 });
    await vi.advanceTimersByTimeAsync(50_000);
    const waiting = await first;
    const id = 'id' in waiting ? waiting.id : '';

    await vi.advanceTimersByTimeAsync(60_000);
    expect(queue.snapshot().items.find(item => item.id === id)?.state).toBe('expired');
    expect(await queue.ask({ resume: id, source: claude })).toMatchObject({ unavailable: expect.any(String) });
  });

  it('expires a question whose agent sits idle at its prompt for 10 seconds', async () => {
    const { queue } = makeQueue();
    const call = ask(queue, sessionStore, claude);

    queue.panelStatus('panel-1', true);
    await vi.advanceTimersByTimeAsync(5_000);
    queue.panelStatus('panel-1', false);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(call.result).toBeUndefined();

    queue.panelStatus('panel-1', true);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(call.result).toMatchObject({ unavailable: expect.any(String) });
  });

  it('clears Earlier today at local midnight', async () => {
    const { queue } = makeQueue();
    ask(queue, sessionStore);
    const id = onlyId(queue);
    queue.run({ type: 'answer', id, answer: { choice: 'Stateless JWT' } });
    await vi.advanceTimersByTimeAsync(3_000);
    expect(queue.snapshot().items.map(item => item.answerSummary)).toEqual(['Stateless JWT']);

    vi.setSystemTime(new Date(2026, 9, 26, 23, 59, 59));
    expect(queue.snapshot().items).toHaveLength(1);
    vi.setSystemTime(new Date(2026, 9, 27, 0, 0, 1));
    expect(queue.snapshot().items).toEqual([]);
  });

  it('chooses where the strip shows from focus, Show outside Pane, Pause and the round', () => {
    const { queue, setSettings } = makeQueue();
    ask(queue, sessionStore);
    expect(queue.snapshot().stripSurface).toBe('window');

    queue.setPaneFocused(true);
    expect(queue.snapshot().stripSurface).toBe('pane');
    queue.setPaneFocused(false);
    setSettings({ showOutsidePane: false });
    expect(queue.snapshot().stripSurface).toBeNull();

    setSettings({ showOutsidePane: true });
    queue.run({ type: 'pause', minutes: 60 });
    expect(queue.snapshot()).toMatchObject({ stripSurface: null, pausedUntil: expect.any(Number) });
    vi.advanceTimersByTime(60 * 60_000);
    expect(queue.snapshot().stripSurface).toBe('window');

    queue.setRoundOpen(true);
    expect(queue.snapshot().stripSurface).toBeNull();
  });

  it('rejects an answer that is not one of the choices', () => {
    const { queue } = makeQueue();
    ask(queue, sessionStore);
    expect(() => queue.run({ type: 'answer', id: onlyId(queue), answer: { choice: 'MongoDB' } })).toThrow(/doesn't fit/);
  });
});
