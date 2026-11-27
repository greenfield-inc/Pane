import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { appendFileSync, chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { dismissDialogs, isolatedPane, launchIsolated, type IsolatedPane } from './isolatedPane';
import type { SwitchMark } from '../shared/switchMarks';

declare global {
  /** The rAF probe's result for the switch in flight (switchTo below). */
  var __paneSwitchProbe: ProbeResult | undefined;
}

/**
 * Session switch latency and retained memory (T-87 Phase 0). Runs under
 * playwright.session-switch.config.ts only: real Electron, an isolated Pane (D-288), the
 * production renderer (frontend/dist via vite preview) and the scripted ACP agent.
 *
 * - Timing is reported only: every sample lands in `session-switch.json` and the summary
 *   table, and nothing fails on a number of milliseconds yet.
 * - Hard checks, none of them timing: each switch shows its Session's last message, mounts
 *   its chat at most once, Enter puts focus in the composer, and switching leaves at most
 *   MAX_RETAINED_NODES_PER_SWITCH DOM nodes behind after a forced GC.
 *
 * To add a path (P1's arrow keys), add a Trigger; to add a case, add a Scenario.
 */

const AGENT = path.resolve('main/src/services/chatTabs/testing/scriptedAgent.mjs');
const OUT = path.resolve(process.env.SESSION_SWITCH_OUT ?? 'test-results/session-switch');
const MAX_RETAINED_NODES_PER_SWITCH = 200;
const RETENTION_SWITCHES = 50;

test.skip(!process.env.PANE_SWITCH_BENCH, 'Runs under playwright.session-switch.config.ts (production renderer).');
test.describe.configure({ mode: 'serial' });

// ---------------------------------------------------------------------------
// Fixture: 13 short (20 messages), 10 long (1000) and 2 extra-long (2000) chat Sessions.

type Size = 'short' | 'long' | 'xl';
interface Seeded { name: string; id: string; panelId: string; size: Size; messages: number }
interface Fixture { pane: IsolatedPane; sessions: Seeded[] }

/** Turns per Session; each turn is 4 messages: a request, two tool calls with output, and a markdown reply. */
const PLAN: Array<{ size: Size; count: number; turns: number }> = [
  { size: 'short', count: 13, turns: 5 },
  { size: 'long', count: 10, turns: 250 },
  { size: 'xl', count: 2, turns: 500 },
];

const endMark = (session: Seeded) => `END-MARK-${session.name}`;

/** ACP updates the scripted agent replays on session/load: a long, realistic conversation. */
function conversation(turns: number, mark: string): unknown[] {
  const updates: unknown[] = [];
  for (let turn = 0; turn < turns; turn++) {
    const feature = `feature${turn % 11}`;
    updates.push({ sessionUpdate: 'user_message_chunk', content: { type: 'text', text: `Turn ${turn}: please look at module ${turn % 37} and fix the failing test in \`src/${feature}.ts\`. Keep the API stable.` } });
    for (const [kind, title] of [['read', `Read src/${feature}.ts`], ['execute', `pnpm vitest run src/${feature}.test.ts`]] as const) {
      const toolCallId = `tool-${randomUUID()}`;
      const output = Array.from({ length: 12 }, (_, line) => `${line + 1}  const value${line} = compute(${line}, options); // output line ${line}`).join('\n');
      updates.push({ sessionUpdate: 'tool_call', toolCallId, title, kind, status: 'in_progress', rawInput: kind === 'execute' ? { command: title } : { file_path: title.slice(5) } });
      updates.push({ sessionUpdate: 'tool_call_update', toolCallId, status: 'completed', content: [{ type: 'content', content: { type: 'text', text: output } }] });
    }
    const text = [
      `I found the problem in **${feature}**. The test failed because \`compute\` returned a stale value after the cache was cleared.`,
      '',
      '- The cache key ignored `options.locale`.',
      '- `reset()` cleared the map but not the pending promise.',
      '- The test relied on timer order.',
      '',
      '```ts',
      `export function compute${turn}(input: number, options: Options): number {`,
      '  const key = `${input}:${options.locale}`;',
      '  const cached = cache.get(key);',
      '  if (cached !== undefined) return cached;',
      '  const value = expensive(input, options);',
      '  cache.set(key, value);',
      '  return value;',
      '}',
      '```',
      '',
      `Tests pass now (${(turn % 50) + 3} passed). ${turn === turns - 1 ? mark : ''}`,
    ].join('\n');
    updates.push({ sessionUpdate: 'agent_message_chunk', messageId: randomUUID(), content: { type: 'text', text } });
  }
  return updates;
}

/** A `claude` stand-in on PATH, so creating a Claude Session never runs a real one. */
function withFakeClaude(pane: IsolatedPane): void {
  const bin = path.join(pane.root, 'fake-bin');
  mkdirSync(bin, { recursive: true });
  writeFileSync(path.join(bin, 'claude'), '#!/bin/sh\nif [ "$1" = "--version" ]; then echo "2.1.999 (Claude Code)"; exit 0; fi\necho "stand-in claude"\nexit 1\n');
  chmodSync(path.join(bin, 'claude'), 0o755);
  pane.env.PATH = `${bin}${path.delimiter}${pane.env.PATH}`;
}

async function launch(pane: IsolatedPane, baseURL: string | undefined): Promise<{ app: ElectronApplication; page: Page }> {
  const launched = await launchIsolated(pane, baseURL, { PANE_CHAT_TEST_AGENT: AGENT });
  await dismissDialogs(launched.page);
  await launched.page.evaluate(() => { globalThis.__paneSwitchMarks = []; });
  return launched;
}

let seeded: Promise<Fixture> | undefined;

/** Creates the Sessions once per run, then rewrites each scripted agent's stored history. */
function fixture(baseURL: string | undefined): Promise<Fixture> {
  if (!existsSync(path.resolve('frontend/dist/index.html'))) {
    throw new Error('The Session switch benchmark serves the production renderer, and frontend/dist has none, so nothing was launched. Run `pnpm build:frontend`, then run it again.');
  }
  seeded ??= (async () => {
    const pane = isolatedPane('session-switch');
    withFakeClaude(pane);
    const store = path.join(pane.paneDir, 'scripted-agent');
    const listStore = () => (existsSync(store) ? readdirSync(store) : []);
    const sessions: Array<Seeded & { acp: string; turns: number }> = [];
    const { app, page } = await launch(pane, baseURL);
    try {
      await page.evaluate(async () => { await window.electronAPI.config.update({ chatTabsEnabled: true }); });
      for (const { size, count, turns } of PLAN) {
        for (let index = 1; index <= count; index++) {
          const name = `${size}-${String(index).padStart(2, '0')}`;
          const before = new Set(listStore());
          const view = await page.evaluate(async sessionName => {
            const result = await window.electronAPI.orchestrationSessions.create({ name: sessionName, agent: 'claude' });
            // SAFETY: orchestration-sessions:create returns an OrchestrationSessionView in `data` when it succeeds.
            const data = result.data as { session: { id: string }; panel: { id: string } } | undefined;
            if (!data) throw new Error(`Creating Session ${sessionName} failed: ${JSON.stringify(result)}`);
            return { id: data.session.id, panelId: data.panel.id };
          }, name);
          const fresh = () => listStore().filter(file => !before.has(file));
          // The chat's agent starts with the Session, or else once the Session is shown.
          await expect.poll(() => fresh().length, { timeout: 8_000 }).toBeGreaterThan(0).catch(async () => {
            await page.getByTestId(`orchestration-session-${view.id}`).click();
            await expect.poll(() => fresh().length, { timeout: 20_000 }).toBeGreaterThan(0);
          });
          expect(fresh(), `one scripted-agent store for ${name}`).toHaveLength(1);
          sessions.push({ name, ...view, size, messages: turns * 4, acp: fresh()[0].replace(/\.json$/, ''), turns });
        }
      }
    } finally {
      await app.close().catch(() => undefined);
    }
    for (const session of sessions) {
      const file = path.join(store, `${session.acp}.json`);
      const saved: { updates?: unknown[] } = JSON.parse(readFileSync(file, 'utf8'));
      saved.updates = conversation(session.turns, endMark(session));
      writeFileSync(file, JSON.stringify(saved));
    }
    // Each chat replays its new history once and saves its newest messages beside it (F-lite,
    // T-87), so after the next launch a Session the cursor passes over can show them without
    // starting its agent. A build without F-lite just starts and stops each agent here.
    const warm = await launch(pane, baseURL);
    try {
      for (const session of sessions) {
        await warm.page.getByTestId(`orchestration-session-${session.id}`).click();
        await expect(warm.page.locator('[aria-label="Conversation messages"]').filter({ hasText: endMark(session) }).first()).toBeVisible({ timeout: 60_000 });
      }
      await warm.page.waitForTimeout(2_000);
    } finally {
      await warm.app.close().catch(() => undefined);
    }
    return { pane, sessions: sessions.map(({ name, id, panelId, size, messages }) => ({ name, id, panelId, size, messages })) };
  })();
  return seeded;
}

// ---------------------------------------------------------------------------
// One switch: the trigger, an in-page rAF probe for "visible", and the stage marks.

/** How a switch starts. t0 is the trigger's first input event (click or keydown, capture phase). */
type Trigger = 'click' | 'enter' | 'down' | 'up';
interface TriggerSpec { focuses: boolean; run: (page: Page, row: ReturnType<Page['getByTestId']>) => Promise<void> }
const TRIGGERS = {
  click: { focuses: false, run: async (_page, row) => { await row.click(); } },
  // Enter on a focused row (regionFocus.ts): opens the Session and moves focus into its composer.
  enter: { focuses: true, run: async (page, row) => { await row.focus(); await page.keyboard.press('Enter'); } },
  // The sidebar cursor (T-87): the row above or below holds focus, and the arrow shows this Session.
  down: { focuses: false, run: async page => { await page.keyboard.press('ArrowDown'); } },
  up: { focuses: false, run: async page => { await page.keyboard.press('ArrowUp'); } },
} satisfies Record<Trigger, TriggerSpec>;

interface Sample {
  scenario: string;
  session: string;
  size: Size;
  trigger: Trigger;
  /** ms from t0. visible: the first frame with the composer and the last message laid out; painted: the frame after. */
  visible: number | null;
  painted: number | null;
  focused: number | null;
  sessionGet: number | null;
  panelsLoaded: number | null;
  chatMount: number | null;
  chatGetStart: number | null;
  chatGetEnd: number | null;
  chatGetStatus: string | null;
  chatReady: number | null;
  firstCommit: number | null;
  /** Painted from the viewer's closed-chat cache before chat-tab:get returned. */
  cacheHit: boolean;
  chatMounts: number;
  marks: Array<[string, number]>;
}

interface ProbeResult { input?: number; visible?: number; painted?: number; focused?: number; timedOut?: boolean }

async function switchTo(page: Page, session: Seeded, trigger: Trigger, scenario: string, probeMs = 60_000): Promise<Sample> {
  const row = page.getByTestId(`orchestration-session-${session.id}`);
  // An arrow moves from the focused row; scrolling the target first would not change that.
  if (trigger === 'click' || trigger === 'enter') await row.scrollIntoViewIfNeeded();
  await page.evaluate(({ panelId, mark, focuses, probeMs }) => {
    globalThis.__paneSwitchMarks = [];
    const done: ProbeResult = {};
    globalThis.__paneSwitchProbe = done;
    const started = performance.now();
    const input = (event: Event) => { done.input ??= event.timeStamp; };
    window.addEventListener('click', input, { capture: true, once: true });
    window.addEventListener('keydown', input, { capture: true, once: true });
    const laidOut = (element: Element | null | undefined) => !!element && element.getClientRects().length > 0;
    /** The last message's marker is inside the conversation's scroll viewport, not just somewhere in its text. */
    const markerOnScreen = (region: Element) => {
      if (!laidOut(region) || !region.textContent?.includes(mark)) return false;
      const viewport = region.getBoundingClientRect();
      const walker = document.createTreeWalker(region, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        if (!node.textContent?.includes(mark)) continue;
        const range = document.createRange();
        range.selectNodeContents(node);
        const text = range.getBoundingClientRect();
        return text.height > 0 && text.bottom > viewport.top && text.top < viewport.bottom;
      }
      return false;
    };
    const tick = () => {
      const now = performance.now();
      const composer = document.querySelector<HTMLTextAreaElement>(`textarea[data-chat-composer="${CSS.escape(panelId)}"]`);
      if (done.visible === undefined && laidOut(composer)) {
        if (Array.from(document.querySelectorAll('[aria-label="Conversation messages"]')).some(markerOnScreen)) done.visible = now;
      } else if (done.visible !== undefined && done.painted === undefined && now > done.visible) done.painted = now;
      if (focuses && done.focused === undefined && composer && document.activeElement === composer) done.focused = now;
      const finished = done.painted !== undefined && (!focuses || done.focused !== undefined);
      if (finished || now - started > probeMs) {
        done.timedOut = !finished;
        window.removeEventListener('click', input, { capture: true });
        window.removeEventListener('keydown', input, { capture: true });
        return;
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }, { panelId: session.panelId, mark: endMark(session), focuses: TRIGGERS[trigger].focuses, probeMs });
  await TRIGGERS[trigger].run(page, row);
  await page.waitForFunction(() => globalThis.__paneSwitchProbe?.timedOut !== undefined, undefined, { timeout: 90_000, polling: 50 });
  const { done, marks } = await page.evaluate(() => ({ done: globalThis.__paneSwitchProbe ?? {}, marks: globalThis.__paneSwitchMarks ?? [] }));
  const t0 = done.input ?? marks.find(mark => mark.name === 'open')?.t ?? NaN;
  const since = (t: number | undefined) => (t === undefined || Number.isNaN(t0) ? null : +(t - t0).toFixed(1));
  const ownPanel = (mark: SwitchMark) => mark.detail.panelId === session.panelId;
  const ownSession = (mark: SwitchMark) => mark.detail.sessionId === session.id;
  const find = (name: string, own: (mark: SwitchMark) => boolean) => marks.find(mark => mark.name === name && own(mark));
  const chatGetEnd = find('chat:get:end', ownPanel);
  const commit = marks.find(mark => mark.name === 'chat:commit' && ownPanel(mark) && (mark.detail.n ?? 0) > 0);
  return {
    scenario,
    session: session.name,
    size: session.size,
    trigger,
    visible: since(done.visible),
    painted: since(done.painted),
    focused: since(done.focused),
    sessionGet: since(find('session:get:end', ownSession)?.t),
    panelsLoaded: since(marks.find(mark => mark.name === 'panels:loaded')?.t),
    chatMount: since(find('chat:mount', ownPanel)?.t),
    chatGetStart: since(find('chat:get:start', ownPanel)?.t),
    chatGetEnd: since(chatGetEnd?.t),
    chatGetStatus: chatGetEnd?.detail.status ?? null,
    chatReady: since(find('chat:ready', ownPanel)?.t),
    firstCommit: since(commit?.t),
    // A commit before the read answered, or while it is still in flight, painted from the cache.
    cacheHit: !!commit && (!chatGetEnd || commit.t <= chatGetEnd.t),
    chatMounts: marks.filter(mark => mark.name === 'chat:mount' && ownPanel(mark)).length,
    marks: marks.map(mark => [mark.name, since(mark.t) ?? NaN]),
  };
}

// ---------------------------------------------------------------------------
// Scenarios. Each visits Sessions in order; the first `warmup` samples are dropped.
// First visits run first, while no chat's agent is running yet.

interface Scenario { name: string; trigger: Trigger; warmup: number; visits: (sessions: Seeded[]) => Seeded[] }

const bySize = (sessions: Seeded[], size: Size) => sessions.filter(session => session.size === size);
const pingPong = (a: Seeded, b: Seeded, count: number) => Array.from({ length: count }, (_, index) => (index % 2 === 0 ? a : b));
const SAMPLES = 20;
const WARMUP = 2;

const SCENARIOS: Scenario[] = [
  // A Session not opened since launch: its agent starts and replays its history.
  { name: 'first-short', trigger: 'click', warmup: 0, visits: sessions => bySize(sessions, 'short').slice(1) },
  { name: 'first-long', trigger: 'click', warmup: 0, visits: sessions => bySize(sessions, 'long') },
  { name: 'first-xl', trigger: 'click', warmup: 0, visits: sessions => bySize(sessions, 'xl') },
  // Back and forth between two Sessions whose agents run: the closed-chat cache holds both.
  { name: 'warm-short-click', trigger: 'click', warmup: WARMUP, visits: sessions => pingPong(bySize(sessions, 'short')[0], bySize(sessions, 'short')[1], WARMUP + SAMPLES) },
  { name: 'warm-long-click', trigger: 'click', warmup: WARMUP, visits: sessions => pingPong(bySize(sessions, 'long')[0], bySize(sessions, 'long')[1], WARMUP + SAMPLES) },
  { name: 'warm-xl-click', trigger: 'click', warmup: WARMUP, visits: sessions => pingPong(bySize(sessions, 'xl')[0], bySize(sessions, 'xl')[1], WARMUP + SAMPLES) },
  { name: 'warm-long-enter', trigger: 'enter', warmup: WARMUP, visits: sessions => pingPong(bySize(sessions, 'long')[0], bySize(sessions, 'long')[1], WARMUP + SAMPLES) },
];

// ---------------------------------------------------------------------------
// Reporting

function percentile(values: number[], p: number): number | null {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  return sorted[Math.max(0, Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1))];
}

interface Summary { scenario: string; n: number; cacheHits: number; visibleP50: number | null; visibleP95: number | null; paintedP50: number | null; focusedP50: number | null; commitP50: number | null }

function summarize(samples: Sample[]): Summary[] {
  return [...new Set(samples.map(sample => sample.scenario))].map(scenario => {
    const rows = samples.filter(sample => sample.scenario === scenario);
    const column = (pick: (sample: Sample) => number | null) => rows.map(pick).filter((value): value is number => value !== null);
    return {
      scenario,
      n: rows.length,
      cacheHits: rows.filter(row => row.cacheHit).length,
      visibleP50: percentile(column(row => row.visible), 50),
      visibleP95: percentile(column(row => row.visible), 95),
      paintedP50: percentile(column(row => row.painted), 50),
      focusedP50: percentile(column(row => row.focused), 50),
      commitP50: percentile(column(row => row.firstCommit), 50),
    };
  });
}

const ms = (value: number | null) => (value === null ? '–' : String(Math.round(value)));

function markdown(summary: Summary[], retention: Retention | undefined, arrowRetention?: Retention): string {
  const lines = [
    '### Session switch latency (reported only)',
    '',
    '| Scenario | n | cache hits | visible p50 / p95 (ms) | painted p50 | focused p50 | first commit p50 |',
    '|---|---|---|---|---|---|---|',
    ...summary.map(row => `| ${row.scenario} | ${row.n} | ${row.cacheHits}/${row.n} | **${ms(row.visibleP50)} / ${ms(row.visibleP95)}** | ${ms(row.paintedP50)} | ${ms(row.focusedP50)} | ${ms(row.commitP50)} |`),
  ];
  if (arrowRetention) {
    lines.push('', `Arrow keys: retained after ${arrowRetention.switches} switches and a forced GC, per switch: **${arrowRetention.perSwitch.nodes} DOM nodes** (limit ${MAX_RETAINED_NODES_PER_SWITCH}), ${arrowRetention.perSwitch.listeners} listeners, ${arrowRetention.perSwitch.heapMB} MB heap.`);
  }
  if (retention) {
    lines.push('', `Retained after ${retention.switches} switches and a forced GC, per switch: **${retention.perSwitch.nodes} DOM nodes** (limit ${MAX_RETAINED_NODES_PER_SWITCH}), ${retention.perSwitch.listeners} listeners, ${retention.perSwitch.heapMB} MB heap.`);
  }
  return `${lines.join('\n')}\n`;
}

interface Meta { commit: string; branch: string; platform: string; renderer: string; at: string }
interface Report { meta?: Meta; summary: Summary[]; samples: Sample[]; retention?: Retention; arrowRetention?: Retention }
const report: Report = { summary: [], samples: [] };

/** Writes session-switch.json (every sample) and session-switch.md (the table); returns the table. */
function writeReport(): string {
  mkdirSync(OUT, { recursive: true });
  report.summary = summarize(report.samples);
  writeFileSync(path.join(OUT, 'session-switch.json'), JSON.stringify(report, null, 2));
  const table = markdown(report.summary, report.retention, report.arrowRetention);
  writeFileSync(path.join(OUT, 'session-switch.md'), table);
  return table;
}

function meta(): Meta {
  const git = (args: string[]) => { try { return execFileSync('git', args, { encoding: 'utf8' }).trim(); } catch { return ''; } };
  return { commit: git(['rev-parse', 'HEAD']), branch: git(['rev-parse', '--abbrev-ref', 'HEAD']), platform: `${process.platform}-${process.arch}`, renderer: 'production (frontend/dist via vite preview)', at: new Date().toISOString() };
}

// ---------------------------------------------------------------------------
// Memory: CDP forced GC, then the renderer's counters.

interface Counters { heapMB: number; nodes: number; listeners: number }
interface Retention { switches: number; before: Counters; after: Counters; perSwitch: { nodes: number; listeners: number; heapMB: number } }

async function countersAfterGc(app: ElectronApplication): Promise<Counters> {
  return app.evaluate(async ({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows().find(candidate => !candidate.webContents.getURL().includes('notify.html'));
    if (!window) throw new Error('No Pane window to measure.');
    const debug = window.webContents.debugger;
    if (!debug.isAttached()) debug.attach('1.3');
    // Twice: the first collection can leave objects that a finalizer freed for the second.
    await debug.sendCommand('HeapProfiler.collectGarbage');
    await debug.sendCommand('HeapProfiler.collectGarbage');
    await debug.sendCommand('Performance.enable');
    const { metrics }: { metrics: Array<{ name: string; value: number }> } = await debug.sendCommand('Performance.getMetrics');
    const value = (name: string) => metrics.find(metric => metric.name === name)?.value ?? NaN;
    return { heapMB: +(value('JSHeapUsedSize') / 1048576).toFixed(2), nodes: value('Nodes'), listeners: value('JSEventListeners') };
  });
}

// ---------------------------------------------------------------------------

test.afterAll(() => {
  if (report.samples.length === 0 && !report.retention && !report.arrowRetention) return;
  const table = writeReport();
  console.log(`\n${table}\nSamples: ${path.join(OUT, 'session-switch.json')}`);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, table);
});

test('click and Enter → chat visible, every scenario (timing reported only)', async ({ baseURL }) => {
  test.setTimeout(15 * 60_000);
  const { pane, sessions } = await fixture(baseURL);
  report.meta = meta();
  const { app, page } = await launch(pane, baseURL);
  try {
    // A Session to start from, outside the samples.
    await switchTo(page, bySize(sessions, 'short')[0], 'click', 'start');
    for (const scenario of SCENARIOS) {
      const visits = scenario.visits(sessions);
      for (const [index, session] of visits.entries()) {
        const sample = await switchTo(page, session, scenario.trigger, scenario.name);
        expect(sample.visible, `${scenario.name}: ${session.name} shows its last message`).not.toBeNull();
        expect(sample.chatMounts, `${scenario.name}: ${session.name} mounts its chat at most once`).toBeLessThanOrEqual(1);
        if (TRIGGERS[scenario.trigger].focuses) expect(sample.focused, `${scenario.name}: Enter puts focus in ${session.name}'s composer`).not.toBeNull();
        if (index >= scenario.warmup) report.samples.push(sample);
        await page.waitForTimeout(300);
      }
    }
  } finally {
    writeReport();
    await app.close().catch(() => undefined);
  }
});

test(`switching leaves at most ${MAX_RETAINED_NODES_PER_SWITCH} DOM nodes per switch after GC`, async ({ baseURL }) => {
  test.setTimeout(10 * 60_000);
  const { pane, sessions } = await fixture(baseURL);
  const [a, b] = bySize(sessions, 'long');
  const rest = bySize(sessions, 'short')[0];
  const { app, page } = await launch(pane, baseURL);
  try {
    // Start both agents and compile the switch path first, so neither counts as retained.
    // Every switch must finish (its Session's last message on screen), or the delta would be
    // divided by switches that never built and tore down a view.
    const shown = async (session: Seeded, scenario: string) => {
      const sample = await switchTo(page, session, 'click', scenario);
      expect(sample.visible, `${scenario}: ${session.name} shows its last message`).not.toBeNull();
    };
    for (const session of [a, b, rest, a, b, a, b, rest]) await shown(session, 'retention-warmup');
    await page.waitForTimeout(1000);
    const before = await countersAfterGc(app);
    for (let index = 0; index < RETENTION_SWITCHES; index++) await shown(index % 2 === 0 ? a : b, 'retention');
    // The same Session as before is open, so the attached DOM matches and the difference is what was kept.
    await shown(rest, 'retention');
    await page.waitForTimeout(1000);
    const after = await countersAfterGc(app);
    const per = (key: keyof Counters) => (after[key] - before[key]) / RETENTION_SWITCHES;
    report.retention = { switches: RETENTION_SWITCHES, before, after, perSwitch: { nodes: Math.round(per('nodes')), listeners: Math.round(per('listeners')), heapMB: +per('heapMB').toFixed(3) } };
    expect(per('nodes'), `DOM nodes kept per switch (before ${JSON.stringify(before)}, after ${JSON.stringify(after)})`).toBeLessThanOrEqual(MAX_RETAINED_NODES_PER_SWITCH);
  } finally {
    writeReport();
    await app.close().catch(() => undefined);
  }
});

// ---------------------------------------------------------------------------
// The sidebar cursor (T-87 Phase 1): ↑/↓ show a chat Session at once, and only a settle
// (1 s rest, Enter, typing) selects it and starts its agent. Hard checks, none of them timing.

/** In-page counters for the cursor scenarios: agent starts, and skeletons shown. */
interface CursorWatch { starts: string[]; skeletons: number; skeletonAt: string[] }
declare global {
  var __paneCursorWatch: CursorWatch | undefined;
}

async function watchCursor(page: Page): Promise<void> {
  await page.evaluate(() => {
    const watch: CursorWatch = { starts: [], skeletons: 0, skeletonAt: [] };
    globalThis.__paneCursorWatch = watch;
    const last = new Map<string, string>();
    // Every agent start publishes its tab as starting; a tab already starting is not a new start.
    window.electronAPI.chatTab.onState(view => {
      if (view.status === 'starting' && last.get(view.panelId) !== 'starting') watch.starts.push(view.panelId);
      last.set(view.panelId, view.status);
    });
    new MutationObserver(() => {
      const bones = document.querySelector('[data-skeleton="visible"]');
      if (!bones) return;
      watch.skeletons += 1;
      // Where it showed: the test ids around it, for the failure message.
      const where: string[] = [];
      for (let node: Element | null = bones; node && where.length < 4; node = node.parentElement) {
        const id = node.getAttribute('data-testid');
        if (id) where.push(id);
      }
      if (watch.skeletonAt.length < 5) watch.skeletonAt.push(where.join(' < ') || bones.outerHTML.slice(0, 120));
    }).observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['data-skeleton'] });
  });
}

