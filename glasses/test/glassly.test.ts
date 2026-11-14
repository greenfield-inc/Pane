import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import type { GlassesCapabilities, RenderElement } from '@glassly/miniapp';
import { GlassesApp } from '../src/app';
import { DemoSource } from '../src/demo';
import { homeListPage, homeRows } from '../src/homeList';
import type { Card, Computer, PaneEntry } from '../src/model';
import type { Page } from '../src/page';
import { cardPage, fullQuestionPage } from '../src/screens';
import { pinnedPackage } from '../glassly/scripts/pinned';
import { ListFocus, renderPage, scrollableText } from '../glassly/src/background/render';
import { tierOf } from '../glassly/src/background/tier';
import { TouchMapper } from '../glassly/src/background/touch';
import { glasslyDictation } from '../glassly/src/background/transcription';
import { PaneActions, STAGED_MS, type Staged } from '../glassly/src/background/actions';
import { StatusWidget, summaryLine } from '../glassly/src/background/widget';
import { Notifier, SUMMARY_ID, meetingAt, type Asked, type Poster } from '../glassly/src/background/notifier';

/** Every device profile Glassly 0.4.0 ships, by file name, read from the pinned engine tarball. */
const profiles = new Map<string, GlassesCapabilities>();

beforeAll(async () => {
  const dir = join(await pinnedPackage('engine'), 'src', 'types', 'capabilities');
  for (const file of readdirSync(dir).filter((name) => name.endsWith('.ts') && name !== 'index.ts')) {
    // SAFETY: each file under capabilities/ exports its device's Capabilities object and nothing else.
    const module = (await import(pathToFileURL(join(dir, file)).href)) as Record<string, GlassesCapabilities>;
    const profile = Object.values(module).find((value) => Boolean(value.modelName));
    if (profile) profiles.set(file.replace(/\.ts$/, ''), profile);
  }
}, 60_000);

const profile = (name: string): GlassesCapabilities => {
  const found = profiles.get(name);
  if (!found) throw new Error(`No Glassly profile ${name}; have ${[...profiles.keys()].join(', ')}`);
  return found;
};

const text = (elements: RenderElement[]) => elements.flatMap((element) => (element.type === 'text' ? [element.text] : []));

const pane = (id: string, activityAt: number): PaneEntry => ({ kind: 'pane', id, name: id, agent: 'Claude', status: 'idle', panelId: `panel-${id}`, activityAt });
const computer = (entries: PaneEntry[]): Computer => ({ id: 'studio', name: 'studio-mac', status: 'live', lastSeenAt: null, os: 'macOS', entries });
const card: Card = {
  key: 'studio:q1', computerId: 'studio', machine: 'studio-mac', itemId: 'q1', ui: 'options', waiting: true,
  title: 'Which fix should land first?', choices: ['Stub the clock', 'Loosen retry', 'Mock the endpoint'], recommended: 1,
  suggestions: [], paneName: 'fix-login', createdAt: 1,
};

describe('device tiers', () => {
  it('gives stock G2 the full app within its six text elements, and the Simulated Glasses its larger budget', () => {
    expect(tierOf(profile('even-realities-g2'))).toEqual({ kind: 'full', budget: { maxText: 6 } });
    expect(tierOf(profile('simulated-glasses'))).toEqual({ kind: 'full', budget: { maxText: 120 } });
  });

  it('gives every glasses without a G2-sized screen and swipes the read-only glance', () => {
    for (const name of ['even-realities-g1', 'vuzix-z100', 'rayneo-io', 'mentra-display', 'memomind-one', 'nimo', 'mentra-live', 'none']) {
      expect([name, tierOf(profile(name)).kind]).toEqual([name, 'glance']);
    }
    expect(tierOf(null).kind).toBe('glance');
  });

  it("keeps every screen of the app within stock G2's element budget", async () => {
    const pages: Page[] = [];
    const app = new GlassesApp({
      source: new DemoSource(() => ({ cancel() {} })), show: (page) => pages.push(page), exit() {}, mic: async () => true,
      later: () => ({ cancel() {} }), now: () => Date.now(), clock: () => '9:40', lastSessionComputer: { read: () => null, write() {} },
    });
    const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
    for (const gesture of ['down', 'press', 'double', 'down', 'down', 'press', 'double', 'up', 'up', 'down', 'down', 'down', 'down', 'down', 'press'] as const) {
      app.handle({ type: gesture });
      await settle();
    }
    const budget = tierOf(profile('even-realities-g2'));
    if (budget.kind !== 'full') throw new Error('stock G2 should get the full app');
    expect(pages.length).toBeGreaterThan(5);
    for (const page of pages) {
      const elements = renderPage(page, new ListFocus().show(page), budget.budget);
      expect(elements.length).toBeLessThanOrEqual(6);
      expect(elements.every((element) => element.type === 'text')).toBe(true);
    }
  });
});

