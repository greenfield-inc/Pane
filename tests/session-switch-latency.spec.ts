import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { isolatedPane, type IsolatedPane } from './isolatedPane';
import { endMark as sessionEndMark, launchWithScriptedAgent, seedChatSessions, withFakeClaude } from './scriptedChats';
import { armVisibleProbe, readVisibleProbe } from './switchProbe';
import type { SwitchMark } from '../shared/switchMarks';

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

const endMark = (session: Seeded) => sessionEndMark(session.name);

async function launch(pane: IsolatedPane, baseURL: string | undefined): Promise<{ app: ElectronApplication; page: Page }> {
  const launched = await launchWithScriptedAgent(pane, baseURL);
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
    const plan = PLAN.flatMap(({ size, count, turns }) => Array.from({ length: count }, (_, index) => ({ name: `${size}-${String(index + 1).padStart(2, '0')}`, size, turns })));
    const created = await seedChatSessions(pane, baseURL, plan);
    return { pane, sessions: created.map((session, index) => ({ name: session.name, id: session.id, panelId: session.panelId, size: plan[index].size, messages: session.messages })) };
  })();
  return seeded;
}

// ---------------------------------------------------------------------------
// One switch: the trigger, an in-page rAF probe for "visible", and the stage marks.

/** How a switch starts. t0 is the trigger's first input event (click or keydown, capture phase). */
type Trigger = 'click' | 'enter';
interface TriggerSpec { focuses: boolean; run: (page: Page, row: ReturnType<Page['getByTestId']>) => Promise<void> }
const TRIGGERS = {
  click: { focuses: false, run: async (_page, row) => { await row.click(); } },
  // Enter on a focused row (regionFocus.ts): opens the Session and moves focus into its composer.
  enter: { focuses: true, run: async (page, row) => { await row.focus(); await page.keyboard.press('Enter'); } },
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

async function switchTo(page: Page, session: Seeded, trigger: Trigger, scenario: string): Promise<Sample> {
  const row = page.getByTestId(`orchestration-session-${session.id}`);
  await row.scrollIntoViewIfNeeded();
  await armVisibleProbe(page, { panelId: session.panelId, mark: endMark(session), focuses: TRIGGERS[trigger].focuses });
  await TRIGGERS[trigger].run(page, row);
  const { done, marks } = await readVisibleProbe(page);
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

function markdown(summary: Summary[], retention: Retention | undefined): string {
  const lines = [
    '### Session switch latency (reported only)',
    '',
    '| Scenario | n | cache hits | visible p50 / p95 (ms) | painted p50 | focused p50 | first commit p50 |',
    '|---|---|---|---|---|---|---|',
    ...summary.map(row => `| ${row.scenario} | ${row.n} | ${row.cacheHits}/${row.n} | **${ms(row.visibleP50)} / ${ms(row.visibleP95)}** | ${ms(row.paintedP50)} | ${ms(row.focusedP50)} | ${ms(row.commitP50)} |`),
  ];
  if (retention) {
    lines.push('', `Retained after ${retention.switches} switches and a forced GC, per switch: **${retention.perSwitch.nodes} DOM nodes** (limit ${MAX_RETAINED_NODES_PER_SWITCH}), ${retention.perSwitch.listeners} listeners, ${retention.perSwitch.heapMB} MB heap.`);
  }
  return `${lines.join('\n')}\n`;
}

interface Meta { commit: string; branch: string; platform: string; renderer: string; at: string }
interface Report { meta?: Meta; summary: Summary[]; samples: Sample[]; retention?: Retention }
const report: Report = { summary: [], samples: [] };

/** Writes session-switch.json (every sample) and session-switch.md (the table); returns the table. */
function writeReport(): string {
  mkdirSync(OUT, { recursive: true });
  report.summary = summarize(report.samples);
  writeFileSync(path.join(OUT, 'session-switch.json'), JSON.stringify(report, null, 2));
  const table = markdown(report.summary, report.retention);
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
  if (report.samples.length === 0 && !report.retention) return;
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