async function resetWatch(page: Page): Promise<CursorWatch> {
  return page.evaluate(() => {
    const watch = globalThis.__paneCursorWatch ?? { starts: [], skeletons: 0, skeletonAt: [] };
    const copy = { starts: [...watch.starts], skeletons: watch.skeletons, skeletonAt: [...watch.skeletonAt] };
    watch.starts.length = 0;
    watch.skeletons = 0;
    watch.skeletonAt.length = 0;
    return copy;
  });
}

/** The Sessions in sidebar order, as the cursor walks them. */
async function sidebarOrder(page: Page, sessions: Seeded[]): Promise<Seeded[]> {
  const ids = await page.evaluate(() => Array.from(document.querySelectorAll('[data-session-cursor]')).map(row => row.getAttribute('data-session-cursor') ?? ''));
  return ids.flatMap(id => sessions.filter(session => session.id === id));
}

/** What one cursor move did: peeks and opens per Session, chat mounts, and whether focus stayed on the row. */
interface MoveCheck { peeks: number; opens: number; focusOnRow: boolean }
async function moveCheck(page: Page, session: Seeded): Promise<MoveCheck> {
  return page.evaluate(id => {
    const marks = globalThis.__paneSwitchMarks ?? [];
    const active = document.activeElement;
    return {
      peeks: marks.filter(mark => mark.name === 'session:peek' && mark.detail.sessionId === id).length,
      opens: marks.filter(mark => mark.name === 'session:open' && mark.detail.sessionId === id).length,
      focusOnRow: active?.getAttribute('data-session-cursor') === id,
    };
  }, session.id);
}