describe('the renderer', () => {
  it("draws home's six rows as one evenly spaced element, the selected row marked", () => {
    const rows = homeRows([computer(Array.from({ length: 6 }, (_, index) => pane(`p${index}`, 100 - index)))], []);
    const page = homeListPage(rows, { selected: 1 }, () => '9:40');
    expect(page.boxes.filter((box) => box.kind === 'text')).toHaveLength(7);
    const elements = renderPage(page, new ListFocus().show(page), { maxText: 6 });
    expect(elements).toHaveLength(2);
    expect(text(elements)[1]?.split('\n').map((line) => line.slice(0, 4))).toEqual(['   ○', '> ○ ', '   ○', '   ○', '   ○', '   ○']);
  });

  it('starts a card on its recommended choice, starred, and moves the highlight as firmware does', () => {
    const page = cardPage(card, []);
    const focus = new ListFocus();
    const choices = () => text(renderPage(page, focus.show(page), { maxText: 6 })).at(-1);
    expect(choices()).toBe('   Stub the clock\n> ★ Loosen retry\n   Mock the endpoint\n   Something else (hold to say it)');
    const list = page.boxes.find((box) => box.kind === 'list');
    if (list?.kind !== 'list') throw new Error('a card has a choice list');
    expect(focus.move(list, 1)).toBe(true);
    expect(focus.selectedIn(list)).toBe(2);
    expect(focus.move(list, 1)).toBe(true);
    expect(focus.move(list, 1)).toBe(false);
    // The same card drawn again keeps the highlight where the swipes left it.
    focus.show(cardPage(card, []));
    expect(focus.selectedIn(list)).toBe(3);
  });

  it('scrolls a question longer than the screen by swipe, as Even firmware scrolls its text box', () => {
    const long: Card = { ...card, title: Array.from({ length: 40 }, (_, index) => `Line ${index} of a long question.`).join(' ') };
    const page = fullQuestionPage(long);
    const box = scrollableText(page);
    if (!box) throw new Error('a long question scrolls');
    const focus = new ListFocus();
    const body = () => text(renderPage(page, focus.show(page), { maxText: 6 })).at(-1) ?? '';
    const first = body();
    expect(focus.scroll(box, -1)).toBe(false);
    expect(focus.scroll(box, 1)).toBe(true);
    expect(body()).not.toBe(first);
    expect(body().split('\n')[0]).toBe(first.split('\n').at(-1));
  });
});

describe('touch', () => {
  it('maps a held press and its release to hold to talk, and ignores the tap a release can bring', () => {
    let now = 0;
    const touch = new TouchMapper(() => now);
    expect(['single_tap', 'double_tap', 'swipe_up', 'swipe_down'].map((kind) => touch.gesture(kind)?.type)).toEqual(['press', 'double', 'up', 'down']);
    expect(touch.gesture('tap_start')).toEqual({ type: 'hold' });
    expect(touch.gesture('long_press')).toBeNull();
    now = 2_000;
    expect(touch.gesture('tap_end')).toEqual({ type: 'release' });
    now = 2_200;
    expect(touch.gesture('single_tap')).toBeNull();
    now = 3_000;
    expect(touch.gesture('single_tap')).toEqual({ type: 'press' });
    expect(touch.gesture('tap_end')).toBeNull();
  });
});

describe("Glassly's speech-to-text", () => {
  it('shows partial words while you speak and answers with every final phrase', async () => {
    let heard: (words: { text: string; isFinal: boolean }) => void = () => {};
    let stopped = false;
    const previews: string[] = [];
    const dictation = glasslyDictation((onHeard) => {
      heard = onHeard;
      return () => { stopped = true; };
    }, (fn) => {
      queueMicrotask(fn);
      return { cancel() {} };
    }, (preview) => previews.push(preview));
    const say = (words: string, isFinal: boolean) => heard({ text: words, isFinal });
    say('approve the', false);
    say('approve the nightly backup', true);
    say('and run', false);
    expect(previews.at(-1)).toBe('approve the nightly backup and run');
    expect(await dictation.finish()).toBe('approve the nightly backup and run');
    expect(stopped).toBe(true);
  });
});

