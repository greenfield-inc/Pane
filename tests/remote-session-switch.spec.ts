import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { HOST_LABEL, startRig, type Rig } from './remoteRig';
import { endMark, type SeededChat } from './scriptedChats';
import { armVisibleProbe, readVisibleProbe } from './switchProbe';

/**
 * Another machine's Sessions over a slow link (T-116 PR 1): the two-instance rig (remoteRig.ts),
 * measured as the app is today, so later PRs have a baseline to beat. Runs under
 * playwright.remote-switch.config.ts only (production renderer, real Electron).
 *
 * Reported, not asserted: Enter on another machine's Session → the window on that machine, on
 * that Session, its chat visible, and back; bytes over the link per open and per idle minute;
 * arrow-key cursor moves at 30 key repeats a second (D-6), with nothing loading and while a switch
 * is in flight; how long until a cut link shows the machine offline.
 *
 * Hard checks, none of them timing: Tailscale is off in both Panes (remoteRig.ts), the desktop
 * reaches the host only through the proxy, each Enter moves the window to the row's machine, and
 * a cut link is noticed. Landing on the row's own Session is reported, not checked: today a switch
 * can land on the host's own selected Session instead, which T-116 PR 3 fixes and then checks.
 * Before each open on the host, the host's own selection is parked on a Session that is never
 * pressed, so a landing on the host's selection can't pass as the right one.
 */

const OUT = path.resolve(process.env.REMOTE_SWITCH_OUT ?? 'test-results/remote-session-switch');
const LATENCY_MS = Number(process.env.REMOTE_SWITCH_RTT_MS ?? 50);
const OPENS = Number(process.env.REMOTE_SWITCH_OPENS ?? 8);
const IDLE_MS = Number(process.env.REMOTE_SWITCH_IDLE_MS ?? 30_000);
const ARROW_PRESSES = 40;
const ARROW_INTERVAL_MS = 1000 / 30;

test.skip(!process.env.PANE_REMOTE_SWITCH_BENCH, 'Runs under playwright.remote-switch.config.ts (production renderer).');

