import { describe, expect, it } from 'vitest';
import { GlassesApp } from '../src/app';
import { DemoSource } from '../src/demo';
import type { Page } from '../src/display';
import type { Gesture } from '../src/input';
import { orderCards, type Card, type Computer, type Dictation, type PaneEntry, type PaneRow, type PaneSource, type TerminalScreen } from '../src/model';
import type { Cancel } from '../src/timers';

/** Timers the test runs by hand. */
class Clock {
  now = 1_800_000_000_000;
  private tasks: Array<{ at: number; fn: () => void; every?: number; cancelled: boolean }> = [];

  later = (fn: () => void, ms: number): Cancel => this.add(fn, ms);
  every = (fn: () => void, ms: number): Cancel => this.add(fn, ms, ms);

  private add(fn: () => void, ms: number, every?: number): Cancel {
    const task = { at: this.now + ms, fn, every, cancelled: false };
    this.tasks.push(task);
    return { cancel: () => { task.cancelled = true; } };
  }

  async advance(ms: number): Promise<void> {
    const end = this.now + ms;
    for (;;) {
      const next = this.tasks.filter((task) => !task.cancelled && task.at <= end).sort((a, b) => a.at - b.at)[0];
      if (!next) break;
      this.now = next.at;
      if (next.every) next.at += next.every;
      else next.cancelled = true;
      next.fn();
      await settle();
    }
    this.now = end;
  }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

function start() {
  const clock = new Clock();
  const source = new DemoSource(clock.every, () => clock.now);
  const pages: Page[] = [];
  const mic: boolean[] = [];
  let exits = 0;
  const app = new GlassesApp({
    source,
    show: (page) => pages.push(page),
    exit: () => { exits += 1; },
    mic: async (on) => { mic.push(on); return true; },
    later: clock.later,
    now: () => clock.now,
    clock: () => '9:40',
  });
  const text = () => (pages.at(-1)?.boxes ?? []).map((box) => (box.kind === 'list' ? box.items.join(' | ') : box.lines.join(' / ')));
  const press = async (gesture: Gesture) => {
    app.handle(gesture);
    await settle();
  };
  return { app, source, clock, text, press, mic, exits: () => exits };
}

describe('home', () => {
  it('shows questions first, newest first, then info cards, then "Open a Pane…"', async () => {
    const { text, press } = start();
    const headers: string[] = [];
    for (let page = 0; page < 6; page += 1) {
      headers.push(text()[0] ?? '');
      await press({ type: 'down' });
    }
    expect(headers).toEqual([
      '1/6 · needs you · fix-login · studio-mac',
      '2/6 · needs you · token-refresh · studio-mac',
      '3/6 · needs you · Planner · studio-mac',
      '4/6 · info · docs-pass · devbox',
      '5/6 · info · nightly · studio-mac',
      '6/6 · Pane · 3 computers',
    ]);
    expect(text()[0]).toBe('6/6 · Pane · 3 computers');
  });

  it('exits on double press', async () => {
    const { press, exits } = start();
    await press({ type: 'double' });
    expect(exits()).toBe(1);
  });
});

describe('answering', () => {
  it('answers by ring, removes the card and confirms on the next page', async () => {
    const { text, press, source } = start();
    await press({ type: 'press' });
    expect(text().at(-1)).toBe('Stub the clock | Loosen retry | Something else (hold to say it)');
    expect(text()[0]).toContain('The refresh mock returns 401');
    await press({ type: 'select', index: 1 });
    expect(source.cards().map((card) => card.paneName)).not.toContain('fix-login');
    expect(text()[0]).toBe('1/5 · needs you · token-refresh · studio-mac');
    expect(text()[1]).toBe('Answered fix-login: Loosen retry');
  });

  it('answers by voice: hold listens, release sends the words at once', async () => {
    const { text, press, clock, mic, source } = start();
    await press({ type: 'hold' });
    expect(text()[0]).toBe('Answering fix-login · listening');
    await clock.advance(1_400);
    expect(text()[1]).toBe('● stub the clock and');
    await press({ type: 'release' });
    await settle();
    expect(mic).toEqual([true, false]);
    expect(source.cards().map((card) => card.paneName)).not.toContain('fix-login');
    expect(text()[1]?.replace(' / ', ' ')).toBe('Answered fix-login: "stub the clock and rerun only the auth suite"');
  });

  it('never turns the microphone on for a hold released before the computer is ready', async () => {
    const { text, press, mic, source } = start();
    let ready: (dictation: Dictation) => void = () => {};
    source.dictate = () => new Promise((resolve) => { ready = resolve; });
    const pushed: Uint8Array[] = [];
    let cancels = 0;
    await press({ type: 'hold' });
    await press({ type: 'release' });
    ready({ push: (pcm) => pushed.push(pcm), finish: async () => 'late words', cancel: () => { cancels += 1; } });
    await settle();
    await press({ type: 'audio', pcm: new Uint8Array([1]) });
    expect(mic).toEqual([false]);
    expect(pushed).toEqual([]);
    expect(cancels).toBe(1);
    expect(text()[0]).toMatch(/^fix-login: Stub the clock/);
  });

  it('opens the whole of a long question from its row and comes back', async () => {
    const { text, press } = start();
    await press({ type: 'down' });
    await press({ type: 'press' });
    await press({ type: 'select', index: 3 });
    expect(text()[0]).toBe('token-refresh asks · full question');
    await press({ type: 'double' });
    expect(text().at(-1)).toContain('Read the whole question');
    await press({ type: 'double' });
    expect(text()[0]).toBe('2/6 · needs you · token-refresh · studio-mac');
  });
});

describe('Panes and the terminal', () => {
  async function openFixLogin() {
    const started = start();
    for (let page = 0; page < 5; page += 1) await started.press({ type: 'down' });
    await started.press({ type: 'press' });
    expect(started.text()[0]).toBe('Open a Pane · pick a computer');
    await started.press({ type: 'select', index: 0 });
    // Sessions, a blank row, then Panes; a press on the blank row opens nothing.
    expect(started.text()[1]).toContain('Session · even g2 app · idle |  | fix-login · Claude · working');
    await started.press({ type: 'select', index: 1 });
    expect(started.text()[0]).toContain('Sessions and Panes');
    await started.press({ type: 'select', index: 2 });
    return started;
  }

  it('shows the live screen with a footer naming the newest card elsewhere', async () => {
    const { text } = await openFixLogin();
    expect(text()[0]).toBe('fix-login · Claude · working');
    expect(text()[1]).toContain('expected 200, got 401');
    expect(text()[2]).toBe('? token-refresh needs you · double press for cards');
  });

  it('scrolls back through older output and returns to live on press', async () => {
    const { text, press } = await openFixLogin();
    await press({ type: 'up' });
    expect(text()[0]).toMatch(/^fix-login · scrolled up \d+ lines · press = live$/);
    expect(text()[1]).toContain('Edit(src/auth/refresh.ts)');
    await press({ type: 'press' });
    expect(text()[0]).toBe('fix-login · Claude · working');
  });

  it('types dictation into the Pane with Enter on release', async () => {
    const { text, press, clock } = await openFixLogin();
    await press({ type: 'hold' });
    expect(text()[0]).toBe('fix-login · listening');
    await press({ type: 'release' });
    await clock.advance(600);
    expect(text()[1]).toContain('> stub the clock and rerun only the auth suite');
  });

  it('reads the screen about once a second while open, and stops when it closes', async () => {
    const { source, press, clock } = await openFixLogin();
    let reads = 0;
    const screen = source.screen.bind(source);
    source.screen = async (computerId, panelId) => {
      reads += 1;
      return screen(computerId, panelId);
    };
    await clock.advance(3_000);
    expect(reads).toBeGreaterThanOrEqual(3);
    await press({ type: 'down' });
    await press({ type: 'select', index: 0 });
    await press({ type: 'double' });
    const after = reads;
    await clock.advance(5_000);
    expect(reads).toBe(after);
  });

  it('goes from the footer back to the card pages with that card first', async () => {
    const { text, press } = await openFixLogin();
    await press({ type: 'double' });
    expect(text()[0]).toBe('2/6 · needs you · token-refresh · studio-mac');
  });

  it("explains that a computer can't take dictation", async () => {
    const { text, press } = start();
    for (let page = 0; page < 5; page += 1) await press({ type: 'down' });
    await press({ type: 'press' });
    await press({ type: 'select', index: 1 });
    await press({ type: 'select', index: 0 });
    await press({ type: 'hold' });
    expect(text()[1]).toContain("devbox can't turn speech into text.");
    await press({ type: 'double' });
    expect(text()[0]).toBe('api-server · shell · idle');
  });
});

/** Computers and cards a test sets by hand. */
class ScriptedSource implements PaneSource {
  readonly demo = false;
  computerList: Computer[] = [{ id: 'studio', name: 'studio-mac', status: 'live', lastSeenAt: 1, paneCount: 1, workingCount: 0 }];
  cardList: Card[] = [];
  retried: Array<string | undefined> = [];
  private readonly listeners = new Set<() => void>();