async function focusRow(page: Page, session: Seeded): Promise<void> {
  const row = page.getByTestId(`orchestration-session-${session.id}`);
  await row.scrollIntoViewIfNeeded();
  await row.focus();
}

/** One arrow press onto `session`, checked hard and timed (reported only). */
/** `settles`: the move may rest long enough to settle (a memory check on a slow runner), so opening is allowed. */
async function arrowTo(page: Page, session: Seeded, key: 'down' | 'up', scenario: string, held: Set<string>, pauseMs: number, settles = false): Promise<Sample> {
  const started = Date.now();
  const sample = await switchTo(page, session, key, scenario, 5_000);
  const check = await moveCheck(page, session);
  expect(check.focusOnRow, `${scenario}: focus stays on ${session.name}'s sidebar row`).toBe(true);
  expect(sample.visible, `${scenario}: ${session.name} shows its last message`).not.toBeNull();
  expect(sample.chatMounts, `${scenario}: ${session.name} mounts its chat at most once`).toBeLessThanOrEqual(1);
  expect(check.peeks, `${scenario}: ${held.has(session.id) ? 'no peek for a held' : 'at most one peek for'} ${session.name}`).toBeLessThanOrEqual(held.has(session.id) ? 0 : 1);
  if (!settles) expect(check.opens, `${scenario}: passing over ${session.name} opens nothing`).toBe(0);
  held.add(session.id);
  const left = pauseMs - (Date.now() - started);
  if (left > 0) await page.waitForTimeout(left);
  return sample;
}

