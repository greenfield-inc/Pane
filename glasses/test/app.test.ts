import { describe, expect, it } from 'vitest';
import { GlassesApp } from '../src/app';
import { DemoSource } from '../src/demo';
import type { Page } from '../src/display';
import type { Gesture } from '../src/input';
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
    expect(started.text()[1]).toContain('Session · even g2 app · idle | fix-login · Claude · working');
    await started.press({ type: 'select', index: 1 });
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