  computers() { return this.computerList; }
  cards() { return orderCards(this.cardList); }
  subscribe(listener: () => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  changed() { for (const listener of this.listeners) listener(); }
  rows: PaneRow[] = [];
  screenStatus: TerminalScreen['status'] = 'idle';
  /** Calls that change something on a computer, in order. */
  calls: string[] = [];
  async panes(): Promise<PaneRow[]> { return this.rows; }
  async screen(): Promise<TerminalScreen> { return { lines: [], status: this.screenStatus, agent: 'shell' }; }
  async scrollback() { return []; }
  async markViewed(_computerId: string, paneId: string) {
    this.calls.push(`viewed ${paneId}`);
  }
  async resume(_computerId: string, panelId: string) {
    this.calls.push(`resume ${panelId}`);
    this.screenStatus = 'idle';
  }
  async submit() {}
  async answer() {}
  async dictate(): Promise<Dictation> { throw new Error('no voice'); }
  retry(computerId?: string) { this.retried.push(computerId); }
}

function card(id: string, createdAt: number, waiting = true): Card {
  return { key: `studio:${id}`, computerId: 'studio', machine: 'studio-mac', itemId: id, ui: waiting ? 'options' : 'info', waiting, title: `title ${id}`, choices: ['Yes'], suggestions: [], paneName: `pane-${id}`, createdAt };
}

function startScripted() {
  const clock = new Clock();
  const source = new ScriptedSource();
  const pages: Page[] = [];
  const app = new GlassesApp({ source, show: (page) => pages.push(page), exit: () => {}, mic: async () => true, later: clock.later, now: () => clock.now, clock: () => '9:40' });
  const text = () => (pages.at(-1)?.boxes ?? []).map((box) => (box.kind === 'list' ? box.items.join(' | ') : box.lines.join(' / ')));
  const press = async (gesture: Gesture) => {
    app.handle(gesture);
    await settle();
  };
  return { app, source, text, press, clock };
}

/** Opens `rows[index]` on a live computer from home. */
async function openScriptedRow(rows: PaneRow[], index: number, screenStatus: TerminalScreen['status'] = 'idle') {
  const scripted = startScripted();
  scripted.source.computerList = [{ id: 'studio', name: 'studio-mac', status: 'live', lastSeenAt: 1, paneCount: rows.length, workingCount: 0 }];
  scripted.source.rows = rows;
  scripted.source.screenStatus = screenStatus;
  scripted.source.changed();
  await scripted.press({ type: 'press' });
  await scripted.press({ type: 'select', index: 0 });
  await scripted.press({ type: 'select', index });
  return scripted;
}

const paneRow = (id: string): PaneEntry => ({ kind: 'pane', id, name: id, agent: 'Claude', status: 'stopped', panelId: `panel-${id}` });

describe('opening and leaving a Pane, as the Pane apps do', () => {
  it('marks it viewed and starts a stopped tab once with its saved agent, then just reads it', async () => {
    const { source, clock, text } = await openScriptedRow([paneRow('fix-login')], 0, 'stopped');
    expect(text()[0]).toContain('fix-login');
    expect(source.calls).toEqual(['viewed fix-login', 'resume panel-fix-login']);
    source.screenStatus = 'stopped';
    await clock.advance(5_000);
    expect(source.calls).toEqual(['viewed fix-login', 'resume panel-fix-login']);
  });

  it('leaves a running tab alone, and marks the Pane viewed again on leaving or going to the background', async () => {
    const { source, press } = await openScriptedRow([paneRow('fix-login')], 0, 'idle');
    expect(source.calls).toEqual(['viewed fix-login']);
    await press({ type: 'background' });
    await press({ type: 'foreground' });
    await press({ type: 'double' });
    expect(source.calls).toEqual(['viewed fix-login', 'viewed fix-login', 'viewed fix-login', 'viewed fix-login']);
  });

  it('marks nothing viewed for a Session, which has no viewed marker', async () => {
    const session: PaneEntry = { kind: 'session', id: 's1', name: 'even g2 app', agent: 'Claude', status: 'idle', panelId: 'sp1' };
    const { source, press } = await openScriptedRow([session], 0, 'idle');
    await press({ type: 'double' });
    expect(source.calls).toEqual([]);
  });
});

describe('going back keeps your place', () => {
  it('opens the computer and Pane lists on the rows you picked, with the rows above after the top divider', async () => {
    const { source, text, press } = startScripted();
    source.computerList = [
      { id: 'studio', name: 'studio-mac', status: 'live', lastSeenAt: 1, paneCount: 4, workingCount: 0 },
      { id: 'devbox', name: 'devbox', status: 'live', lastSeenAt: 1, paneCount: 4, workingCount: 0 },
    ];
    source.rows = ['a', 'b', 'c', 'd'].map(paneRow);
    source.changed();
    await press({ type: 'press' });
    await press({ type: 'select', index: 1 });
    await press({ type: 'select', index: 2 });
    expect(text()[0]).toBe('c · shell · idle');

    await press({ type: 'double' });
    expect(text()[1]).toBe('c · Claude · stopped | d · Claude · stopped | · top of the list · | a · Claude · stopped | b · Claude · stopped');
    await press({ type: 'select', index: 3 });
    expect(text()[0]).toBe('a · shell · idle');
    await press({ type: 'double' });
    expect(text()[1]).toMatch(/^a · Claude/);

    await press({ type: 'double' });
    expect(text()[1]).toBe('devbox · 4 Panes · idle | · top of the list · | studio-mac · 4 Panes · idle');
  });

  it('starts on the next row when the Pane you left was archived', async () => {
    const { source, text, press } = await openScriptedRow(['a', 'b', 'c', 'd'].map(paneRow), 2);
    source.rows = ['a', 'b', 'd'].map(paneRow);
    await press({ type: 'double' });
    expect(text()[1]).toBe('d · Claude · stopped | · top of the list · | a · Claude · stopped | b · Claude · stopped');
  });
});

describe('a refused computer', () => {
  it('is retried by a press on home, which shows it connecting rather than the same refusal', () => {
    const { app, source, text } = startScripted();
    source.computerList = [{ id: 'studio', name: 'studio-mac', status: 'refused', lastSeenAt: 1, paneCount: 0, workingCount: 0, refusal: { code: 'ERR_GLASSES_ORIGIN_REFUSED', message: "studio-mac doesn't allow this app.", next: 'Allow it.' } }];
    source.changed();
    expect(text()[0]).toBe('studio-mac · not allowed');
    app.handle({ type: 'press' });
    expect(source.retried).toEqual(['studio']);
    // Retrying clears the refusal while the computer connects.
    source.computerList = [{ id: 'studio', name: 'studio-mac', status: 'connecting', lastSeenAt: 1, paneCount: 0, workingCount: 0 }];
    source.changed();
    expect(text()[0]).toBe('Pane · 1 computer');
    expect(text()[1]).toBe('Connecting to your computers…');
  });
});

describe('a new question', () => {
  it('takes page 1 when it arrives on the all-clear page', () => {
    const { source, text } = startScripted();
    expect(text()[0]).toBe('1/1 · Pane · 1 computer · all clear');
    source.cardList = [card('q1', 10)];
    source.changed();
    expect(text()[0]).toBe('1/2 · needs you · pane-q1 · studio-mac');
  });

  it('takes page 1 when it arrives on the last page, and leaves any other page alone', () => {
    const { app, source, text } = startScripted();
    source.cardList = [card('i1', 5, false)];
    source.changed();
    app.handle({ type: 'down' });
    expect(text()[0]).toBe('2/2 · Pane · 1 computer');
    source.cardList = [card('i1', 5, false), card('q1', 10)];
    source.changed();
    expect(text()[0]).toBe('1/3 · needs you · pane-q1 · studio-mac');
    app.handle({ type: 'down' });
    expect(text()[0]).toBe('2/3 · info · pane-i1 · studio-mac');
    source.cardList = [card('i1', 5, false), card('q1', 10), card('q2', 20)];
    source.changed();
    expect(text()[0]).toBe('3/4 · info · pane-i1 · studio-mac');
  });
});
