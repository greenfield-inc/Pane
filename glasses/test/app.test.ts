import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { GlassesApp } from '../src/app';
import { DemoSource } from '../src/demo';
import type { Page } from '../src/display';
import type { ListMarks } from '../src/homeList';
import type { Gesture } from '../src/input';
import { GlassesError, SCREEN_RECONNECTING, orderCards, type Card, type Computer, type Dictation, type PaneEntry, type PaneSource, type TerminalKey, type TerminalScreen, type UnjoinedComputer } from '../src/model';
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

/** A terminal page's output, both halves, one line per row. */
function outputOf(page: Page | undefined): string {
  const halves = (page?.boxes ?? []).filter((box) => box.name === 'top' || box.name === 'bottom');
  return halves.flatMap((box) => (box.kind === 'text' ? box.lines : [])).join(' / ');
}

/** Each text box's lines and each list's items, in page order; images have no text. */
function textOf(page: Page | undefined): string[] {
  return (page?.boxes ?? []).flatMap((box) => (box.kind === 'list' ? [box.items.join(' | ')] : box.kind === 'text' ? [box.lines.join(' / ')] : []));
}

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
    lastSessionComputer: { read: () => null, write: () => {} },
  });
  const text = () => textOf(pages.at(-1));
  const press = async (gesture: Gesture) => {
    app.handle(gesture);
    await settle();
  };
  return { app, source, clock, text, output: () => outputOf(pages.at(-1)), press, mic, exits: () => exits };
}

