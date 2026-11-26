import { expect, test, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { HOST_LABEL, startRig, type Rig } from './remoteRig';
import { endMark, type SeededChat } from './scriptedChats';
import { armVisibleProbe, readVisibleProbe } from './switchProbe';

declare global {
  /** The in-page recorder for arrow-key cursor moves (measureCursor below). */
  var __paneCursorProbe: { moves: number[]; missed: number; longTasks: number[] } | undefined;
}

/**
 * Another machine's Sessions over a slow link (T-116 PR 1): the two-instance rig (remoteRig.ts),
 * measured as the app is today, so later PRs have a baseline to beat. Runs under
 * playwright.remote-switch.config.ts only (production renderer, real Electron).
 *
 * Reported, not asserted: Enter on another machine's Session → the window on that machine, on
 * that Session, its chat visible, and back; bytes over the link per open and per idle minute;
 * arrow-key cursor moves at 30 presses a second (D-6); how long until a cut link shows the
 * machine offline.
 *
 * Hard checks, none of them timing: the desktop reaches the host only through the proxy, each
 * Enter moves the window to the row's machine, and a cut link is noticed. Landing on the row's
 * own Session is reported, not checked: today a switch can land on the host's own selected
 * Session instead, which T-116 PR 3 fixes and then checks.
 */

const OUT = path.resolve(process.env.REMOTE_SWITCH_OUT ?? 'test-results/remote-session-switch');
const LATENCY_MS = Number(process.env.REMOTE_SWITCH_RTT_MS ?? 50);
const OPENS = Number(process.env.REMOTE_SWITCH_OPENS ?? 8);
const IDLE_MS = Number(process.env.REMOTE_SWITCH_IDLE_MS ?? 30_000);
const ARROW_PRESSES = 40;
const ARROW_INTERVAL_MS = 33;

test.skip(!process.env.PANE_REMOTE_SWITCH_BENCH, 'Runs under playwright.remote-switch.config.ts (production renderer).');

const HOST_CHATS = [
  ...['01', '02', '03', '04'].map(n => ({ name: `host-short-${n}`, turns: 5 })),
  ...['01', '02', '03', '04'].map(n => ({ name: `host-long-${n}`, turns: 100 })),
];
const DESKTOP_CHATS = ['01', '02'].map(n => ({ name: `here-${n}`, turns: 5 }));

// ---------------------------------------------------------------------------

/** The All machines sidebar, where every machine's Sessions are listed. */
async function openAllMachines(page: Page): Promise<void> {
  if (await page.getByTestId('all-machines-sidebar').isVisible().catch(() => false)) return;
  await page.getByRole('button', { name: /Switch machine$/ }).click();
  await page.getByRole('menuitemradio', { name: /All machines/ }).click();
  await expect(page.getByTestId('all-machines-sidebar')).toBeVisible();
}

const sessionRow = (page: Page, name: string) => page.getByTestId('all-machines-sidebar').getByRole('button', { name: new RegExp(`^Session ${name} on `) });

/**
 * One Enter on a Session's row, timed from the keydown:
 * - shown: the first frame where the sidebar marks a row of the target's machine as the one on screen;
 * - landedOn: the row marked at the end, and whether it is the target (today a switch can land on
 *   the host's own selected Session instead: T-116 PR 3 fixes that and turns it into a hard check);
 * - visible: when the target's chat showed its last message, or null when it never did.
 */
interface OpenSample {
  direction: 'there' | 'back';
  session: string;
  shown: number | null;
  landedOn: string | null;
  rightSession: boolean;
  visible: number | null;
  painted: number | null;
  bytesToHost: number;
  bytesToDesktop: number;
  /** The marked row's label each time it changed, ms from the keydown. */
  timeline: Array<[number, string]>;
}

declare global {
  /** The in-page recorder of the sidebar row marked as on screen (openWithEnter below). */
  var __paneShownRows: { stop: boolean; rows: Array<[number, string]> } | undefined;
}

/** How long an open may take before it counts as not having shown its chat. */
const OPEN_TIMEOUT_MS = 20_000;

/** Enter on a Session's row; times its machine and chat on screen and counts the bytes over the link meanwhile. */
async function openWithEnter(rig: Rig, session: SeededChat, direction: OpenSample['direction']): Promise<OpenSample> {
  const { page } = rig.desktop;
  const row = sessionRow(page, session.name);
  await row.scrollIntoViewIfNeeded();
  const target = await row.getAttribute('aria-label') ?? '';
  const machine = target.slice(target.lastIndexOf(' on ') + 4);
  rig.proxy.resetBytes();
  await armVisibleProbe(page, { panelId: session.panelId, mark: endMark(session.name), focuses: false, timeoutMs: OPEN_TIMEOUT_MS });
  await page.evaluate(() => {
    const rows: Array<[number, string]> = [];
    const recorder = { stop: false, rows };
    globalThis.__paneShownRows = recorder;
    const tick = () => {
      const label = document.querySelector('[data-testid="all-machines-sidebar"] [aria-current="page"]')?.getAttribute('aria-label') ?? '-';
      if (recorder.rows.at(-1)?.[1] !== label) recorder.rows.push([performance.now(), label]);
      if (!recorder.stop) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  await row.focus();
  await page.keyboard.press('Enter');
  const { done } = await readVisibleProbe(page);
  const rows = await page.evaluate(() => {
    const recorder = globalThis.__paneShownRows;
    if (recorder) recorder.stop = true;
    return recorder?.rows ?? [];
  });
  const since = (t: number | undefined) => (t === undefined || done.input === undefined ? null : +(t - done.input).toFixed(1));
  const timeline = rows.map(([t, label]): [number, string] => [since(t) ?? NaN, label]).filter(([t]) => Number.isNaN(t) || t >= 0);
  const landedOn = rows.at(-1)?.[1] ?? null;
  const bytes = rig.proxy.bytes();
  // The first visit to the host from this desktop greets it; the greeting covers the rows.
  const welcome = page.getByRole('button', { name: 'Don\'t show this again' });
  if (await welcome.isVisible().catch(() => false)) await welcome.click();
  return {
    direction,
    session: session.name,
    shown: since(rows.find(([t, label]) => done.input !== undefined && t >= done.input && label.endsWith(` on ${machine}`))?.[0]),
    landedOn,
    rightSession: landedOn === target,
    visible: since(done.visible),
    painted: since(done.painted),
    bytesToHost: bytes.toTarget,
    bytesToDesktop: bytes.toClient,
    timeline,
  };
}

interface CursorResult { presses: number; moved: number; p50: number | null; p95: number | null; max: number | null; longTasks: number; longestTask: number | null }

/**
 * Arrows through the sidebar at 30 presses a second (D-6), down to the last row and back up, so
 * every press has a row to move to: for each press, the time from the keydown to the first frame
 * where focus is on another row. Long tasks are counted meanwhile.
 */
async function measureCursor(page: Page): Promise<CursorResult> {
  const rows = page.getByTestId('all-machines-sidebar').locator('[data-sidebar-item]');
  const sweep = (await rows.count()) - 1;
  expect(sweep, 'the sidebar has rows to arrow through').toBeGreaterThan(1);
  await rows.first().focus();
  await page.evaluate(() => {
    const moves: number[] = [];
    const longTasks: number[] = [];
    const probe = { moves, missed: 0, longTasks };
    globalThis.__paneCursorProbe = probe;
    new PerformanceObserver(list => { for (const entry of list.getEntries()) probe.longTasks.push(entry.duration); }).observe({ type: 'longtask' });
    window.addEventListener('keydown', event => {
      if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
      const from = document.activeElement;
      const pressed = event.timeStamp;
      const started = performance.now();
      const tick = () => {
        if (document.activeElement !== from) return void probe.moves.push(performance.now() - pressed);
        if (performance.now() - started > 2_000) return void (probe.missed += 1);
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    }, { capture: true });
  });
  for (let press = 0; press < ARROW_PRESSES; press++) {
    await page.keyboard.press(Math.floor(press / sweep) % 2 === 0 ? 'ArrowDown' : 'ArrowUp');
    await page.waitForTimeout(ARROW_INTERVAL_MS);
  }
  await page.waitForTimeout(2_500);
  const probe = await page.evaluate(() => globalThis.__paneCursorProbe ?? { moves: [], missed: 0, longTasks: [] });
  return {
    presses: ARROW_PRESSES,
    moved: probe.moves.length,
    p50: percentile(probe.moves, 50),
    p95: percentile(probe.moves, 95),
    max: probe.moves.length ? +Math.max(...probe.moves).toFixed(1) : null,
    longTasks: probe.longTasks.length,
    longestTask: probe.longTasks.length ? +Math.max(...probe.longTasks).toFixed(1) : null,
  };
}

// ---------------------------------------------------------------------------
// Reporting

function percentile(values: number[], p: number): number | null {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  return +sorted[Math.max(0, Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1))].toFixed(1);
}

interface Report {
  meta?: { commit: string; platform: string; latencyMs: number; at: string };
  opens: OpenSample[];
  idle?: { ms: number; toHost: number; toDesktop: number; perMinute: number };
  cursor?: CursorResult;
  offline?: { noticedAfterMs: number | null };
}
const report: Report = { opens: [] };

const ms = (value: number | null | undefined) => (value === null || value === undefined ? '–' : String(Math.round(value)));
const kb = (bytes: number) => `${(bytes / 1024).toFixed(0)} KB`;

function markdown(): string {
  const lines = [`### Another machine's Sessions over a ${report.meta?.latencyMs ?? LATENCY_MS} ms link (reported only)`, ''];
  lines.push('| Enter on a row | n | machine shown p50 / p95 (ms) | landed on that Session | its chat visible p50 / p95 (ms), n | bytes over the link, p50 |', '|---|---|---|---|---|---|');
  for (const direction of ['there', 'back'] as const) {
    const rows = report.opens.filter(sample => sample.direction === direction);
    const column = (pick: (sample: OpenSample) => number | null) => rows.map(pick).filter((value): value is number => value !== null);
    const bytes = rows.map(sample => sample.bytesToHost + sample.bytesToDesktop);
    const label = direction === 'there' ? 'the host\'s Session (the window switches to the host)' : 'this computer\'s Session (the window switches back)';
    lines.push(`| ${label} | ${rows.length} | **${ms(percentile(column(s => s.shown), 50))} / ${ms(percentile(column(s => s.shown), 95))}** | ${rows.filter(s => s.rightSession).length}/${rows.length} | **${ms(percentile(column(s => s.visible), 50))} / ${ms(percentile(column(s => s.visible), 95))}**, ${column(s => s.visible).length} | ${bytes.length ? kb(percentile(bytes, 50) ?? 0) : '–'} |`);
  }
  const wrong = report.opens.filter(sample => !sample.rightSession);
  if (wrong.length) lines.push('', `Landed elsewhere: ${wrong.map(sample => `${sample.session} → ${sample.landedOn ?? 'no Session'}`).join('; ')}.`);
  if (report.cursor) {
    const cursor = report.cursor;
    lines.push('', `Arrow keys, ${cursor.presses} presses at 30 a second: the cursor moved on **${cursor.moved}**, press → moved p50 **${ms(cursor.p50)} ms**, p95 **${ms(cursor.p95)} ms**, max ${ms(cursor.max)} ms; ${cursor.longTasks ? `${cursor.longTasks} long tasks (longest ${ms(cursor.longestTask)} ms)` : 'no long tasks'}.`);
  }
  if (report.idle) lines.push('', `Idle link, window on this computer: **${kb(report.idle.perMinute)} per minute** (${kb(report.idle.toHost)} to the host, ${kb(report.idle.toDesktop)} back, over ${Math.round(report.idle.ms / 1000)} s).`);
  if (report.offline) lines.push('', `Link cut: the sidebar said the host went offline after **${ms(report.offline.noticedAfterMs)} ms**.`);
  return `${lines.join('\n')}\n`;
}

function writeReport(): string {
  mkdirSync(OUT, { recursive: true });
  writeFileSync(path.join(OUT, 'remote-session-switch.json'), JSON.stringify(report, null, 2));
  const table = markdown();
  writeFileSync(path.join(OUT, 'remote-session-switch.md'), table);
  return table;
}

test.afterAll(() => {
  if (report.opens.length === 0 && !report.idle) return;
  const table = writeReport();
  console.log(`\n${table}\nSamples: ${path.join(OUT, 'remote-session-switch.json')}`);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, table);
});

// ---------------------------------------------------------------------------

test('another machine\'s Sessions over a slow link: today\'s baseline (timing reported only)', async ({ baseURL }) => {
  test.setTimeout(20 * 60_000);
  if (!existsSync(path.resolve('frontend/dist/index.html'))) {
    throw new Error('The rig serves the production renderer, and frontend/dist has none, so nothing was launched. Run `pnpm build:frontend`, then run it again.');
  }
  const rig = await startRig(baseURL, { latencyMs: LATENCY_MS, hostChats: HOST_CHATS, desktopChats: DESKTOP_CHATS });
  const git = (args: string[]) => { try { return execFileSync('git', args, { encoding: 'utf8' }).trim(); } catch { return ''; } };
  report.meta = { commit: git(['rev-parse', 'HEAD']), platform: `${process.platform}-${process.arch}`, latencyMs: LATENCY_MS, at: new Date().toISOString() };
  const { page } = rig.desktop;
  try {
    await openAllMachines(page);
    // The host's Sessions arrive over the proxy, or the rig is not linked.
    for (const session of rig.host.sessions) await expect(sessionRow(page, session.name), `${session.name} is listed from ${HOST_LABEL}`).toBeVisible({ timeout: 60_000 });
    expect(rig.proxy.bytes().toClient, 'the desktop heard from the host only through the proxy').toBeGreaterThan(0);

    // Arrow keys first, before any open, so the cursor sees today's sidebar alone.
    report.cursor = await measureCursor(page);

    // Start from one of this computer's Sessions, as a desktop in use does, outside the samples.
    const start = await openWithEnter(rig, rig.desktop.sessions[1], 'back');
    expect(start.visible, `${start.session} shows its last message (rows on screen: ${JSON.stringify(start.timeline)})`).not.toBeNull();

    for (let index = 0; index < OPENS; index++) {
      const there = rig.host.sessions[index % rig.host.sessions.length];
      const sample = await openWithEnter(rig, there, 'there');
      report.opens.push(sample);
      expect(sample.shown, `Enter on ${there.name} switches the window to ${HOST_LABEL} (rows on screen: ${JSON.stringify(sample.timeline)})`).not.toBeNull();
      const back = rig.desktop.sessions[index % rig.desktop.sessions.length];
      const returned = await openWithEnter(rig, back, 'back');
      report.opens.push(returned);
      expect(returned.shown, `Enter on ${back.name} switches the window back to this computer (rows on screen: ${JSON.stringify(returned.timeline)})`).not.toBeNull();
    }

    // Idle: the window on this computer, the host's Sessions listed.
    rig.proxy.resetBytes();
    await page.waitForTimeout(IDLE_MS);
    const idle = rig.proxy.bytes();
    report.idle = { ms: IDLE_MS, toHost: idle.toTarget, toDesktop: idle.toClient, perMinute: Math.round(((idle.toTarget + idle.toClient) / IDLE_MS) * 60_000) };

    // Offline: the link goes quiet, as a sleeping laptop's does.
    const cut = Date.now();
    rig.proxy.forceDown();
    const banner = page.getByTestId('all-machines-sidebar').getByText(`${HOST_LABEL} went offline`);
    await expect(banner, 'the sidebar notices the cut link').toBeVisible({ timeout: 120_000 });
    report.offline = { noticedAfterMs: Date.now() - cut };
    rig.proxy.forceUp({ resume: false });
  } finally {
    writeReport();
    await rig.close();
  }
});