test('arrow keys show chat Sessions at once, and only a settle starts an agent (T-87)', async ({ baseURL }) => {
  test.setTimeout(15 * 60_000);
  const { pane, sessions } = await fixture(baseURL);
  report.meta ??= meta();
  const { app, page } = await launch(pane, baseURL);
  try {
    const order = await sidebarOrder(page, sessions);
    expect(order.length, 'every seeded Session follows the cursor').toBe(sessions.length);
    const held = new Set<string>();
    // The Session the app opened on is selected and held; start from it.
    await switchTo(page, order[0], 'click', 'cursor-start');
    held.add(order[0].id);
    await page.waitForTimeout(1_500);
    await watchCursor(page);
    await focusRow(page, order[0]);
    await resetWatch(page);

    // ↓ through 20 Sessions, 400 ms apart (shorter than the 1 s settle): each shows from F-lite or the cache.
    const walk = order.slice(1, 21);
    for (const session of walk) report.samples.push(await arrowTo(page, session, 'down', 'arrow-walk-not-opened', held, 400));
    let watch = await resetWatch(page);
    expect(watch.starts, 'the 400 ms walk starts no agent').toEqual([]);
    expect(watch.skeletons, `the walk shows no skeleton (${watch.skeletonAt.join('; ')})`).toBe(0);

    // Back up the same rows: every one is held now, so no peek at all.
    for (const session of walk.slice(0, -1).reverse()) report.samples.push(await arrowTo(page, session, 'up', 'arrow-walk-held', held, 400));
    watch = await resetWatch(page);
    expect(watch.starts, 'walking back starts no agent').toEqual([]);
    expect(watch.skeletons, `walking back shows no skeleton (${watch.skeletonAt.join('; ')})`).toBe(0);

    // ↑/↓ between two Sessions, 20 times.
    const [a, b] = [walk[0], walk[1]];
    await focusRow(page, a);
    for (let index = 0; index < 20; index++) {
      report.samples.push(await arrowTo(page, index % 2 === 0 ? b : a, index % 2 === 0 ? 'down' : 'up', 'arrow-pingpong', held, 400));
    }
    watch = await resetWatch(page);
    expect(watch.starts, 'the ping-pong starts no agent').toEqual([]);
    expect(watch.skeletons, `the ping-pong shows no skeleton (${watch.skeletonAt.join('; ')})`).toBe(0);

    // Held ↓ at key-repeat rate (about 30 a second). ↑ onto the selected Session first clears the cursor.
    await page.keyboard.press('ArrowUp');
    await page.evaluate(() => { globalThis.__paneSwitchMarks = []; });
    const repeat = order.slice(1, 16);
    for (let index = 0; index < repeat.length; index++) {
      await page.keyboard.press('ArrowDown');
      await page.waitForTimeout(33);
    }
    await page.waitForTimeout(300);
    const repeated = await page.evaluate(() => (globalThis.__paneSwitchMarks ?? []).filter(mark => mark.name === 'session:peek' || mark.name === 'session:open').map(mark => `${mark.name}:${mark.detail.sessionId}`));
    expect(repeated.filter(name => name.startsWith('session:open')), 'holding ↓ opens nothing').toEqual([]);
    expect(new Set(repeated).size, 'holding ↓ peeks each Session at most once').toBe(repeated.length);
    watch = await resetWatch(page);
    expect(watch.starts, 'holding ↓ starts no agent').toEqual([]);
    expect(watch.skeletons, `holding ↓ shows no skeleton (${watch.skeletonAt.join('; ')})`).toBe(0);
    const last = repeat[repeat.length - 1];
    expect(await page.evaluate(() => document.activeElement?.getAttribute('data-session-cursor')), 'focus ends on the last row').toBe(last.id);

    // A 1.2 s rest on one row settles it: one open call and its agent starts, and only it.
    await page.evaluate(() => { globalThis.__paneSwitchMarks = []; });
    await page.waitForTimeout(1_200);
    const settled = await moveCheck(page, last);
    expect(settled.opens, `resting on ${last.name} opens it once`).toBe(1);
    await expect.poll(async () => (await page.evaluate(() => globalThis.__paneCursorWatch?.starts ?? [])), { timeout: 10_000 }).toEqual([last.panelId]);
    await resetWatch(page);
    // Enter then focuses its message box, without opening it again.
    await page.evaluate(() => { globalThis.__paneSwitchMarks = []; });
    await page.keyboard.press('Enter');
    await expect.poll(() => page.evaluate(id => document.activeElement?.getAttribute('data-chat-composer') === id, last.panelId), { timeout: 5_000 }).toBe(true);
    expect((await moveCheck(page, last)).opens, 'Enter on a settled Session opens nothing more').toBe(0);
    watch = await resetWatch(page);
    expect(watch.starts, 'Enter starts no other agent').toEqual([]);
  } finally {
    writeReport();
    await app.close().catch(() => undefined);
  }
});