describe('home', () => {
  it('starts with the new-Session row, then every computer\'s questions, then its info cards, then its Sessions and Panes newest first, each marked with its computer', () => {
    const { text } = start();
    expect(text()).toEqual([
      'All computers · 3 need you',
      '> + New Session on studio-mac · hold to say it',
      '   studi  fix-login · needs you',
      '   studi  token-refresh · needs you',
      '   studi  Planner · needs you',
      '   devbo  docs-pass · PR #482 opened. Checks are running.',
      '   studi  nightly · Tests green on studio-mac.',
    ]);
  });

  it('moves the selection one row per swipe and turns the page after the sixth row', async () => {
    const { text, press } = start();
    await press({ type: 'down' });
    expect(text().slice(1, 3)).toEqual(['   + New Session on studio-mac · hold to say it', '> studi  fix-login · needs you']);
    for (let row = 1; row < 7; row += 1) await press({ type: 'down' });
    expect(text().slice(1, 3)).toEqual(['   studi  docs-pass · Codex · needs you', '> devbo  api-server · shell · idle']);
    await press({ type: 'up' });
    await press({ type: 'up' });
    expect(text()[6]).toBe('> studi  nightly · Tests green on studio-mac.');
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
    await press({ type: 'down' });
    await press({ type: 'press' });
    expect(text().at(-1)).toBe('Stub the clock | Loosen retry | Something else (hold to say it)');
    expect(text()[0]).toContain('The refresh mock returns 401');
    await press({ type: 'select', index: 1 });
    expect(source.cards().map((card) => card.paneName)).not.toContain('fix-login');
    expect(text().slice(0, 3)).toEqual(['Answered fix-login: Loosen retry', '   + New Session on studio-mac · hold to say it', '> studi  token-refresh · needs you']);
  });

  it('answers by voice: hold listens, release sends the words at once', async () => {
    const { text, press, clock, mic, source } = start();
    await press({ type: 'down' });
    await press({ type: 'hold' });
    expect(text()[0]).toBe('Answering fix-login · listening');
    await clock.advance(1_400);
    expect(text()[1]).toBe('● stub the clock and');
    await press({ type: 'release' });
    await settle();
    expect(mic).toEqual([true, false]);
    expect(source.cards().map((card) => card.paneName)).not.toContain('fix-login');
    expect(text()[0]).toMatch(/^Answered fix-login: "stub the clock and rerun/);
  });

  it('never turns the microphone on for a hold released before the computer is ready', async () => {
    const { text, press, mic, source } = start();
    let ready: (dictation: Dictation) => void = () => {};
    source.dictate = () => new Promise((resolve) => { ready = resolve; });
    const pushed: Uint8Array[] = [];
    let cancels = 0;
    await press({ type: 'down' });
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
    await press({ type: 'down' });
    await press({ type: 'press' });
    await press({ type: 'select', index: 3 });
    expect(text()[0]).toBe('token-refresh asks · full question');
    await press({ type: 'double' });
    expect(text().at(-1)).toContain('Read the whole question');
    await press({ type: 'double' });
    expect(text()[3]).toBe('> studi  token-refresh · needs you');
  });
});

describe('Panes and the terminal', () => {
  /** fix-login's question answered on another screen, so its own row opens its terminal. */
  async function openFixLogin() {
    const started = start();
    const asked = started.source.cards().find((card) => card.paneName === 'fix-login');
    if (asked) await started.source.answer(asked, { choice: 'Stub the clock' });
    // Below the New row, token-refresh and Planner's questions, and the two info cards.
    for (let row = 0; row < 5; row += 1) await started.press({ type: 'down' });
    expect(started.text()[6]).toBe('> studi  fix-login · Claude · working');
    await started.press({ type: 'press' });
    return started;
  }

  it('shows the live screen with a footer naming the newest card elsewhere', async () => {
    const { text, output } = await openFixLogin();
    expect(text()[0]).toBe('fix-login · Claude · working');
    expect(output()).toContain('expected 200, got 401');
    expect(text().at(-1)).toBe('? token-refresh needs you · double press for it');
  });

  it('scrolls back through older output half a page at a time', async () => {
    const { text, output, press } = await openFixLogin();
    await press({ type: 'up' });
    await press({ type: 'up' });
    expect(text()[0]).toBe('fix-login · scrolled up 8 lines');
    expect(output()).toContain('Edit(src/auth/refresh.ts)');
  });

  it('types dictation into the Pane with Enter on release', async () => {
    const { text, output, press, clock } = await openFixLogin();
    await press({ type: 'hold' });
    expect(text()[0]).toBe('fix-login · listening');
    await press({ type: 'release' });
    await clock.advance(600);
    expect(output()).toContain('> stub the clock and rerun only the auth suite');
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

  it('goes from the footer back home with that question selected', async () => {
    const { text, press } = await openFixLogin();
    await press({ type: 'double' });
    expect(text()[2]).toBe('> studi  token-refresh · needs you');
  });

  it("explains that a computer can't take dictation", async () => {
    const { text, press } = start();
    for (let row = 0; row < 7; row += 1) await press({ type: 'down' });
    await press({ type: 'press' });
    await press({ type: 'hold' });
    expect(text()[1]).toContain("devbox can't turn speech into text.");
    await press({ type: 'double' });
    expect(text()[0]).toBe('api-server · shell · idle');
  });
});

/** Computers and cards a test sets by hand. */
class ScriptedSource implements PaneSource {
  readonly demo = false;
  computerList: Computer[] = [{ id: 'studio', name: 'studio-mac', status: 'live', lastSeenAt: 1, os: 'macOS', entries: [] }];
  cardList: Card[] = [];
  retried: Array<string | undefined> = [];
  private readonly listeners = new Set<() => void>();

  /** The first computer lists `rows`. */
  computers() { return this.computerList.map((computer, index) => (index === 0 ? { ...computer, entries: this.rows } : computer)); }
  cards() { return orderCards(this.cardList); }
  unjoinedList: UnjoinedComputer[] = [];
  unjoined() { return this.unjoinedList; }
  subscribe(listener: () => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  changed() { for (const listener of this.listeners) listener(); }
  rows: PaneEntry[] = [];
  screenStatus: TerminalScreen['status'] = 'idle';
  /** Calls that change something on a computer, in order. */
  calls: string[] = [];
  screenLines: string[] = [];
  savedOutput: string[] = [];
  /** The computer each screen read went to. */
  screenReads: string[] = [];
  async screen(computerId: string): Promise<TerminalScreen> {
    this.screenReads.push(computerId);
    return { lines: this.screenLines, status: this.screenStatus, agent: 'shell' };
  }
  async scrollback() {
    this.savedReads += 1;
    return this.savedOutput;
  }
  async markViewed(_computerId: string, paneId: string) {
    this.calls.push(`viewed ${paneId}`);
  }
  async resume(_computerId: string, panelId: string) {
    this.calls.push(`resume ${panelId}`);
    this.screenStatus = 'idle';
  }
  /** Text submitted, and keys pressed, in order. */
  submitted: string[] = [];
  keys: TerminalKey[] = [];
  /** What a key does to the screen; throw to refuse it. */
  onKey: (key: TerminalKey) => void = () => {};
  savedReads = 0;
  async submit(_computerId: string, _panelId: string, text: string) { this.submitted.push(text); }
  /** Each key request waits on the next of these, in order, before it lands; a rejected one fails that key. */
  keyDelays: Array<Promise<void>> = [];
  async key(_computerId: string, _panelId: string, key: TerminalKey) {
    const delay = this.keyDelays.shift();
    if (delay) await delay;
    this.onKey(key);
    this.keys.push(key);
  }
  async answer() {}
  dictation = 'no voice';
  async dictate(): Promise<Dictation> {
    if (this.dictation === 'no voice') throw new Error('no voice');
    const words = this.dictation;
    return { push: () => {}, finish: async () => words, cancel: () => {} };
  }
  retry(computerId?: string) { this.retried.push(computerId); }
  /** Sessions started, as `computer: name / goal`; throw from `onCreate` to refuse one. */
  created: string[] = [];
  onCreate: () => void = () => {};
  async createSession(computerId: string, request: { name: string; goal: string }): Promise<PaneEntry> {
    this.onCreate();
    this.created.push(`${computerId}: ${request.name} / ${request.goal}`);
    return { kind: 'session', id: 'new-1', name: request.name, agent: 'Claude', status: 'idle', panelId: 'new-panel' };
  }
}

function card(id: string, createdAt: number, waiting = true): Card {
  return { key: `studio:${id}`, computerId: 'studio', machine: 'studio-mac', itemId: id, ui: waiting ? 'options' : 'info', waiting, title: `title ${id}`, choices: ['Yes'], suggestions: [], paneName: `pane-${id}`, createdAt };
}

function startScripted(lastSessionComputer: string | null = null, marks: ListMarks = 'logos') {
  const clock = new Clock();
  const source = new ScriptedSource();
  const pages: Page[] = [];
  const stored = { computer: lastSessionComputer };
  const app = new GlassesApp({
    source, show: (page) => pages.push(page), exit: () => {}, mic: async () => true, later: clock.later, now: () => clock.now, clock: () => '9:40', marks,
    lastSessionComputer: { read: () => stored.computer, write: (computerId) => { stored.computer = computerId; } },
  });
  const text = () => textOf(pages.at(-1));
  const press = async (gesture: Gesture) => {
    app.handle(gesture);
    await settle();
  };
  const page = () => pages.at(-1);
  return { app, source, text, output: () => outputOf(pages.at(-1)), page, pages, press, clock, stored };
}

/** Opens `rows[index]` on a live computer from home. */
async function openScriptedRow(rows: PaneEntry[], index: number, screenStatus: TerminalScreen['status'] = 'idle') {
  const scripted = startScripted();
  scripted.source.rows = rows;
  scripted.source.screenStatus = screenStatus;
  scripted.source.changed();
  // Row 0 is the new-Session row.
  for (let row = 0; row <= index; row += 1) await scripted.press({ type: 'down' });
  await scripted.press({ type: 'press' });
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

describe('a terminal whose computer drops', () => {
  it('keeps the last screen and keeps reading while the computer reconnects, then shows the new screen', async () => {
    const { source, clock, text, output } = await openScriptedRow([paneRow('fix-login')], 0, 'idle');
    source.screenLines = ['before the drop'];
    await clock.advance(1_000);
    const live = source.screen.bind(source);
    source.screen = async () => { throw new GlassesError(SCREEN_RECONNECTING, 'Lost the connection to studio-mac. Reconnecting.'); };
    await clock.advance(3_000);
    expect(text()[0]).toBe('fix-login · shell · idle');
    expect(output()).toContain('before the drop');
    source.screen = live;
    source.screenLines = ['after the drop'];
    await clock.advance(1_000);
    expect(output()).toContain('after the drop');
  });

  it('shows the problem once the computer stops reconnecting', async () => {
    const { source, clock, text } = await openScriptedRow([paneRow('fix-login')], 0, 'idle');
    source.screen = async () => { throw new Error('Could not reconnect to studio-mac.'); };
    await clock.advance(1_000);
    expect(text()[0]).toBe('fix-login');
    expect(text()[1]).toContain('Could not reconnect to studio-mac.');
  });
});

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}.txt`, import.meta.url), 'utf8').split('\n');

/** Claude's permission prompt with the cursor on `row`. */
const permission = (row: number) => fixture('claude-permission').map((line) => {
  const choice = /^ [❯ ] (\d)\. /u.exec(line);
  return choice ? ` ${Number(choice[1]) - 1 === row ? '❯' : ' '} ${choice[1]}. ${line.slice(choice[0].length)}` : line;
});

const brightness = (page: Page | undefined, name: string) => {
  const box = page?.boxes.find((candidate) => candidate.name === name);
  return box?.kind === 'text' ? box.brightness : undefined;
};

describe('an agent terminal', () => {
  const inputBox = ['─'.repeat(90), '> ', '─'.repeat(90), '  Opus 5.5 / medium | ctx 27% | $10.62', '  bypass permissions on · 2 shells'];
  const output = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, index) => `out ${from + index}`);

  async function openAgent(screen = [...output(21, 30), ...inputBox]) {
    const scripted = startScripted();
    scripted.source.screenLines = screen;
    scripted.source.savedOutput = [...output(1, 30), ...inputBox];
    scripted.source.rows = [paneRow('fix-login')];
    scripted.source.changed();
    await scripted.press({ type: 'down' });
    await scripted.press({ type: 'press' });
    return scripted;
  }

  it('shows the output without the input box, all bright', async () => {
    const { text, output: shown, page } = await openAgent();
    expect(text()[0]).toBe('fix-login · shell · idle');
    expect(shown()).toBe(output(23, 30).join(' / '));
    expect([brightness(page(), 'top'), brightness(page(), 'bottom')]).toEqual([4, 4]);
  });

  it('pages up half a page at a time, dimming the half just read, holds still while the screen changes, and comes back down to live', async () => {
    const { text, output: shown, press, source, clock, page } = await openAgent();
    await press({ type: 'up' });
    expect(text()[0]).toBe('fix-login · scrolled up 4 lines');
    expect(shown()).toBe(output(19, 26).join(' / '));
    expect([brightness(page(), 'top'), brightness(page(), 'bottom')]).toEqual([4, 1]);
    await press({ type: 'up' });
    expect(shown()).toBe(output(15, 22).join(' / '));

    source.screenLines = [...output(31, 40), ...inputBox];
    await clock.advance(3_000);
    expect(shown()).toBe(output(15, 22).join(' / '));

    await press({ type: 'down' });
    expect(shown()).toBe(output(19, 26).join(' / '));
    expect([brightness(page(), 'top'), brightness(page(), 'bottom')]).toEqual([1, 4]);
    await press({ type: 'down' });
    expect(text()[0]).toBe('fix-login · shell · idle');
    expect(shown()).toBe(output(33, 40).join(' / '));
    expect([brightness(page(), 'top'), brightness(page(), 'bottom')]).toEqual([4, 4]);
  });

  it('keeps one layout while paging, so each swipe updates text in place', async () => {
    const { press, page } = await openAgent();
    const layout = () => page()?.boxes.map((box) => [box.name, box.kind, box.y, box.h]);
    const live = layout();
    await press({ type: 'up' });
    expect(layout()).toEqual(live);
    await press({ type: 'down' });
    expect(layout()).toEqual(live);
  });
});

describe('keys mode', () => {
  const screen = [...Array.from({ length: 10 }, (_, index) => `out ${index + 1}`), '─'.repeat(90), '> ', '─'.repeat(90), '  bypass permissions on · 2 shells'];

  async function openKeys() {
    const scripted = startScripted();
    scripted.source.screenLines = screen;
    scripted.source.rows = [paneRow('fix-login')];
    scripted.source.changed();
    await scripted.press({ type: 'down' });
    await scripted.press({ type: 'press' });
    await scripted.press({ type: 'press' });
    return scripted;
  }

  it('opens on press with the whole screen, input box included', async () => {
    const { text, output: shown } = await openKeys();
    expect(text()[0]).toBe('KEYS · swipe ↑↓ · press Enter · hold Esc/Tab');
    expect(shown()).toContain('bypass permissions on');
    expect(text().at(-1)).toBe('double press = done');
  });

  it('sends ↑ ↓ on swipes and shows their effect without waiting for the next read', async () => {
    const { source, press, output: shown } = await openKeys();
    source.onKey = (key) => { source.screenLines = [...screen.slice(0, -3), `> ${key}`, ...screen.slice(-2)]; };
    await press({ type: 'down' });
    expect(source.keys).toEqual(['down']);
    expect(shown()).toContain('> down');
    await press({ type: 'up' });
    expect(source.keys).toEqual(['down', 'up']);
    expect(shown()).toContain('> up');
  });

  it('sends Enter on press and goes back to the output', async () => {
    const { source, press, text } = await openKeys();
    await press({ type: 'press' });
    expect(source.keys).toEqual(['enter']);
    expect(text()[0]).toBe('fix-login · shell · idle');
  });

  it('sends keys in the order you made them, even when one is slow to arrive', async () => {
    const { source, press } = await openKeys();
    let arrive = () => {};
    source.keyDelays = [new Promise<void>((resolve) => { arrive = resolve; })];
    await press({ type: 'down' });
    await press({ type: 'press' });
    expect(source.keys).toEqual([]);
    arrive();
    await settle();
    expect(source.keys).toEqual(['down', 'enter']);
  });

  it('drops the keys waiting behind one that failed', async () => {
    const { source, press, text } = await openKeys();
    let fail = (_error: Error) => {};
    source.keyDelays = [new Promise<void>((_resolve, reject) => { fail = reject; })];
    await press({ type: 'down' });
    await press({ type: 'press' });
    fail(new Error('connection lost'));
    await settle();
    await settle();
    expect(source.keys).toEqual([]);
    expect(text()[0]).toBe('fix-login · keys not sent');
  });

  it('leaves on double press, sending nothing', async () => {
    const { source, press, text } = await openKeys();
    await press({ type: 'double' });
    expect(source.keys).toEqual([]);
    expect(text()[0]).toBe('fix-login · shell · idle');
  });

  it('holds Esc and Tab in a list: press sends one and returns to keys mode, double press sends nothing', async () => {
    const { source, press, text } = await openKeys();
    await press({ type: 'hold' });
    expect(text()[0]).toBe('KEYS · press sends · double = back');
    expect(text()[1]).toBe('> /   bypass permissions on · 2 shells');
    expect(text()[2]).toBe('Esc | Tab');
    await press({ type: 'release' });
    await press({ type: 'select', index: 0 });
    expect(text()[0]).toBe('KEYS · swipe ↑↓ · press Enter · hold Esc/Tab');
    await press({ type: 'hold' });
    await press({ type: 'select', index: 1 });
    await press({ type: 'hold' });
    await press({ type: 'double' });
    expect(text()[0]).toBe('KEYS · swipe ↑↓ · press Enter · hold Esc/Tab');
    await press({ type: 'double' });
    expect(source.keys).toEqual(['escape', 'tab']);
  });

  it('still names a card from another Pane in the footer, in the Esc / Tab list too', async () => {
    const { source, text, press } = await openKeys();
    source.cardList = [card('q1', 10)];
    source.changed();
    expect(text().at(-1)).toBe('? pane-q1 needs you · double press for it');
    await press({ type: 'hold' });
    expect(text()[0]).toBe('KEYS · press sends · double = back');
    expect(text().at(-1)).toBe('? pane-q1 needs you · double press for it');
  });

  it("says when the computer's Pane can't take keys yet, and goes back on press; hold still talks", async () => {
    const { source, press, text } = await openKeys();
    source.onKey = () => {
      throw new GlassesError('ERR_GLASSES_KEYS_UNSUPPORTED', "studio-mac's Pane can't take keys from the glasses yet.", 'Update Pane on studio-mac.');
    };
    await press({ type: 'down' });
    expect(text()[0]).toBe('fix-login · keys not sent');
    expect(text()[1]?.replace(/ \/ /g, ' ')).toBe("studio-mac's Pane can't take keys from the glasses yet. Update Pane on studio-mac.  Hold to talk still works.");
    expect(text().at(-1)).toBe('double press = back');
    await press({ type: 'press' });
    expect(text()[0]).toBe('fix-login · shell · idle');
    await press({ type: 'press' });
    await press({ type: 'down' });
    await press({ type: 'double' });
    source.dictation = 'try again';
    await press({ type: 'hold' });
    expect(text()[0]).toBe('fix-login · listening');
  });
});

describe('the picker', () => {
  async function openMenu(screen = permission(0)) {
    const scripted = startScripted();
    scripted.source.screenLines = screen;
    scripted.source.rows = [paneRow('fix-login')];
    scripted.source.changed();
    await scripted.press({ type: 'down' });
    await scripted.press({ type: 'press' });
    return scripted;
  }

  it('lists the choices of a menu it is certain of, under the question', async () => {
    const { text } = await openMenu();
    expect(text()[0]).toBe('fix-login · pick one · double = dismiss');
    expect(text()[1]).toBe('touch bye.txt && ls -l bye.txt / Do you want to proceed?');
    expect(text()[2]?.split(' | ')[0]).toBe('1. Yes');
    expect(text()[2]?.split(' | ')[3]).toBe('4. No');
  });

  it("picks by pressing the choice's number, wherever the cursor is", async () => {
    const { source, press, text, clock } = await openMenu(permission(1));
    source.onKey = () => { source.screenLines = ['⏺ Bash(touch bye.txt)', '  ⎿  (No output)']; };
    await press({ type: 'select', index: 3 });
    expect(source.keys).toEqual(['4']);
    await clock.advance(1_000);
    expect(text()[0]).toBe('fix-login · shell · idle');
  });

  it('opens keys mode when the menu is still there after its number', async () => {
    const { source, press, text, clock } = await openMenu(fixture('codex-trust'));
    await press({ type: 'select', index: 1 });
    expect(source.keys).toEqual(['2']);
    await clock.advance(1_000);
    expect(text()[0]).toBe('KEYS · swipe ↑↓ · press Enter · hold Esc/Tab');
    expect(text().at(-1)).toBe("The menu didn't take its number; answer it with keys");
  });

  it('sends nothing when the menu changed between showing and the pick', async () => {
    const { source, press, text } = await openMenu();
    source.screenLines = fixture('codex-approval');
    await press({ type: 'select', index: 1 });
    expect(source.keys).toEqual([]);
    expect(text()[0]).toBe('KEYS · swipe ↑↓ · press Enter · hold Esc/Tab');
    expect(text().at(-1)).toBe('The menu changed, so nothing was sent');
  });

  it('waits for keys pressed before it, and sends nothing when they changed the command', async () => {
    const scripted = startScripted();
    const { source, press, text, clock } = scripted;
    source.screenLines = ['$ _'];
    source.rows = [paneRow('fix-login')];
    source.changed();
    await press({ type: 'down' });
    await press({ type: 'press' });
    await press({ type: 'select', index: 0 });
    await press({ type: 'select', index: 0 });
    // Keys mode before the menu shows: a Down that is slow to arrive, then back to the output.
    await press({ type: 'press' });
    let arrive = () => {};
    source.keyDelays = [new Promise<void>((resolve) => { arrive = resolve; })];
    await press({ type: 'down' });
    await press({ type: 'double' });
    source.screenLines = permission(0);
    await clock.advance(1_100);
    expect(text()[0]).toBe('fix-login · pick one · double = dismiss');
    source.onKey = (key) => {
      if (key === 'down') source.screenLines = permission(1).map((line) => line.replace('touch bye.txt && ls -l bye.txt', 'rm -rf ./important-work'));
    };
    await press({ type: 'select', index: 0 });
    expect(source.keys).toEqual([]);
    arrive();
    await settle();
    await settle();
    expect(source.keys).toEqual(['down']);
    expect(text().at(-1)).toBe('The menu changed, so nothing was sent');
  });

  it('sends nothing when the command being approved changes under the same question and choices', async () => {
    const { source, press, text } = await openMenu();
    expect(text()[1]).toBe('touch bye.txt && ls -l bye.txt / Do you want to proceed?');
    source.screenLines = permission(0).map((line) => line.replace('touch bye.txt && ls -l bye.txt', 'rm -rf ./important-work'));
    await press({ type: 'select', index: 0 });
    expect(source.keys).toEqual([]);
    expect(text().at(-1)).toBe('The menu changed, so nothing was sent');
  });

  it('sends nothing when an earlier row of a long command changes under the same last rows', async () => {
    const command = (first: string) => permission(0).flatMap((line) => (line === ' touch bye.txt && ls -l bye.txt' ? [` ${first}`, ' printf a', ' printf b', ' printf c'] : [line]));
    const { source, press, text } = await openMenu(command('touch safe.txt'));
    source.screenLines = command('rm -rf ./important-work');
    await press({ type: 'select', index: 0 });
    expect(source.keys).toEqual([]);
    expect(text().at(-1)).toBe('The menu changed, so nothing was sent');
  });

  it('sends nothing when a different question shows the same choices', async () => {
    const { source, press, text } = await openMenu();
    source.screenLines = permission(0).map((line) => line.replace('Do you want to proceed?', 'Do you want to delete the repo?'));
    await press({ type: 'select', index: 0 });
    expect(source.keys).toEqual([]);
    expect(text().at(-1)).toBe('The menu changed, so nothing was sent');
  });

  it('ignores hold while a pick is sending its key', async () => {
    const { source, press, text, clock } = await openMenu();
    source.dictation = 'hello';
    let arrive = () => {};
    source.keyDelays = [new Promise<void>((resolve) => { arrive = resolve; })];
    await press({ type: 'select', index: 2 });
    await press({ type: 'hold' });
    expect(text()[0]).toBe('fix-login · picking…');
    arrive();
    await settle();
    expect(source.keys).toEqual(['3']);
    source.screenLines = ['$ _'];
    await clock.advance(1_000);
    expect(text()[0]).toBe('fix-login · shell · idle');
  });

  it('is dismissed by double press until that menu leaves the screen', async () => {
    const { source, press, text, clock } = await openMenu();
    await press({ type: 'double' });
    expect(text()[0]).toBe('fix-login · shell · idle');
    await clock.advance(3_000);
    expect(text()[0]).toBe('fix-login · shell · idle');
    source.screenLines = ['$ _'];
    await clock.advance(1_000);
    source.screenLines = permission(0);
    await clock.advance(1_000);
    expect(text()[0]).toBe('fix-login · pick one · double = dismiss');
  });

  it('never shows for a prompt it is not certain of: press opens keys mode', async () => {
    const { press, text } = await openMenu(fixture('claude-trust'));
    expect(text()[0]).toBe('fix-login · shell · idle');
    await press({ type: 'press' });
    expect(text()[0]).toBe('KEYS · swipe ↑↓ · press Enter · hold Esc/Tab');
  });
});

describe('after you speak, the view holds at your message', () => {
  const said = 'run the auth tests again and tell me which one fails first';
  const reply = (count: number) => Array.from({ length: count }, (_, index) => `reply ${index + 1}`);
  const inputBox = ['─'.repeat(90), '> ', '─'.repeat(90)];

  async function speak() {
    const scripted = startScripted();
    scripted.source.screenLines = ['out 1', ...inputBox];
    scripted.source.rows = [paneRow('fix-login')];
    scripted.source.dictation = said;
    scripted.source.changed();
    await scripted.press({ type: 'down' });
    await scripted.press({ type: 'press' });
    scripted.source.savedOutput = ['out 1', `> ${said}`, ...reply(20), ...inputBox];
    scripted.source.screenLines = [`> ${said}`, ...reply(20), ...inputBox];
    await scripted.press({ type: 'hold' });
    await scripted.press({ type: 'release' });
    await settle();
    return scripted;
  }

  it('starts the page at your line and counts the lines below it', async () => {
    const { source, text, output: shown } = await speak();
    expect(source.submitted).toEqual([said]);
    expect(text()[0]).toBe('fix-login · shell · idle · ↓ 13 more');
    expect(shown()).toBe([`> ${said}`, ...reply(7)].join(' / '));
  });

  it('counts down as you swipe, and follows live past the end', async () => {
    const { press, text, output: shown } = await speak();
    await press({ type: 'down' });
    expect(text()[0]).toBe('fix-login · shell · idle · ↓ 9 more');
    expect(shown()).toBe(reply(11).slice(3).join(' / '));
    for (let swipe = 0; swipe < 3; swipe += 1) await press({ type: 'down' });
    expect(text()[0]).toBe('fix-login · shell · idle');
    expect(shown()).toBe(reply(20).slice(12).join(' / '));
    await press({ type: 'down' });
    expect(text()[0]).toBe('fix-login · shell · idle');
  });

  it('keeps holding while you swipe up into older output, and swiping down returns to your line', async () => {
    const { press, text, output: shown } = await speak();
    await press({ type: 'up' });
    expect(text()[0]).toBe('fix-login · shell · idle · ↓ 14 more');
    expect(shown()).toBe(['out 1', `> ${said}`, ...reply(6)].join(' / '));
    await press({ type: 'down' });
    expect(text()[0]).toBe('fix-login · shell · idle · ↓ 13 more');
  });

  it('stops at the oldest line when swiping up, so the next swipe down comes straight back to your line', async () => {
    const { press, text, output: shown } = await speak();
    for (let swipe = 0; swipe < 3; swipe += 1) await press({ type: 'up' });
    expect(shown()).toBe(['out 1', `> ${said}`, ...reply(6)].join(' / '));
    await press({ type: 'down' });
    expect(text()[0]).toBe('fix-login · shell · idle · ↓ 13 more');
    expect(shown()).toBe([`> ${said}`, ...reply(7)].join(' / '));
    await press({ type: 'down' });
    expect(text()[0]).toBe('fix-login · shell · idle · ↓ 9 more');
  });

  it('reads the saved output only when the screen changed, at most once a second', async () => {
    const { source, clock } = await speak();
    const before = source.savedReads;
    await clock.advance(5_000);
    expect(source.savedReads).toBe(before);
    for (let tick = 0; tick < 10; tick += 1) {
      source.screenLines = [...source.screenLines, `more ${tick}`];
      await clock.advance(500);
    }
    expect(source.savedReads - before).toBeLessThanOrEqual(5);
    expect(source.savedReads - before).toBeGreaterThan(0);
  });

  it('follows live again when your line is gone, as after the agent clears its screen', async () => {
    const { source, text, clock } = await speak();
    source.savedOutput = ['$ clear', ...inputBox];
    source.screenLines = ['cleared', ...inputBox];
    await clock.advance(1_100);
    expect(text()[0]).toBe('fix-login · shell · idle');
  });

  it('gives way to a new menu', async () => {
    const { source, text, clock } = await speak();
    source.screenLines = permission(0);
    await clock.advance(1_100);
    expect(text()[0]).toBe('fix-login · pick one · double = dismiss');
  });
});

describe('demo', () => {
  it('raises a menu that the picker answers with no computer', async () => {
    const { press, text, output: shown, clock } = start();
    for (let row = 0; row < 6; row += 1) await press({ type: 'down' });
    await press({ type: 'press' });
    expect(text()[0]).toBe('docs-pass · pick one · double = dismiss');
    expect(text()[2]).toBe('1. Yes, push and open the PR | 2. Not yet');
    await press({ type: 'select', index: 1 });
    await clock.advance(1_000);
    expect(text()[0]).toBe('docs-pass · Codex · idle');
    expect(shown()).toContain('Okay, the branch stays local for now.');
    await clock.advance(5_000);
    expect(text()[0]).toBe('docs-pass · pick one · double = dismiss');
    // Keys mode and the Esc / Tab list work on it too: Esc cancels.
    await press({ type: 'double' });
    await press({ type: 'press' });
    await press({ type: 'hold' });
    await press({ type: 'select', index: 0 });
    await press({ type: 'double' });
    expect(shown()).toContain('Cancelled. Nothing was pushed.');
  });

  it('starts a sample Session from the first row, which then lists it', async () => {
    const { press, text, output: shown } = start();
    await press({ type: 'hold' });
    await press({ type: 'release' });
    await settle();
    expect(text()[0]).toBe('stub the clock and rerun only the auth · Claude · working');
    expect(shown()).toContain('> stub the clock and rerun only the auth suite');
    await press({ type: 'double' });
    // It is on the second page, below the New row, the three questions and the two info cards.
    for (let row = 0; row < 6; row += 1) await press({ type: 'down' });
    expect(text().filter((row) => row.includes('studi  stub the clock and rerun only the auth · Session'))).toHaveLength(1);
  });
});

describe('going back keeps your place', () => {
  it('comes back to the row you opened', async () => {
    const { text, press } = await openScriptedRow(['a', 'b', 'c', 'd'].map(paneRow), 2);
    expect(text()[0]).toBe('c · shell · idle');
    await press({ type: 'double' });
    expect(text()[4]).toBe('> studi  c · Claude · stopped');
  });

  it('selects the row now in its place when the Pane you left was archived', async () => {
    const { source, text, press } = await openScriptedRow(['a', 'b', 'c', 'd'].map(paneRow), 2);
    source.rows = ['a', 'b', 'd'].map(paneRow);
    await press({ type: 'double' });
    expect(text()[4]).toBe('> studi  d · Claude · stopped');
  });
});

describe('the open list', () => {
  it('shows a new Pane as soon as its computer lists it', () => {
    const { source, text } = startScripted();
    source.rows = [{ ...paneRow('older'), activityAt: 10 }];
    source.changed();
    source.rows = [{ ...paneRow('older'), activityAt: 10 }, { ...paneRow('just-made'), activityAt: 20 }];
    source.changed();
    expect(text().slice(2, 4)).toEqual(['   studi  just-made · Claude · stopped', '   studi  older · Claude · stopped']);
  });

  it("opens each row on its own computer, though two computers have a Pane with the same id", async () => {
    const { source, text, press } = startScripted();
    source.computerList = [
      { id: 'studio', name: 'studio-mac', status: 'live', lastSeenAt: 1, os: 'macOS', entries: [] },
      { id: 'build', name: 'build-box', status: 'live', lastSeenAt: 1, os: 'Linux', entries: [{ ...paneRow('api'), activityAt: 1 }] },
    ];
    source.rows = [{ ...paneRow('api'), activityAt: 2 }];
    source.changed();
    expect(text().slice(2, 4)).toEqual(['   studi  api · Claude · stopped', '   build  api · Claude · stopped']);
    await press({ type: 'down' });
    await press({ type: 'down' });
    await press({ type: 'press' });
    expect(source.screenReads).toEqual(['build']);
  });

  it('keeps the rows of a computer that goes offline, says since when, and offers Retry on press', async () => {
    const { source, text, press } = startScripted();
    const studio: Computer = { id: 'studio', name: 'studio-mac', status: 'live', lastSeenAt: 1, os: 'macOS', entries: [] };
    const build: Computer = { id: 'build', name: 'build-box', status: 'live', lastSeenAt: 1, os: 'Linux', entries: [{ ...paneRow('nightly-backup'), activityAt: 1 }] };
    source.computerList = [studio, build];
    source.rows = [{ ...paneRow('a'), activityAt: 2 }];
    source.changed();
    source.computerList = [studio, { ...build, status: 'offline' }];
    source.changed();
    expect(text()[3]).toBe('   build  nightly-backup · offline since 9:40');
    await press({ type: 'down' });
    await press({ type: 'down' });
    await press({ type: 'press' });
    expect(text()).toEqual([
      'build-box · offline',
      'build-box went offline at 9:40. / nightly-backup is from then. Pane keeps trying by itself. /  / Press to retry now.',
      'press = retry   double press = back',
    ]);
    await press({ type: 'press' });
    expect(source.retried).toEqual(['build']);
    expect(text()[0]).toBe('All computers');
  });
});

describe('home in outline marks (the firmware list)', () => {
  function outlineHome() {
    const scripted = startScripted(null, 'outline');
    const studio: Computer = { id: 'studio', name: 'studio-mac', status: 'live', lastSeenAt: 1, os: 'macOS', entries: [] };
    const build: Computer = { id: 'build', name: 'build-box', status: 'offline', lastSeenAt: 1, os: 'Linux', entries: [{ ...paneRow('nightly-backup'), activityAt: 1 }] };
    scripted.source.computerList = [studio, build];
    scripted.source.rows = [{ ...paneRow('a'), activityAt: 3 }, { ...paneRow('b'), activityAt: 2 }];
    scripted.source.changed();
    return scripted;
  }

  it('opens the terminal of the row the list press names', async () => {
    const { source, text, press } = outlineHome();
    expect(text()[1]).toBe('○ studi  a · Claude · stopped | ○ studi  b · Claude · stopped | □ build  offline since 9:40 · 1 Pane · retry');
    await press({ type: 'select', index: 1 });
    expect(source.screenReads).toEqual(['studio']);
    expect(text()[0]).toContain('b');
  });

  it("opens an away computer's folded row on its Retry page", async () => {
    const { text, press } = outlineHome();
    await press({ type: 'select', index: 2 });
    expect(text()[0]).toBe('build-box · offline');
  });
});

describe('computers that could not join', () => {
  it('shows each as a dim row at the end of the list with its reason, and says what to do on press', async () => {
    const { source, text, press, page } = startScripted();
    source.rows = [{ ...paneRow('fix-checkout'), activityAt: 2 }];
    source.unjoinedList = [
      { name: 'office-pc', reason: 'update Pane there' },
      { name: 'old-laptop', reason: 'revoked here · pair from phone' },
      { name: 'nas', reason: 'needs its password' },
      { name: 'public-box', reason: 'Funnel is on' },
      { name: 'devbox', reason: 'not answering' },
    ];
    source.changed();
    await press({ type: 'down' });
    await press({ type: 'down' });
    expect(text().slice(1)).toEqual([
      '   + New Session on studio-mac · hold to say it',
      '   studi  fix-checkout · Claude · stopped',
      '> offic  office-pc · update Pane there',
      '   old-l  old-laptop · revoked here · pair from phone',
      '   nas  nas · needs its password',
      '   publi  public-box · Funnel is on',
    ]);
    const brightness = (page()?.boxes ?? []).flatMap((box) => (box.kind === 'text' && box.name.startsWith('row') ? [box.brightness] : []));
    expect(brightness).toEqual([2, 2, 4, 1, 1, 1]);
    for (let row = 0; row < 4; row += 1) await press({ type: 'down' });
    expect(text()[1]).toBe('> devbo  devbox · not answering');
    for (let row = 0; row < 4; row += 1) await press({ type: 'up' });
    await press({ type: 'press' });
    expect(text()).toEqual([
      "office-pc · can't join",
      "office-pc runs an older Pane, so these glasses can't join it by / themselves. / Update Pane on office-pc. It joins within 10 minutes.",
      'double press = back',
    ]);
    await press({ type: 'double' });
    expect(text()[3]).toBe('> offic  office-pc · update Pane there');
  });
});

describe('a new Session from the glasses', () => {
  const twoComputers: Computer[] = [
    { id: 'studio', name: 'studio-mac', status: 'live', lastSeenAt: 1, os: 'macOS', entries: [] },
    { id: 'build', name: 'build-box', status: 'live', lastSeenAt: 1, os: 'Linux', entries: [{ ...paneRow('nightly-backup'), activityAt: 1 }] },
  ];

  it('listens while you hold the first row, then starts the Session with your words as its purpose and opens it', async () => {
    const { source, text, press, stored } = startScripted();
    source.dictation = 'Find why checkout charges some carts twice';
    source.changed();
    expect(text()[1]).toBe('> + New Session on studio-mac · hold to say it');
    await press({ type: 'hold' });
    expect(text()).toEqual(['New Session on studio-mac · listening', '● Listening…', 'release = start   double press = cancel']);
    await press({ type: 'release' });
    await settle();
    expect(source.created).toEqual(['studio: Find why checkout charges some carts twice / Find why checkout charges some carts twice']);
    expect(text()[0]).toBe('Find why checkout charges some carts twice · shell · idle');
    expect(stored.computer).toBe('studio');
  });

  it('names the Session after the first eight words, on one line', async () => {
    const { source, press } = startScripted();
    source.dictation = 'Rotate every backup key before Friday,\nthen tell me which ones failed and why';
    source.changed();
    await press({ type: 'hold' });
    await press({ type: 'release' });
    expect(source.created).toEqual(['studio: Rotate every backup key before Friday, then tell / Rotate every backup key before Friday, then tell me which ones failed and why']);
  });

  it('starts nothing on a double press while listening', async () => {
    const { source, text, press, pages } = startScripted();
    source.dictation = 'Find why checkout charges some carts twice';
    source.changed();
    await press({ type: 'hold' });
    await press({ type: 'double' });
    expect(text()[1]).toBe('> + New Session on studio-mac · hold to say it');
    const shown = pages.length;
    await press({ type: 'release' });
    expect(source.created).toEqual([]);
    expect(pages.length).toBe(shown);
  });

  it('starts nothing on a double press while your last words are still being written down', async () => {
    const { source, text, press } = startScripted();
    let finish: (words: string) => void = () => {};
    source.dictate = async () => ({ push: () => {}, finish: () => new Promise<string>((resolve) => { finish = resolve; }), cancel: () => {} });
    source.changed();
    await press({ type: 'hold' });
    await press({ type: 'release' });
    await press({ type: 'double' });
    expect(text()[1]).toBe('> + New Session on studio-mac · hold to say it');
    finish('Find why checkout charges some carts twice');
    await settle();
    expect(source.created).toEqual([]);
    expect(text()[1]).toBe('> + New Session on studio-mac · hold to say it');
  });

  it('starts on the computer last started on, else that of the last Pane opened, else the first', async () => {
    const remembered = startScripted('build');
    remembered.source.computerList = twoComputers;
    remembered.source.changed();
    expect(remembered.text()[1]).toBe('> + New Session on build-box · hold to say it');

    const opened = startScripted('a computer no longer paired');
    opened.source.computerList = twoComputers;
    opened.source.changed();
    expect(opened.text()[1]).toBe('> + New Session on studio-mac · hold to say it');
    await opened.press({ type: 'down' });
    await opened.press({ type: 'press' });
    await opened.press({ type: 'double' });
    expect(opened.text()[1]).toBe('   + New Session on build-box · hold to say it');
  });

  it('says so and starts nothing when that computer is offline or its Pane is too old', async () => {
    const offline = startScripted('build');
    offline.source.computerList = [twoComputers[0], { ...twoComputers[1], status: 'offline' }];
    offline.source.dictation = 'Rotate the keys';
    offline.source.changed();
    await offline.press({ type: 'hold' });
    expect(offline.text()).toEqual(['New Session on build-box', 'build-box is offline, so no Session was started. / Hold again once it is back. /  / Double press to go back.']);
    expect(offline.source.created).toEqual([]);

    const older = startScripted();
    older.source.dictation = 'Rotate the keys';
    older.source.onCreate = () => {
      throw new GlassesError('ERR_GLASSES_SESSION_UNSUPPORTED', "studio-mac's Pane can't start a Session from the glasses yet, so none was started.", 'Update Pane on studio-mac.');
    };
    older.source.changed();
    await older.press({ type: 'hold' });
    await older.press({ type: 'release' });
    expect(older.text()[0]).toBe('New Session on studio-mac · not started');
    expect(older.text()[1]).toBe("studio-mac's Pane can't start a Session from the glasses yet, / so none was started. / Update Pane on studio-mac. /  / Double press to go back.");
    expect(older.stored.computer).toBeNull();
  });
});

describe('a refused computer', () => {
  it('is retried by a press on home, which shows it connecting rather than the same refusal', () => {
    const { app, source, text } = startScripted();
    source.computerList = [{ id: 'studio', name: 'studio-mac', status: 'refused', lastSeenAt: 1, os: 'macOS', entries: [], refusal: { code: 'ERR_GLASSES_ORIGIN_REFUSED', message: "studio-mac doesn't allow this app.", next: 'Allow it.' } }];
    source.changed();
    expect(text()[0]).toBe('studio-mac · not allowed');
    app.handle({ type: 'press' });
    expect(source.retried).toEqual(['studio']);
    // Retrying clears the refusal while the computer connects.
    source.computerList = [{ id: 'studio', name: 'studio-mac', status: 'connecting', lastSeenAt: 1, os: 'macOS', entries: [] }];
    source.changed();
    expect(text()[0]).toBe('Pane · 1 computer');
    expect(text()[1]).toBe('Connecting to your computers…');
  });
});

describe('an info card', () => {
  function withInfo() {
    const scripted = startScripted();
    scripted.source.rows = [paneRow('a')];
    scripted.source.cardList = [card('q1', 20), { ...card('i1', 10, false), title: 'Tests pass', context: 'All 212 tests pass on studio-mac.' }];
    scripted.source.changed();
    return scripted;
  }

  it('has a row below the questions that opens its message, and the row clears once read', async () => {
    const { text, press } = withInfo();
    expect(text()).toEqual(['All computers · 1 needs you', '   + New Session on studio-mac · hold to say it', '> studi  pane-q1 · needs you', '   studi  pane-i1 · Tests pass', '   studi  a · Claude · stopped', ' ', ' ']);
    await press({ type: 'down' });
    await press({ type: 'press' });
    expect(text()).toEqual(['pane-i1 · studio-mac', 'Tests pass /  / All 212 tests pass on studio-mac.', 'double press = back']);
    await press({ type: 'double' });
    expect(text().slice(0, 5)).toEqual(['All computers · 1 needs you', '   + New Session on studio-mac · hold to say it', '   studi  pane-q1 · needs you', '> studi  a · Claude · stopped', ' ']);
  });

  it('is what the terminal footer offers, and a double press there selects its row', async () => {
    const { text, press, source } = withInfo();
    source.cardList = source.cardList.filter((each) => each.waiting === false);
    source.changed();
    await press({ type: 'down' });
    await press({ type: 'down' });
    await press({ type: 'press' });
    expect(text().at(-1)).toBe('• pane-i1: Tests pass · double press for it');
    await press({ type: 'double' });
    expect(text()[2]).toBe('> studi  pane-i1 · Tests pass');
  });
});

describe('a new question', () => {
  it('takes the top row when it arrives while you are at the top', () => {
    const { source, text } = startScripted();
    source.rows = [paneRow('a')];
    source.changed();
    source.cardList = [card('q1', 10)];
    source.changed();
    expect(text().slice(0, 4)).toEqual(['All computers · 1 needs you', '   + New Session on studio-mac · hold to say it', '> studi  pane-q1 · needs you', '   studi  a · Claude · stopped']);
  });

  it('leaves the row you selected further down alone', () => {
    const { app, source, text } = startScripted();
    source.rows = [paneRow('a'), paneRow('b')];
    source.changed();
    app.handle({ type: 'down' });
    app.handle({ type: 'down' });
    source.cardList = [card('q1', 10)];
    source.changed();
    expect(text().slice(2, 5)).toEqual(['   studi  pane-q1 · needs you', '   studi  a · Claude · stopped', '> studi  b · Claude · stopped']);
  });
});