describe('notifications', () => {
  const asked = (key: string): Asked => ({ key, title: `question ${key}`, from: 'studio-mac · fix-login' });
  const away = { inFront: false, inUse: false, meeting: null };
  function notifier(readAloud = false) {
    const calls: string[] = [];
    const poster: Poster = {
      post: async (notification) => { calls.push(`post ${notification.id}: ${notification.title}`); },
      dismiss: async (id) => { calls.push(`dismiss ${id}`); },
      speak: async (text) => { calls.push(`speak ${text}`); },
    };
    return { calls, notifier: new Notifier(poster, () => {}, () => readAloud) };
  }

  it('reads a posted question aloud only when read aloud is on, and never one it held back', () => {
    const quiet = notifier(false);
    quiet.notifier.update({ ...away, asked: [] });
    quiet.notifier.update({ ...away, asked: [asked('q1')] });
    expect(quiet.calls).toEqual(['post q1: question q1']);
    const loud = notifier(true);
    loud.notifier.update({ ...away, asked: [] });
    loud.notifier.update({ ...away, inUse: true, asked: [asked('typing')] });
    loud.notifier.update({ ...away, asked: [asked('q1'), asked('typing')] });
    expect(loud.calls).toEqual(['post q1: question q1', 'speak studio-mac · fix-login: question q1']);
  });

  it('posts each new question once while you are away, and withdraws it once answered anywhere', () => {
    const { calls, notifier: n } = notifier();
    n.update({ ...away, asked: [asked('old')] });
    n.update({ ...away, asked: [asked('q1'), asked('old')] });
    n.update({ ...away, asked: [asked('q1'), asked('old')] });
    n.update({ ...away, asked: [asked('old')] });
    expect(calls).toEqual(['post q1: question q1', 'dismiss q1']);
  });

  it('stays quiet while you use a computer or Pane is in front, and does not post those questions later', () => {
    const { calls, notifier: n } = notifier();
    n.update({ ...away, asked: [] });
    n.update({ ...away, inUse: true, asked: [asked('typing')] });
    n.update({ ...away, inFront: true, asked: [asked('front'), asked('typing')] });
    n.update({ ...away, asked: [asked('later'), asked('front'), asked('typing')] });
    expect(calls).toEqual(['post later: question later']);
  });

  it('holds questions during a meeting, then says how many waited and where you were', () => {
    const { calls, notifier: n } = notifier();
    n.update({ ...away, asked: [] });
    n.update({ ...away, meeting: { title: 'Design review' }, asked: [asked('a')] });
    n.update({ ...away, meeting: { title: 'Design review' }, asked: [asked('b'), asked('a')] });
    expect(calls).toEqual([]);
    n.update({ ...away, asked: [asked('b'), asked('a')] });
    expect(calls).toEqual([`post ${SUMMARY_ID}: 2 questions waited while you were in Design review`]);
  });

  it('opens on the newest question it posted', () => {
    const { notifier: n } = notifier();
    n.update({ ...away, asked: [] });
    n.update({ ...away, asked: [asked('q1')] });
    n.update({ ...away, asked: [asked('q2'), asked('q1')] });
    expect(n.opened()).toBe('q2');
    expect(n.opened()).toBeNull();
  });

  it('stops trying after a Glassly App that cannot post refuses once', async () => {
    let posts = 0;
    const n = new Notifier({ post: async () => { posts += 1; throw new Error('unknown request'); }, dismiss: async () => {}, speak: async () => {} });
    n.update({ ...away, asked: [] });
    n.update({ ...away, asked: [asked('q1')] });
    await new Promise((resolve) => setTimeout(resolve, 0));
    n.update({ ...away, asked: [asked('q2'), asked('q1')] });
    expect(posts).toBe(1);
  });

  it('counts only timed events as meetings', () => {
    const at = Date.parse('2026-11-14T10:30:00Z');
    expect(meetingAt([{ title: 'Offsite', startsAt: '2026-11-14T00:00:00Z', endsAt: '2026-11-15T00:00:00Z', allDay: true }], at)).toBeNull();
    expect(meetingAt([{ title: 'Design review', startsAt: '2026-11-14T10:00:00Z', endsAt: '2026-11-14T11:00:00Z', allDay: false }], at)).toEqual({ title: 'Design review' });
    expect(meetingAt([{ title: 'Design review', startsAt: '2026-11-14T10:00:00Z', endsAt: '2026-11-14T10:30:00Z', allDay: false }], at)).toBeNull();
  });
});