// ---------------------------------------------------------------------------
// The chat column holds still (T-140): from the first frame the cursor's Session shows to
// its settle, its chat keeps its left edge and width, and its composer its height (within 1 px). A Session with a right
// split draws that split in its first frame, and one without draws its chat full width at
// once; neither shows the chat centered first and then pushes it aside.

/**
 * One sample of what the window shows: the Session on screen (not one kept dimmed behind the
 * cursor), each of its panel groups as [left, width] in order (so a split arriving late shows),
 * and its chat composer as [left, width, height].
 */
interface ColumnFrame { t: number; via: 'commit' | 'frame' | 'painted'; session: string | null; groups: number[][]; composer: number[] | null }
declare global {
  var __paneColumnFrames: ColumnFrame[] | undefined;
  /** In the main process: the screencast frames of the move in flight (SESSION_SWITCH_FRAMES). */
  var __paneFrames: Array<{ at: number; data: string }> | undefined;
  var __paneFramesOn: boolean | undefined;
}

/**
 * From the next keydown, for `ms`: the Session shown, sampled at every DOM commit (a mutation
 * observer, which runs before any resize observer could lay a split out, so an unsized pane is
 * seen whether or not that state is painted), at each frame, and after each frame's paint.
 */
async function recordColumns(page: Page, ms: number): Promise<void> {
  await page.evaluate(ms => {
    const frames: ColumnFrame[] = [];
    globalThis.__paneColumnFrames = frames;
    let start: number | undefined;
    window.addEventListener('keydown', event => { start ??= event.timeStamp; }, { capture: true, once: true });
    const box = (element: Element | null | undefined, withHeight = false): number[] | null => {
      if (!element || element.getClientRects().length === 0) return null;
      const rect = element.getBoundingClientRect();
      if (rect.width <= 0) return null;
      return withHeight ? [+rect.left.toFixed(1), +rect.width.toFixed(1), +rect.height.toFixed(1)] : [+rect.left.toFixed(1), +rect.width.toFixed(1)];
    };
    const sample = (via: ColumnFrame['via']) => {
      if (start === undefined) return;
      const now = performance.now();
      if (now - start > ms) return;
      // The Session's own workspace, not the one kept dimmed behind the cursor while it is read.
      const content = Array.from(document.querySelectorAll('[data-session-content-id]')).find(element => !element.closest('[data-session-shown-before]'));
      const groups = content ? Array.from(content.querySelectorAll('[data-panel-group-id]')).map(group => box(group) ?? [0, 0]) : [];
      frames.push({ t: +(now - start).toFixed(1), via, session: content?.getAttribute('data-session-content-id') ?? null, groups, composer: box(content?.querySelector('textarea[data-chat-composer]'), true) });
    };
    const observer = new MutationObserver(() => sample('commit'));
    observer.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['style', 'class', 'data-session-content-id', 'data-session-shown-before'] });
    const painted = new MessageChannel();
    painted.port1.onmessage = () => sample('painted');
    const tick = (now: number) => {
      sample('frame');
      painted.port2.postMessage(null);
      if (start === undefined || now - start <= ms) requestAnimationFrame(tick);
      else observer.disconnect();
    };
    requestAnimationFrame(tick);
  }, ms);
}

