import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { GlassesApp } from '../src/app';
import { DemoSource } from '../src/demo';
import type { Page } from '../src/display';
import type { Gesture } from '../src/input';
import { GlassesError, orderCards, type Card, type Computer, type Dictation, type PaneEntry, type PaneRow, type PaneSource, type TerminalKey, type TerminalScreen } from '../src/model';
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
  return { app, source, clock, text, output: () => outputOf(pages.at(-1)), press, mic, exits: () => exits };
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
    const { text, output } = await openFixLogin();
    expect(text()[0]).toBe('fix-login · Claude · working');
    expect(output()).toContain('expected 200, got 401');
    expect(text().at(-1)).toBe('? token-refresh needs you · double press for cards');
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
  screenLines: string[] = [];
  savedOutput: string[] = [];
  async screen(): Promise<TerminalScreen> { return { lines: this.screenLines, status: this.screenStatus, agent: 'shell' }; }
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
  async key(_computerId: string, _panelId: string, key: TerminalKey) {
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
  const page = () => pages.at(-1);
  return { app, source, text, output: () => outputOf(pages.at(-1)), page, pages, press, clock };
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
    await scripted.press({ type: 'press' });
    await scripted.press({ type: 'select', index: 0 });
    await scripted.press({ type: 'select', index: 0 });
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
    await scripted.press({ type: 'press' });
    await scripted.press({ type: 'select', index: 0 });
    await scripted.press({ type: 'select', index: 0 });
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

  it('still names a card from another Pane in the footer', async () => {
    const { source, text } = await openKeys();
    source.cardList = [card('q1', 10)];
    source.changed();
    expect(text().at(-1)).toBe('? pane-q1 needs you · double press for cards');
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
    await scripted.press({ type: 'press' });
    await scripted.press({ type: 'select', index: 0 });
    await scripted.press({ type: 'select', index: 0 });
    return scripted;
  }

  it('lists the choices of a menu it is certain of, under the question', async () => {
    const { text } = await openMenu();
    expect(text()[0]).toBe('fix-login · pick one · double = dismiss');
    expect(text()[1]).toBe('Do you want to proceed?');
    expect(text()[2]?.split(' | ')[0]).toBe('1. Yes');
    expect(text()[2]?.split(' | ')[3]).toBe('4. No');
  });

  it('picks with arrows, checking the cursor moved before each next key, then Enter', async () => {
    const { source, press, text } = await openMenu();
    let cursor = 0;
    source.onKey = (key) => {
      if (key === 'down') cursor += 1;
      source.screenLines = key === 'enter' ? ['⏺ Bash(touch bye.txt)', '  ⎿  (No output)'] : permission(cursor);
    };
    await press({ type: 'select', index: 3 });
    expect(source.keys).toEqual(['down', 'down', 'down', 'enter']);
    expect(text()[0]).toBe('fix-login · shell · idle');
  });

  it('sends nothing when the menu changed between showing and the pick', async () => {
    const { source, press, text } = await openMenu();
    source.screenLines = fixture('codex-approval');
    await press({ type: 'select', index: 1 });
    expect(source.keys).toEqual([]);
    expect(text()[0]).toBe('KEYS · swipe ↑↓ · press Enter · hold Esc/Tab');
    expect(text().at(-1)).toBe('The menu changed, so nothing more was sent');
  });

  it('stops before Enter when the cursor does not move', async () => {
    const { source, press, text, clock } = await openMenu();
    await press({ type: 'select', index: 2 });
    expect(text()[0]).toBe('fix-login · picking…');
    await clock.advance(2_000);
    expect(source.keys).toEqual(['down']);
    expect(text().at(-1)).toBe('The menu changed, so nothing more was sent');
  });

  it('sends nothing when a different question shows the same choices', async () => {
    const { source, press, text } = await openMenu();
    source.screenLines = permission(0).map((line) => line.replace('Do you want to proceed?', 'Do you want to delete the repo?'));
    await press({ type: 'select', index: 0 });
    expect(source.keys).toEqual([]);
    expect(text().at(-1)).toBe('The menu changed, so nothing more was sent');
  });

  it('ignores hold while a pick is sending keys', async () => {
    const { source, press, text, clock } = await openMenu();
    source.dictation = 'hello';
    await press({ type: 'select', index: 2 });
    await press({ type: 'hold' });
    expect(text()[0]).toBe('fix-login · picking…');
    await clock.advance(2_000);
    expect(text()[0]).toBe('KEYS · swipe ↑↓ · press Enter · hold Esc/Tab');
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
    await scripted.press({ type: 'press' });
    await scripted.press({ type: 'select', index: 0 });
    await scripted.press({ type: 'select', index: 0 });
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
    for (let page = 0; page < 5; page += 1) await press({ type: 'down' });
    await press({ type: 'press' });
    await press({ type: 'select', index: 0 });
    await press({ type: 'select', index: 3 });
    expect(text()[0]).toBe('docs-pass · pick one · double = dismiss');
    expect(text()[2]).toBe('1. Yes, push and open the PR | 2. Not yet');
    await press({ type: 'select', index: 1 });
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