describe('Actions for Glassly AI', () => {
  async function demoActions() {
    const source = new DemoSource(() => ({ cancel() {} }));
    // The demo stands in for paired computers here; Actions refuse a real demo.
    Object.defineProperty(source, 'demo', { value: false });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const staged: Staged[] = [];
    const answered: string[] = [];
    source.answer = async (card) => { answered.push(card.key); };
    const actions = new PaneActions({ source: () => source, now: () => 1_000, stage: (request) => staged.push(request) });
    return { source, actions, staged, answered };
  }

  it("answers only Glassly's assistant", async () => {
    const { actions } = await demoActions();
    expect(actions.handle('list_waiting', {}, 'com.example.other')).toEqual({ ok: false, error: "Pane's actions answer only Glassly's assistant." });
    expect(actions.handle('list_waiting', {}, 'com.glassly.assistant')).toMatchObject({ ok: true });
  });

  it('lists what the glasses list, and nothing more', async () => {
    const { actions, source } = await demoActions();
    const result = actions.handle('list_waiting', {}, 'com.glassly.assistant');
    const waiting = source.cards().filter((card) => card.waiting);
    expect(result).toEqual({ ok: true, waiting: waiting.map((card) => ({ computer: card.machine, pane: card.paneName, question: card.title, choices: card.ui === 'approve' ? ['Approve', 'Not yet'] : card.choices })) });
  });

  it('stages an answer for one press on the glasses, selected on its card, and sends nothing itself', async () => {
    const { actions, staged, answered } = await demoActions();
    expect(actions.handle('answer_card', { pane: 'token-refresh', answer: 'mock the endpoint' }, 'com.glassly.assistant')).toEqual({ ok: true, message: 'Waiting for you to confirm on the glasses: open Pane and press once.' });
    expect(staged).toEqual([{ show: { kind: 'card', key: expect.stringContaining('q2'), choice: 2 }, title: 'Confirm on the glasses: token-refresh → Mock the endpoint', expiresAt: 1_000 + STAGED_MS }]);
    expect(answered).toEqual([]);
  });

  it('stages free words and a new Session as requests to confirm, starting nothing', async () => {
    const { actions, staged, source } = await demoActions();
    let started = 0;
    source.createSession = async () => { started += 1; throw new Error('not here'); };
    actions.handle('answer_card', { pane: 'fix-login', answer: 'stub it and rerun' }, 'com.glassly.ai');
    actions.handle('start_session', { goal: 'Find why checkout charges twice' }, 'com.glassly.ai');
    expect(staged.map((request) => request.show.kind === 'confirm' && request.show.request.kind)).toEqual(['answer', 'session']);
    expect(started).toBe(0);
  });
});

describe('the dashboard widget', () => {
  async function widgetOn() {
    const source = new DemoSource(() => ({ cancel() {} }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    const timers: Array<() => void> = [];
    const answered: Array<[string, unknown]> = [];
    const widget = new StatusWidget({
      source: () => source,
      later: (fn) => { timers.push(fn); return { cancel: () => { timers.splice(timers.indexOf(fn), 1); } }; },
      answer: async (card, answer) => { answered.push([card.paneName, answer]); },
      redraw: () => {},
    });
    return { source, widget, timers, answered };
  }
  const shown = (elements: RenderElement[]) => text(elements).join('\n');

  it('shows how many agents work and wait, and the newest question', async () => {
    const { widget, source } = await widgetOn();
    const newest = source.cards().find((card) => card.waiting);
    expect(shown(widget.card({ width: 300, height: 80 }))).toBe(`Pane · ${summaryLine(source)}\n${newest?.paneName}: ${newest?.title}`);
  });

  it('answers from the expanded view only after the undo hold, and a second tap takes it back', async () => {
    const { widget, timers, answered } = await widgetOn();
    const box = { width: 576, height: 288 };
    expect(shown(widget.expanded(box))).toContain('> ');
    widget.input({ type: 'swipe', direction: 'down' });
    widget.input({ type: 'tap' });
    expect(shown(widget.expanded(box))).toContain('Sent · tap to undo');
    widget.input({ type: 'tap' });
    expect(timers).toHaveLength(0);
    widget.input({ type: 'tap' });
    timers.shift()?.();
    expect(answered).toHaveLength(1);
  });
});