/** Per Session shown, in order: the samples whose chat or groups are not where that showing ends (more than 1 px off). */
function columnMoves(frames: ColumnFrame[]): Array<{ session: string; first: ColumnFrame; last: ColumnFrame; moved: ColumnFrame[] }> {
  const off = (a: number[] | null, b: number[] | null) => !a || !b || a.length !== b.length || a.some((value, index) => Math.abs(value - b[index]) > 1);
  const runs: Array<{ session: string; frames: ColumnFrame[] }> = [];
  for (const frame of frames) {
    if (!frame.session) continue;
    const run = runs.at(-1);
    if (run && run.session === frame.session) run.frames.push(frame);
    else runs.push({ session: frame.session, frames: [frame] });
  }
  return runs.map(({ session, frames: shown }) => {
    const last = shown[shown.length - 1];
    const moved = shown.filter(frame => off(frame.composer, last.composer) || frame.groups.length !== last.groups.length || frame.groups.some((group, index) => off(group, last.groups[index])));
    return { session, first: shown[0], last, moved };
  });
}

/** The Session's Pane laid out with its chat alone: Overview and To-dos as tabs beside it, no right split. */
async function withoutSplit(page: Page, session: Seeded): Promise<void> {
  await page.evaluate(async ({ sessionId, panelId }) => {
    const list = await window.electronAPI.orchestrationSessions.list();
    // SAFETY: orchestration-sessions:list returns an OrchestrationSessionListResult in `data`.
    const records = ((list.data as { sessions?: Array<{ id: string; internalSessionId: string }> } | undefined)?.sessions) ?? [];
    const internal = records.find(record => record.id === sessionId)?.internalSessionId;
    if (!internal) throw new Error(`Session ${sessionId} has no internal Pane in the list.`);
    const id = `t140-${internal}`;
    const layout = { version: 1 as const, root: { type: 'group' as const, id, panelIds: [panelId, `session-overview:${internal}`, `session-todos:${internal}`], activePanelId: panelId }, focusedGroupId: id };
    // The host's last-used layout and this desktop's own copy, which wins.
    await window.electronAPI.invoke('panels:set-layout', internal, layout);
    await window.electronAPI.uiState.savePaneLayout(null, internal, layout);
  }, { sessionId: session.id, panelId: session.panelId });
}