/** The host's own selection waits here before each open on the host; it is never pressed. */
const PARKED = 'host-parked';
const HOST_CHATS = [
  ...['01', '02', '03', '04'].map(n => ({ name: `host-short-${n}`, turns: 5 })),
  ...['01', '02', '03', '04'].map(n => ({ name: `host-long-${n}`, turns: 100 })),
  { name: PARKED, turns: 5 },
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

/** The first visit to the host from this desktop greets it; the greeting covers the rows. */
async function dismissWelcome(page: Page): Promise<void> {
  const welcome = page.getByRole('button', { name: 'Don\'t show this again' });
  if (await welcome.isVisible().catch(() => false)) await welcome.click();
}

/** The host's own selected Session, by name. */
async function hostSelection(rig: Rig): Promise<string | null> {
  const id = await rig.host.page.evaluate(async () => {
    const listed = await window.electronAPI.orchestrationSessions.list();
    // SAFETY: orchestration-sessions:list answers { sessions, selectedSessionId } (OrchestrationSessionListResult).
    return listed.success ? (listed.data as { selectedSessionId?: string | null }).selectedSessionId ?? null : null;
  });
  return rig.host.sessions.find(session => session.id === id)?.name ?? id;
}

/** Moves the host's own selection to the parked Session, away from any Session the rig presses. */
async function parkHost(rig: Rig): Promise<void> {
  const parked = rig.host.sessions.find(session => session.name === PARKED);
  if (!parked) throw new Error(`The host has no ${PARKED} Session to park its selection on.`);
  await rig.host.page.evaluate(async sessionId => {
    const selected = await window.electronAPI.orchestrationSessions.select({ sessionId });
    if (!selected.success) throw new Error(`Selecting the parked Session on the host failed: ${selected.error}`);
  }, parked.id);
  await expect.poll(() => hostSelection(rig), { message: `the host's own selection is ${PARKED}` }).toBe(PARKED);
}

/**
 * One Enter on a Session's row, timed from the keydown:
 * - shown: the first frame where the sidebar marks a row of the target's machine as the one on screen;
 * - landedOn: the row marked at the end, and whether it is the target (today a switch can land on
 *   the host's own selected Session instead: T-116 PR 3 fixes that and turns it into a hard check);
 *   hostSelection is the host's own selection at the press (parked, for opens on the host);
 * - visible: when the target's chat showed its last message, or null when it never did;
 * - bytes: over the link from the keydown to the chat visible, or to the landing on another
 *   Session; windowMs says how long that was.
 */
interface OpenSample {
  direction: 'there' | 'back';
  session: string;
  hostSelection: string | null;
  shown: number | null;
  landedOn: string | null;
  rightSession: boolean;
  visible: number | null;
  painted: number | null;
  bytesToHost: number;
  bytesToDesktop: number;
  windowMs: number | null;
  /** The marked row's label each time it changed, ms from the keydown. */
  timeline: Array<[number, string]>;
}

interface ShownRows {
  rows: Array<[number, string]>;
  /** Set by the recorder when it stops: why. */
  finished?: 'probe-and-row' | 'landed-elsewhere' | 'no-row';
  finishedAt?: number;
}

declare global {
  /** The in-page recorder of the sidebar row marked as on screen (openWithEnter below). */
  var __paneShownRows: ShownRows | undefined;
  /** The in-page recorder for arrow-key cursor moves (measureCursor below). */
  var __paneCursorProbe: CursorProbe | undefined;
  /** In the desktop's main process: stops its event-loop check and returns the longest stall, ms (measureCursor below). */
  var __paneMainStall: (() => number) | undefined;
  /** When the offline banner first showed, as epoch ms (the offline step below). */
  var __paneOfflineAt: number | undefined;
}

/** How long an open may take before it counts as not having shown its chat. */
const OPEN_TIMEOUT_MS = 20_000;
/** A landing on another Session that holds this long ends the open early (it won't show the target). */
const LANDED_ELSEWHERE_MS = 2_000;
/** After the chat is visible, how long the marked row may still take to reach the target's machine. */
const ROW_GRACE_MS = 5_000;

/** Enter on a Session's row; times its machine and chat on screen and counts the bytes over the link meanwhile. */
async function openWithEnter(rig: Rig, session: SeededChat, direction: OpenSample['direction']): Promise<OpenSample> {
  const { page } = rig.desktop;
  const row = sessionRow(page, session.name);
  await row.scrollIntoViewIfNeeded();
  const target = await row.getAttribute('aria-label') ?? '';
  const machine = target.slice(target.lastIndexOf(' on ') + 4);
  const selectedOnHost = await hostSelection(rig);
  await armVisibleProbe(page, { panelId: session.panelId, mark: endMark(session.name), focuses: false, timeoutMs: OPEN_TIMEOUT_MS });
  // The recorder stops itself once the chat probe is done and a row of the target's machine is
  // marked (or a grace period passed), or once a landing on another Session has held.
  const timeOrigin = await page.evaluate(({ target, suffix, landedElsewhereMs, rowGraceMs }) => {
    const recorder: ShownRows = { rows: [] };
    globalThis.__paneShownRows = recorder;
    let probeDoneAt: number | undefined;
    const finish = (why: NonNullable<ShownRows['finished']>, now: number) => { recorder.finished = why; recorder.finishedAt = now; };
    const tick = () => {
      const now = performance.now();
      const label = document.querySelector('[data-testid="all-machines-sidebar"] [aria-current="page"]')?.getAttribute('aria-label') ?? '-';
      if (recorder.rows.at(-1)?.[1] !== label) recorder.rows.push([now, label]);
      const probe = globalThis.__paneSwitchProbe;
      const input = probe?.input;
      const onMachine = input !== undefined && recorder.rows.some(([at, row]) => at >= input && row.endsWith(suffix));
      const last = recorder.rows.at(-1);
      if (probe?.timedOut !== undefined) {
        probeDoneAt ??= now;
        if (onMachine) return finish('probe-and-row', now);
        if (now - probeDoneAt > rowGraceMs) return finish('no-row', now);
      } else if (probe && onMachine && last && input !== undefined && last[0] >= input && last[1] !== target && now - last[0] > landedElsewhereMs) {
        probe.cancelled = true;
        return finish('landed-elsewhere', now);
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    return performance.timeOrigin;
  }, { target, suffix: ` on ${machine}`, landedElsewhereMs: LANDED_ELSEWHERE_MS, rowGraceMs: ROW_GRACE_MS });

  // Bytes over the link, sampled through the open, so the window can end where the open did.
  rig.proxy.resetBytes();
  const samples: Array<{ at: number; toTarget: number; toClient: number }> = [];
  const sample = () => samples.push({ at: Date.now(), ...rig.proxy.bytes() });
  sample();
  const sampler = setInterval(sample, 20);
  try {
    await row.focus();
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => globalThis.__paneShownRows?.finished !== undefined, undefined, { timeout: OPEN_TIMEOUT_MS + ROW_GRACE_MS + 30_000, polling: 50 });
  } finally {
    clearInterval(sampler);
    sample();
  }
  const { done } = await readVisibleProbe(page);
  const recorded = await page.evaluate(() => globalThis.__paneShownRows ?? { rows: [] });
  const rows = recorded.rows;
  const since = (t: number | undefined) => (t === undefined || done.input === undefined ? null : +(t - done.input).toFixed(1));
  const timeline = rows.map(([t, label]): [number, string] => [since(t) ?? NaN, label]).filter(([t]) => Number.isNaN(t) || t >= 0);
  const landedOn = rows.at(-1)?.[1] ?? null;
  const rightSession = landedOn === target;
  // The window ends at the chat visible, or at the landing elsewhere; the bytes are the first sample at or after it.
  const end = rightSession && done.visible !== undefined ? done.visible : recorded.finished === 'landed-elsewhere' ? rows.at(-1)?.[0] : undefined;
  const endEpoch = end === undefined ? undefined : timeOrigin + end;
  const bytes = (endEpoch === undefined ? undefined : samples.find(entry => entry.at >= endEpoch)) ?? samples[samples.length - 1];
  await dismissWelcome(page);
  return {
    direction,
    session: session.name,
    hostSelection: selectedOnHost,
    shown: since(rows.find(([t, label]) => done.input !== undefined && t >= done.input && label.endsWith(` on ${machine}`))?.[0]),
    landedOn,
    rightSession,
    visible: since(done.visible),
    painted: since(done.painted),
    bytesToHost: bytes.toTarget,
    bytesToDesktop: bytes.toClient,
    windowMs: since(end),
    timeline,
  };
}

// ---------------------------------------------------------------------------
// Arrow keys (D-6)

interface CursorPress {
  at: number;
  repeat: boolean;
  /** The row the cursor should be on after this press: one row on from where it was. */
  expected: string;
  /** ms from the keydown to the first frame with focus on the expected row, before the next press. */
  moved: number | null;
  /** The press found the cursor at the end of the list, so it had nowhere to go (not counted). */
  edge: boolean;
  /** The press found focus off the sidebar's rows (a switch took it): the cursor can't move, so it counts as lost. */
  offRows: boolean;
}
interface CursorProbe { presses: CursorPress[]; longTasks: number[]; strayedFrames: number; frames: number; stop: boolean; focusOffRows: string[] }

interface CursorResult {
  label: string;
  presses: number;
  repeats: number;
  moved: number;
  /** Presses whose cursor wasn't on the expected row by the next press (or 1 s for the last), offRows included. */
  lost: number;
  /** Of those, presses that found focus off the sidebar's rows, and where focus was instead. */
  offRows: number;
  focusOffRows: string[];
  edge: number;
  /** Frames where focus wasn't on a sidebar row at all. */
  strayedFrames: number;
  rateHz: number | null;
  intervalP95: number | null;
  /** The keydown intervals the page saw, ms, so a stall in delivery shows. */
  intervals: number[];
  /** From the test sending each key to the page's keydown: delay in the browser before the renderer sees it. */
  lagP95: number | null;
  lagMax: number | null;
  /** From the test sending each key to the cursor on its row: what a person holding the key would see. */
  sentToRowP95: number | null;
  sentToRowMax: number | null;
  /** The desktop's Electron main process: its longest event-loop stall during the pass, ms (keys reach the page through it). */
  mainStallMax: number | null;
  p50: number | null;
  p95: number | null;
  max: number | null;
  longTasks: number;
  longestTask: number | null;
}

/**
 * Arrows through the sidebar at 30 key repeats a second (D-6), down to the last row and back up:
 * - presses go out on fixed deadlines as held-key repeats (keydown with repeat: true, one keyup
 *   when the direction turns), and the rate the page saw is reported;
 * - each press expects the cursor one row on from where it was, by row key, and counts as moved
 *   only when focus is on that row by the next press; a press that misses is lost, and the next
 *   press starts from where the cursor really is, so no press is credited with another's move;
 * - a press that finds focus off the sidebar's rows (a switch took it) is lost too, and counted;
 *   frames with focus off the rows are counted, and long tasks meanwhile.
 * `before` runs just before the first press, once the probe is armed (an Enter on a host Session,
 * whose switch is then in flight through the pass).
 */
async function measureCursor({ app, page }: { app: ElectronApplication; page: Page }, label: string, before?: () => Promise<void>): Promise<CursorResult> {
  const rows = page.getByTestId('all-machines-sidebar').locator('[data-sidebar-item]');
  const count = await rows.count();
  expect(count, 'the sidebar has rows to arrow through').toBeGreaterThan(2);
  await rows.first().focus();
  await page.evaluate(() => {
    const probe: CursorProbe = { presses: [], longTasks: [], strayedFrames: 0, frames: 0, stop: false, focusOffRows: [] };
    globalThis.__paneCursorProbe = probe;
    const observer = new PerformanceObserver(list => { for (const entry of list.getEntries()) probe.longTasks.push(entry.duration); });
    observer.observe({ type: 'longtask' });
    const rowList = () => Array.from(document.querySelectorAll<HTMLElement>('[data-testid="all-machines-sidebar"] [data-sidebar-item]'));
    const activeIndex = (list: Element[]) => list.findIndex(element => element === document.activeElement);
    const keyOf = (element: Element | undefined | null) => (element ? element.getAttribute('data-sidebar-key') ?? `toggle:${element.textContent?.trim() ?? ''}` : '-');
    /** Resolves the newest press when the cursor is on its row. */
    const check = (now: number) => {
      const press = probe.presses.at(-1);
      if (press && press.moved === null && !press.edge && !press.offRows && keyOf(document.activeElement) === press.expected) press.moved = now - press.at;
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
      // Runs before the sidebar's own handler: the previous press had until now.
      check(performance.now());
      const list = rowList();
      const from = activeIndex(list);
      if (from < 0) {
        const active = document.activeElement;
        const where = active ? `${active.tagName.toLowerCase()}${active.getAttribute('data-testid') ? `[data-testid=${active.getAttribute('data-testid')}]` : ''}${active.getAttribute('aria-label') ? `[aria-label=${active.getAttribute('aria-label')}]` : ''}` : 'nothing';
        if (!probe.focusOffRows.includes(where)) probe.focusOffRows.push(where);
      }
      const to = Math.max(0, Math.min(list.length - 1, from + (event.key === 'ArrowDown' ? 1 : -1)));
      probe.presses.push({ at: event.timeStamp, repeat: event.repeat, expected: keyOf(list[to]), moved: null, edge: from >= 0 && to === from, offRows: from < 0 });
    };
    window.addEventListener('keydown', onKey, { capture: true });
    const tick = () => {
      const now = performance.now();
      probe.frames += 1;
      check(now);
      if (activeIndex(rowList()) < 0) probe.strayedFrames += 1;
      const last = probe.presses.at(-1);
      if (probe.stop && (!last || last.moved !== null || now - last.at > 1_000)) {
        window.removeEventListener('keydown', onKey, { capture: true });
        observer.disconnect();
        return;
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });

  // The main process's event loop, checked every 10 ms: a stall there holds every key on its way to the page.
  await app.evaluate(() => {
    let max = 0;
    let last = Date.now();
    const timer = setInterval(() => { const now = Date.now(); max = Math.max(max, now - last - 10); last = now; }, 10);
    globalThis.__paneMainStall = () => { clearInterval(timer); return max; };
  });
  await before?.();
  // Down to the last row and back up, as held keys: repeats on fixed deadlines, a keyup at each turn.
  // Sent over CDP without waiting for each answer, so a slow round trip can't stretch the interval.
  const cdp = await page.context().newCDPSession(page);
  const keyEvent = (type: 'keyDown' | 'keyUp', key: 'ArrowDown' | 'ArrowUp', autoRepeat = false) =>
    cdp.send('Input.dispatchKeyEvent', { type, key, code: key, windowsVirtualKeyCode: key === 'ArrowDown' ? 40 : 38, autoRepeat });
  const sweep = count - 1;
  const started = Date.now();
  const sent: Array<Promise<unknown>> = [];
  const sentAt: number[] = [];
  let held: 'ArrowDown' | 'ArrowUp' | null = null;
  for (let press = 0; press < ARROW_PRESSES; press++) {
    const key = Math.floor(press / sweep) % 2 === 0 ? 'ArrowDown' : 'ArrowUp';
    const wait = started + press * ARROW_INTERVAL_MS - Date.now();
    if (wait > 0) await new Promise(resolve => setTimeout(resolve, wait));
    if (held && held !== key) sent.push(keyEvent('keyUp', held));
    sentAt.push(Date.now());
    sent.push(keyEvent('keyDown', key, held === key));
    held = key;
  }
  if (held) sent.push(keyEvent('keyUp', held));
  await Promise.all(sent);
  await cdp.detach();
  const mainStallMax = await app.evaluate(() => globalThis.__paneMainStall?.() ?? null);
  await page.evaluate(() => { if (globalThis.__paneCursorProbe) globalThis.__paneCursorProbe.stop = true; });
  await page.waitForTimeout(1_200);
  const { probe, timeOrigin } = await page.evaluate(() => ({ probe: globalThis.__paneCursorProbe ?? { presses: [], longTasks: [], strayedFrames: 0, frames: 0, stop: true, focusOffRows: [] }, timeOrigin: performance.timeOrigin }));
  // The page sees every key the test sent, in order, so the nth keydown is the nth send.
  const lags = probe.presses.map((press, index) => timeOrigin + press.at - sentAt[index]).filter(Number.isFinite);
  const sentToRow = probe.presses.flatMap((press, index) => (press.moved === null || press.edge ? [] : [timeOrigin + press.at + press.moved - sentAt[index]]));
  const counted = probe.presses.filter(press => !press.edge);
  const moves = counted.map(press => press.moved).filter((value): value is number => value !== null);
  const times = probe.presses.map(press => press.at);
  const intervals = times.slice(1).map((at, index) => at - times[index]);
  return {
    label,
    presses: probe.presses.length,
    repeats: probe.presses.filter(press => press.repeat).length,
    moved: moves.length,
    lost: counted.length - moves.length,
    offRows: probe.presses.filter(press => press.offRows).length,
    focusOffRows: probe.focusOffRows,
    edge: probe.presses.length - counted.length,
    strayedFrames: probe.strayedFrames,
    rateHz: times.length > 1 ? +(((times.length - 1) * 1000) / (times[times.length - 1] - times[0])).toFixed(1) : null,
    intervalP95: percentile(intervals, 95),
    intervals: intervals.map(value => +value.toFixed(1)),
    lagP95: percentile(lags, 95),
    lagMax: lags.length ? +Math.max(...lags).toFixed(1) : null,
    sentToRowP95: percentile(sentToRow, 95),
    sentToRowMax: sentToRow.length ? +Math.max(...sentToRow).toFixed(1) : null,
    mainStallMax,
    p50: percentile(moves, 50),
    p95: percentile(moves, 95),
    max: moves.length ? +Math.max(...moves).toFixed(1) : null,
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
  cursor: CursorResult[];
  /** sinceCutMs from the cut; sinceLastByteMs from the host's last bytes to the desktop before it (its last heartbeat, near enough). */
  offline?: { sinceCutMs: number | null; sinceLastByteMs: number | null };
}
const report: Report = { opens: [], cursor: [] };

const ms = (value: number | null | undefined) => (value === null || value === undefined ? '–' : String(Math.round(value)));
const kb = (bytes: number) => `${(bytes / 1024).toFixed(0)} KB`;

function markdown(): string {
  const lines = [`### Another machine's Sessions over a ${report.meta?.latencyMs ?? LATENCY_MS} ms link (reported only)`, ''];
  lines.push('| Enter on a row | n | machine shown p50 / p95 (ms) | landed on that Session | its chat visible p50 / p95 (ms), n | bytes over the link, p50 (window p50) |', '|---|---|---|---|---|---|');
  for (const direction of ['there', 'back'] as const) {
    const rows = report.opens.filter(sample => sample.direction === direction);
    const column = (pick: (sample: OpenSample) => number | null) => rows.map(pick).filter((value): value is number => value !== null);
    const bytes = rows.map(sample => sample.bytesToHost + sample.bytesToDesktop);
    // A press on the host's own selection would land there with no restore working: kept out of the landed count.
    const fair = direction === 'there' ? rows.filter(sample => sample.hostSelection !== sample.session) : rows;
    const onSelection = rows.length - fair.length;
    const label = direction === 'there' ? 'the host\'s Session (the window switches to the host)' : 'this computer\'s Session (the window switches back)';
    lines.push(`| ${label} | ${rows.length} | **${ms(percentile(column(s => s.shown), 50))} / ${ms(percentile(column(s => s.shown), 95))}** | ${fair.filter(s => s.rightSession).length}/${fair.length}${onSelection ? ` (${onSelection} pressed the host's own selection, not counted)` : ''} | **${ms(percentile(column(s => s.visible), 50))} / ${ms(percentile(column(s => s.visible), 95))}**, ${column(s => s.visible).length} | ${bytes.length ? kb(percentile(bytes, 50) ?? 0) : '–'} (${ms(percentile(column(s => s.windowMs), 50))} ms) |`);
  }
  const wrong = report.opens.filter(sample => !sample.rightSession);
  if (wrong.length) lines.push('', `Landed elsewhere: ${wrong.map(sample => `${sample.session} → ${sample.landedOn ?? 'no Session'}`).join('; ')}. The host's own selection was ${PARKED} before each open there.`);
  for (const cursor of report.cursor) {
    const tasks = cursor.longTasks ? `${cursor.longTasks} long tasks (longest ${ms(cursor.longestTask)} ms)` : 'no long tasks';
    lines.push('', `Arrow keys ${cursor.label}: ${cursor.presses} presses (${cursor.repeats} key repeats) at **${cursor.rateHz ?? '–'} a second** (interval p95 ${ms(cursor.intervalP95)} ms, longest ${ms(Math.max(...cursor.intervals))} ms); the cursor reached the next row before the next press on **${cursor.moved} of ${cursor.presses - cursor.edge}**, ${cursor.lost} lost${cursor.offRows ? ` (${cursor.offRows} found focus off the sidebar's rows, on ${cursor.focusOffRows.join(', ')})` : ''}${cursor.edge ? `, ${cursor.edge} at the end of the list` : ''}; keydown → row p50 **${ms(cursor.p50)} ms**, p95 **${ms(cursor.p95)} ms**, max ${ms(cursor.max)} ms; key sent → row p95 **${ms(cursor.sentToRowP95)} ms**, max ${ms(cursor.sentToRowMax)} ms (key sent → keydown p95 ${ms(cursor.lagP95)} ms, max ${ms(cursor.lagMax)} ms; the main process's longest stall ${ms(cursor.mainStallMax)} ms); focus off the rows for ${cursor.strayedFrames} frames; ${tasks}.`);
  }
  if (report.idle) lines.push('', `Idle link, window on this computer: **${report.idle.perMinute} bytes per minute** (${report.idle.toHost} bytes to the host, ${report.idle.toDesktop} back, over ${Math.round(report.idle.ms / 1000)} s).`);
  if (report.offline) lines.push('', `Link cut: the sidebar said the host went offline **${ms(report.offline.sinceCutMs)} ms** after the cut, ${ms(report.offline.sinceLastByteMs)} ms after the host's last bytes reached the desktop.`);
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
  const pressed = rig.host.sessions.filter(session => session.name !== PARKED);
  try {
    await openAllMachines(page);
    // The host's Sessions arrive over the proxy, or the rig is not linked.
    for (const session of rig.host.sessions) await expect(sessionRow(page, session.name), `${session.name} is listed from ${HOST_LABEL}`).toBeVisible({ timeout: 60_000 });
    expect(rig.proxy.bytes().toClient, 'the desktop heard from the host through the proxy').toBeGreaterThan(0);
    // And by no other way: the desktop's one saved computer has only the proxy's route, even after the host's ready report.
    const routes = await page.evaluate(async () => {
      const config = await window.electronAPI.remoteDaemon.getConfig();
      return config.success && config.data ? config.data.client.computers.map(computer => computer.routes.map(route => route.baseUrl)) : null;
    });
    expect(routes, 'the desktop reaches the host only through the proxy').toEqual([[`http://127.0.0.1:${rig.proxy.port}`]]);

    // Arrow keys first, before any open, so the cursor sees today's sidebar alone.
    report.cursor.push(await measureCursor(rig.desktop, 'with nothing loading'));

    // Start from one of this computer's Sessions, as a desktop in use does, outside the samples.
    const start = await openWithEnter(rig, rig.desktop.sessions[1], 'back');
    expect(start.visible, `${start.session} shows its last message (rows on screen: ${JSON.stringify(start.timeline)})`).not.toBeNull();

    for (let index = 0; index < OPENS; index++) {
      const there = pressed[index % pressed.length];
      await parkHost(rig);
      const sample = await openWithEnter(rig, there, 'there');
      report.opens.push(sample);
      expect(sample.shown, `Enter on ${there.name} switches the window to ${HOST_LABEL} (rows on screen: ${JSON.stringify(sample.timeline)})`).not.toBeNull();
      const back = rig.desktop.sessions[index % rig.desktop.sessions.length];
      const returned = await openWithEnter(rig, back, 'back');
      report.opens.push(returned);
      expect(returned.shown, `Enter on ${back.name} switches the window back to this computer (rows on screen: ${JSON.stringify(returned.timeline)})`).not.toBeNull();
    }

    // Arrow keys again, right after an Enter on a host Session, while that switch is in flight (D-6).
    await parkHost(rig);
    const inFlight = pressed[pressed.length - 1];
    report.cursor.push(await measureCursor(rig.desktop, 'while a switch to the host is in flight', async () => {
      await sessionRow(page, inFlight.name).press('Enter');
    }));
    await page.waitForTimeout(3_000);
    await dismissWelcome(page);
    await openWithEnter(rig, rig.desktop.sessions[0], 'back');

    // Idle: the window on this computer, the host's Sessions listed.
    rig.proxy.resetBytes();
    await page.waitForTimeout(IDLE_MS);
    const idle = rig.proxy.bytes();
    report.idle = { ms: IDLE_MS, toHost: idle.toTarget, toDesktop: idle.toClient, perMinute: Math.round(((idle.toTarget + idle.toClient) / IDLE_MS) * 60_000) };

    // Offline: the link goes quiet, as a sleeping laptop's does. The banner is timed in the page, each frame.
    const bannerText = `${HOST_LABEL} went offline`;
    await page.evaluate(text => {
      globalThis.__paneOfflineAt = undefined;
      const tick = () => {
        if (document.querySelector('[data-testid="all-machines-sidebar"]')?.textContent?.includes(text)) return void (globalThis.__paneOfflineAt = performance.timeOrigin + performance.now());
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    }, bannerText);
    const cut = Date.now();
    rig.proxy.forceDown();
    const lastByte = rig.proxy.lastDelivered().toClient;
    await expect(page.getByTestId('all-machines-sidebar').getByText(bannerText), 'the sidebar notices the cut link').toBeVisible({ timeout: 120_000 });
    await page.waitForFunction(() => globalThis.__paneOfflineAt !== undefined, undefined, { timeout: 5_000 });
    const noticed = await page.evaluate(() => globalThis.__paneOfflineAt ?? null);
    report.offline = {
      sinceCutMs: noticed === null ? null : Math.round(noticed - cut),
      sinceLastByteMs: noticed === null || lastByte === null ? null : Math.round(noticed - lastByte),
    };
    rig.proxy.forceUp({ resume: false });
  } finally {
    writeReport();
    await rig.close();
  }
});