/** A frame strip of one move when SESSION_SWITCH_FRAMES names a folder: the window's screencast. */
async function startFrames(app: ElectronApplication): Promise<void> {
  if (!process.env.SESSION_SWITCH_FRAMES) return;
  await app.evaluate(async ({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows().find(candidate => !candidate.webContents.getURL().includes('notify.html'));
    if (!window) return;
    const debug = window.webContents.debugger;
    if (!debug.isAttached()) debug.attach('1.3');
    const store = globalThis;
    store.__paneFrames = [];
    if (!store.__paneFramesOn) {
      store.__paneFramesOn = true;
      debug.on('message', (_event, method, params: { data: string; sessionId: number; metadata: { timestamp: number } }) => {
        if (method !== 'Page.screencastFrame') return;
        store.__paneFrames?.push({ at: params.metadata.timestamp, data: params.data });
        void debug.sendCommand('Page.screencastFrameAck', { sessionId: params.sessionId }).catch(() => undefined);
      });
    }
    await debug.sendCommand('Page.startScreencast', { format: 'png', everyNthFrame: 1 });
  });
}

async function saveFrames(app: ElectronApplication, name: string): Promise<void> {
  const dir = process.env.SESSION_SWITCH_FRAMES;
  if (!dir) return;
  const frames = await app.evaluate(async ({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows().find(candidate => !candidate.webContents.getURL().includes('notify.html'));
    await window?.webContents.debugger.sendCommand('Page.stopScreencast').catch(() => undefined);
    const store = globalThis;
    const taken = store.__paneFrames ?? [];
    store.__paneFrames = [];
    return taken;
  });
  mkdirSync(path.join(dir, name), { recursive: true });
  const first = frames[0]?.at ?? 0;
  for (const [index, frame] of frames.entries()) {
    writeFileSync(path.join(dir, name, `${String(index).padStart(3, '0')}-${Math.round((frame.at - first) * 1000)}ms.png`), Buffer.from(frame.data, 'base64'));
  }
}

test('the chat column holds still from the first preview frame to settle, with and without a split (T-140)', async ({ baseURL }) => {
  test.setTimeout(10 * 60_000);
  const { pane, sessions } = await fixture(baseURL);
  const { app, page } = await launch(pane, baseURL);
  try {
    const order = await sidebarOrder(page, sessions);
    const named = new Map(sessions.map(session => [session.id, session.name]));
    // Below the start: a Session with the right split, one without, and one more; each first not opened, then held.
    // Then a fast walk over rows 4-9 (two without a split), not opened, and back up over them, held.
    const [start, splitRow, plainRow, beyond] = order;
    const fast = order.slice(4, 10);
    for (const session of [plainRow, fast[1], fast[3]]) await withoutSplit(page, session);
    await switchTo(page, start, 'click', 't140-start');
    await page.waitForTimeout(1_500);
    await focusRow(page, start);
    mkdirSync(OUT, { recursive: true });
    const failures: string[] = [];
    /** Presses each key `gapMs` apart, then rests past the 1 s settle, so its open and what it reads again land inside the window. */
    const record = async (name: string, keys: Array<'ArrowDown' | 'ArrowUp'>, gapMs: number) => {
      await recordColumns(page, keys.length * gapMs + 2_500);
      await startFrames(app);
      for (const [index, key] of keys.entries()) {
        await page.keyboard.press(key);
        if (index < keys.length - 1) await page.waitForTimeout(gapMs);
      }
      await page.waitForTimeout(2_700);
      await saveFrames(app, name);
      const frames = await page.evaluate(() => globalThis.__paneColumnFrames ?? []);
      const runs = columnMoves(frames);
      writeFileSync(path.join(OUT, `t140-${name}.json`), JSON.stringify({ runs: runs.map(run => ({ ...run, session: named.get(run.session) ?? run.session, moved: run.moved.length })), frames }, null, 2));
      for (const run of runs) {
        if (run.moved.length === 0) continue;
        failures.push(`${name}: ${named.get(run.session) ?? run.session}'s chat or split was off where it ended in ${run.moved.length} of ${frames.length} samples; first ${JSON.stringify(run.first)}, end ${JSON.stringify(run.last)}, off: ${JSON.stringify(run.moved.slice(0, 3))}`);
      }
      return runs;
    };
    for (const [session, key, name, split] of [
      [splitRow, 'ArrowDown', 'split-not-opened', true],
      [plainRow, 'ArrowDown', 'plain-not-opened', false],
      [beyond, 'ArrowDown', 'beyond', true],
      [plainRow, 'ArrowUp', 'plain-cached', false],
      [splitRow, 'ArrowUp', 'split-cached', true],
    ] as const) {
      const runs = await record(name, [key], 0);
      const shown = runs.at(-1);
      expect(shown?.session, `${name}: ends on ${session.name}`).toBe(session.id);
      // From its first sample: the split (or none) is there at once, since every sample matches the last.
      expect((shown?.last.groups.length ?? 0) > 1, `${name}: ${session.name} ${split ? 'has' : 'has no'} right split`).toBe(split);
    }
    // Quickly, as a person scans: 120 ms apart, down over rows not opened yet, then back up over them.
    await focusRow(page, beyond);
    const passed = (runs: Array<{ session: string }>) => runs.map(run => run.session).filter((id, index, all) => all.indexOf(id) === index);
    // Not opened: a Session whose peek outlasts the 120 ms stays behind the dimmed one, so only the last must show.
    const down = await record('fast-down-not-opened', fast.map(() => 'ArrowDown' as const), 120);
    expect(down.at(-1)?.session, 'the fast walk down ends on its last row').toBe(fast[fast.length - 1].id);
    // Held now: each one shows as the cursor reaches it, in order.
    const up = await record('fast-up-held', fast.map(() => 'ArrowUp' as const), 120);
    const upOrder = [...fast].reverse().slice(1).concat(beyond).map(session => session.id);
    expect(passed(up).filter(id => upOrder.includes(id)), 'the fast walk up shows every held row in order').toEqual(upOrder);
    expect(failures, 'the chat column holds still from the first frame to settle').toEqual([]);
  } finally {
    await app.close().catch(() => undefined);
  }
});

test(`arrow-key switching leaves at most ${MAX_RETAINED_NODES_PER_SWITCH} DOM nodes per switch after GC (T-87)`, async ({ baseURL }) => {
  test.setTimeout(10 * 60_000);
  const { pane, sessions } = await fixture(baseURL);
  const { app, page } = await launch(pane, baseURL);
  try {
    const order = await sidebarOrder(page, sessions);
    // Two neighbouring rows, long chats where the order has them side by side.
    const long = (session: Seeded | undefined) => session !== undefined && session.size !== 'short';
    const found = order.findIndex((session, index) => long(session) && long(order[index + 1]));
    const pairAt = found >= 0 ? found : 1;
    const [a, b] = [order[pairAt], order[pairAt + 1]];
    await switchTo(page, a, 'click', 'arrow-retention-warmup');
    await focusRow(page, a);
    const held = new Set<string>([a.id]);
    for (let index = 0; index < 8; index++) await arrowTo(page, index % 2 === 0 ? b : a, index % 2 === 0 ? 'down' : 'up', 'arrow-retention-warmup', held, 0, true);
    await page.waitForTimeout(1_000);
    const before = await countersAfterGc(app);
    for (let index = 0; index < RETENTION_SWITCHES; index++) await arrowTo(page, index % 2 === 0 ? b : a, index % 2 === 0 ? 'down' : 'up', 'arrow-retention', held, 0, true);
    // Back on the Session the count started on (it ended on b after an even number of switches).
    await page.waitForTimeout(1_000);
    const after = await countersAfterGc(app);
    const per = (key: keyof Counters, digits: number) => +((after[key] - before[key]) / RETENTION_SWITCHES).toFixed(digits);
    report.arrowRetention = { switches: RETENTION_SWITCHES, before, after, perSwitch: { nodes: per('nodes', 0), listeners: per('listeners', 0), heapMB: per('heapMB', 3) } };
    expect(report.arrowRetention.perSwitch.nodes, `DOM nodes kept per arrow switch (before ${JSON.stringify(before)}, after ${JSON.stringify(after)})`).toBeLessThanOrEqual(MAX_RETAINED_NODES_PER_SWITCH);
  } finally {
    writeReport();
    await app.close().catch(() => undefined);
  }
});
