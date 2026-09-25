import { chromium, expect, test, type Browser, type CDPSession, type Page } from '@playwright/test';
import { installElectronApiMock } from './electronApiMock';
import { getPlaywrightBaseURL } from '../playwright.shared';

// 120 Hz frame harness for terminal streaming.
//
// Boots the real renderer (TerminalPanel + xterm + WebGL) against the Electron
// API mock in headless Chromium and streams heavy terminal output the way main
// delivers it: one `terminal:output` event per 32 ms flush, paused at the
// 100 KB unacked watermark until the renderer acks back down to 5 KB. The mock
// calls listeners directly, so Electron's IPC deserialization is not counted.
//
// It traces the renderer main thread for 2 s and lays a 120 Hz grid over it:
// 240 vsyncs, 8.33 ms apart. A vsync is dropped when it lands inside a main
// thread task longer than one frame, because no frame can start until that
// task ends. (Chromium's begin-frame control would step frames directly, but
// it is Linux-only; the grid gives the same count from a trace on any OS.)
//
//   PANE_FRAME_HARNESS=1 PLAYWRIGHT_PORT=<vite port> pnpm exec playwright test tests/terminal-frames.perf.spec.ts
//
// Optional: FRAME_RUNS (default 5), FRAME_WORKLOADS (comma list), FRAME_HEADLESS_SHELL (binary path),
// FRAME_PROFILE=1 (also print the top self-time functions per run), FRAME_CPU_THROTTLE (e.g. 4).

const FRAME_MS = 1000 / 120;
const FRAMES = 240;
const WARMUP_MS = 500;
const FLUSH_MS = 32; // main's OUTPUT_BATCH_INTERVAL
const FLUSH_BYTES = 131_072; // main's OUTPUT_BATCH_SIZE
const HIGH_WATERMARK = 100_000;
const LOW_WATERMARK = 5_000;
const RUNS = Number(process.env.FRAME_RUNS ?? 5);
const WORKLOADS = (process.env.FRAME_WORKLOADS ?? 'logs,claude-ui,claude-tall').split(',');

const now = new Date(0).toISOString();
const project = { id: 700, name: 'Frame harness', path: '/tmp/frame-harness', active: true, created_at: now, updated_at: now };
const session = {
  id: 'frame-session', name: 'Frames', worktreePath: project.path, prompt: '', status: 'running',
  createdAt: now, lastActivity: now, output: [], jsonMessages: [], isRunning: true, permissionMode: 'ignore',
  projectId: project.id, displayOrder: 0, isFavorite: false, toolType: 'none', archived: false,
  gitStatus: { state: 'clean', ahead: 0, behind: 0, hasUncommittedChanges: false, hasUntrackedFiles: false, filesChanged: 0 },
};
const panel = {
  id: 'frame-panel', sessionId: session.id, type: 'terminal', title: 'Agent',
  state: { isActive: true, hasBeenViewed: true, customState: { isInitialized: true } },
  metadata: { createdAt: now, lastActiveAt: now, position: 1, permanent: false },
};
const dockPanel = {
  ...panel, id: 'frame-dock', title: 'Terminal',
  state: { isActive: false, hasBeenViewed: true, customState: { isInitialized: false } },
  metadata: { ...panel.metadata, position: 0, permanent: true },
};

declare global {
  interface Window {
    __frameStream?: { start(workload: string): void; stop(): void; emitted(): number };
  }
}

// Runs in the page. Builds the workload generators and the flow-controlled
// 32 ms emitter that stands in for main's flushOutputBuffer.
function installStream(options: { sessionId: string; panelId: string; flushMs: number; flushBytes: number; high: number; low: number }) {
  interface Mock { emitPanelTerminalOutput(sessionId: string, panelId: string, output: string): void; getTerminalAckedBytes(): number }
  // SAFETY: installElectronApiMock defines this bridge before the page loads.
  const mock = (window as typeof window & { __paneTestElectronMock: Mock }).__paneTestElectronMock;
  const cols = 150;
  let seed = 1;
  const rand = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  const words = 'the renderer streams tokens into xterm while claude edits files and runs tests across the worktree'.split(' ');
  const sentence = (length: number) => {
    let out = '';
    while (out.length < length) out += words[Math.floor(rand() * words.length)] + ' ';
    return out.slice(0, length);
  };

  // Long build/test log: colored lines, as fast as main will send them.
  let logLine = 0;
  const logs = () => {
    let out = '';
    while (out.length < options.flushBytes) {
      const n = logLine++;
      out += `\x1b[32mINFO\x1b[0m ${String(n).padStart(8)} compiled src/components/panels/TerminalPanel.tsx in ${n % 97}ms \x1b[2m(cache hit)\x1b[0m ✓ LINE-${n}\r\n`;
    }
    return out;
  };

  // Claude Code style UI: ink-like log-update frames that erase and redraw a
  // live region (streaming reply + spinner + input box) inside DEC 2026 sync
  // blocks, committing finished lines above it. Two redraws per flush.
  const claude = (regionRows: number) => {
    const live: string[] = [];
    let previousHeight = 0;
    let tick = 0;
    let committed = 0;
    const box = (text: string) => `\x1b[38;2;136;136;136m│\x1b[39m ${text.padEnd(cols - 4)} \x1b[38;2;136;136;136m│\x1b[39m`;
    const frame = () => {
      tick++;
      let out = '\x1b[?2026h';
      for (let i = 0; i < previousHeight; i++) out += i === previousHeight - 1 ? '\x1b[2K\x1b[G' : '\x1b[2K\x1b[1A';
      if (live.length === 0 || live[live.length - 1].length > cols - 12) live.push('');
      live[live.length - 1] += sentence(6 + Math.floor(rand() * 6));
      while (live.length > regionRows - 6) {
        const line = live.shift() ?? '';
        out += `\x1b[1m●\x1b[22m ${line} \x1b[2mCOMMIT-${committed++}\x1b[22m\r\n`;
      }
      const rows = live.map((line, i) => (i % 5 === 0 ? `  \x1b[1m${line}\x1b[22m` : `  ${line.replace(/tokens/g, '\x1b[36mtokens\x1b[39m')}`));
      rows.push('', `\x1b[38;2;215;119;87m✻\x1b[39m Thinking… \x1b[2m(${tick}s · ↓ ${tick * 7} tokens · esc to interrupt)\x1b[22m`);
      rows.push(`\x1b[38;2;136;136;136m╭${'─'.repeat(cols - 2)}╮\x1b[39m`, box('> '), `\x1b[38;2;136;136;136m╰${'─'.repeat(cols - 2)}╯\x1b[39m`);
      rows.push(`  \x1b[2m⏵⏵ accept edits on (shift+tab to cycle)\x1b[22m`);
      out += rows.join('\r\n') + '\x1b[?2026l';
      previousHeight = rows.length;
      return out;
    };
    return () => frame() + frame();
  };

  let timer: ReturnType<typeof setInterval> | null = null;
  let emittedBytes = 0;
  let paused = false;
  window.__frameStream = {
    start(workload: string) {
      const next = workload === 'logs' ? logs : claude(workload === 'claude-tall' ? 120 : 40);
      timer = setInterval(() => {
        const unacked = emittedBytes - mock.getTerminalAckedBytes();
        if (paused && unacked <= options.low) paused = false;
        if (paused) return;
        const output = next();
        emittedBytes += output.length;
        mock.emitPanelTerminalOutput(options.sessionId, options.panelId, output);
        if (emittedBytes - mock.getTerminalAckedBytes() > options.high) paused = true;
      }, options.flushMs);
    },
    stop() { if (timer) clearInterval(timer); timer = null; },
    emitted: () => emittedBytes,
  };
}

interface TraceEvent { name: string; ph: string; ts: number; dur?: number; pid: number; tid: number; args?: { name?: string; data?: { message?: string } } }

async function traceMainThread<T>(cdp: CDPSession, during: () => Promise<T>): Promise<{ events: TraceEvent[]; value: T }> {
  const events: TraceEvent[] = [];
  cdp.on('Tracing.dataCollected', ({ value }) => {
    const batch: object[] = value;
    // SAFETY: Tracing.dataCollected carries Chromium trace events, which have this shape.
    events.push(...(batch as TraceEvent[]));
  });
  const complete = new Promise(resolve => cdp.once('Tracing.tracingComplete', resolve));
  await cdp.send('Tracing.start', { categories: 'devtools.timeline,disabled-by-default-devtools.timeline', transferMode: 'ReportEvents' });
  const value = await during();
  await cdp.send('Tracing.end');
  await complete;
  return { events, value };
}

// FRAME_PROFILE=1: before tracing, sample a separate 2 s window with the CPU profiler and
// print the functions with the most self time, to find what drops frames.
async function topSelfTime<T>(cdp: CDPSession, during: () => Promise<T>): Promise<string[]> {
  await cdp.send('Profiler.enable');
  await cdp.send('Profiler.setSamplingInterval', { interval: 100 });
  await cdp.send('Profiler.start');
  await during();
  const { profile } = await cdp.send('Profiler.stop');
  const nodes = new Map(profile.nodes.map(node => [node.id, node.callFrame]));
  const self = new Map<string, number>();
  let total = 0;
  profile.samples?.forEach((id, index) => {
    const frame = nodes.get(id);
    const delta = (profile.timeDeltas?.[index] ?? 0) / 1000;
    const key = `${frame?.functionName || '(anonymous)'} ${frame?.url.split('/').pop()?.split('?')[0] ?? ''}:${(frame?.lineNumber ?? 0) + 1}`;
    self.set(key, (self.get(key) ?? 0) + delta);
    total += delta;
  });
  return [...self].sort((a, b) => b[1] - a[1]).slice(0, 15)
    .map(([key, ms]) => `${ms.toFixed(0).padStart(6)} ms ${((ms / total) * 100).toFixed(1).padStart(5)}%  ${key}`);
}

// Map the traced window onto 240 vsyncs at 120 Hz.
function frameStats(events: TraceEvent[]) {
  const mark = (message: string) => events.find(e => e.name === 'TimeStamp' && e.args?.data?.message === message);
  const start = mark('frames-start');
  if (!start) throw new Error('trace has no frames-start mark');
  const main = events.find(e => e.name === 'thread_name' && e.args?.name === 'CrRendererMain' && e.pid === start.pid);
  const tid = main?.tid ?? start.tid;
  const t0 = start.ts / 1000;
  const t1 = t0 + FRAMES * FRAME_MS;
  const tasks = events
    .filter(e => e.name === 'RunTask' && e.ph === 'X' && e.pid === start.pid && e.tid === tid)
    .map(e => ({ start: e.ts / 1000, end: (e.ts + (e.dur ?? 0)) / 1000 }))
    .filter(task => task.end > t0 && task.start < t1);
  const long = tasks.filter(task => task.end - task.start > FRAME_MS);
  let dropped = 0;
  for (let i = 0; i < FRAMES; i++) {
    const vsync = t0 + i * FRAME_MS;
    if (long.some(task => task.start < vsync && vsync < task.end)) dropped++;
  }
  const busy = tasks.reduce((sum, task) => sum + Math.min(task.end, t1) - Math.max(task.start, t0), 0);
  const worst = tasks.reduce((max, task) => Math.max(max, task.end - task.start), 0);
  return { dropped, worstMs: Math.round(worst * 10) / 10, longTasks: long.length, mainBusyMs: Math.round(busy) };
}

async function rendererLogs(page: Page): Promise<string> {
  return page.evaluate(() => {
    // SAFETY: installElectronApiMock defines this bridge before the page loads.
    const mock = (window as typeof window & { __paneTestElectronMock: { getConsoleLogCalls(): Array<{ args?: unknown[] }> } }).__paneTestElectronMock;
    return mock.getConsoleLogCalls().map(call => String(call.args?.[0] ?? '')).join('\n');
  });
}

async function ackedBytes(page: Page): Promise<number> {
  // SAFETY: installElectronApiMock defines this bridge before the page loads.
  return page.evaluate(() => (window as typeof window & { __paneTestElectronMock: { getTerminalAckedBytes(): number } }).__paneTestElectronMock.getTerminalAckedBytes());
}

async function runOnce(browser: Browser, workload: string) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await installElectronApiMock(page, {
    platform: 'darwin',
    initialProjects: [project],
    initialSessions: [session],
    initialPanels: [dockPanel, panel],
    initialTerminalStates: { [panel.id]: { scrollbackBuffer: '$ claude\r\n', isAlternateScreen: false } },
    activeProjectId: project.id,
  });
  await page.goto(getPlaywrightBaseURL(), { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.getByRole('button', { name: /^Expand repository Frame harness$/ }).click();
  await page.getByRole('button', { name: session.name, exact: true }).click();
  const tab = page.getByRole('tabpanel', { name: panel.title });
  await expect(tab.locator('.xterm-screen')).toBeVisible({ timeout: 30_000 });
  await expect(tab.getByTestId('terminal-activation-mask')).toHaveCount(0, { timeout: 30_000 });
  // Measure the renderer users get: WebGL, not xterm's DOM fallback.
  await expect.poll(() => rendererLogs(page), { timeout: 30_000 }).toContain(`WebGL renderer loaded for panel ${panel.id}`);
  await page.waitForTimeout(1000); // let boot work settle
  await page.evaluate(installStream, { sessionId: session.id, panelId: panel.id, flushMs: FLUSH_MS, flushBytes: FLUSH_BYTES, high: HIGH_WATERMARK, low: LOW_WATERMARK });

  const cdp = await page.context().newCDPSession(page);
  // FRAME_CPU_THROTTLE=4 approximates a slower laptop.
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: Number(process.env.FRAME_CPU_THROTTLE ?? 1) });
  await page.evaluate(name => window.__frameStream?.start(name), workload);
  await page.waitForTimeout(WARMUP_MS);
  // Streams for one 240-vsync window and returns the bytes xterm rendered in it.
  const window2s = async () => {
    const before = await ackedBytes(page);
    await page.evaluate(() => console.timeStamp('frames-start'));
    await page.waitForTimeout(FRAMES * FRAME_MS + 50);
    return (await ackedBytes(page)) - before;
  };
  if (process.env.FRAME_PROFILE === '1') {
    console.log(`[${workload}] top self time\n${(await topSelfTime(cdp, window2s)).join('\n')}`);
  }
  const { events, value: renderedBytes } = await traceMainThread(cdp, window2s);
  await page.evaluate(() => window.__frameStream?.stop());

  // Guard: every emitted byte reaches xterm once the stream stops.
  const emitted = await page.evaluate(() => window.__frameStream?.emitted() ?? 0);
  await expect.poll(() => ackedBytes(page), { timeout: 30_000 }).toBe(emitted);
  await page.close();
  return { workload, ...frameStats(events), kbRendered: Math.round(renderedBytes / 1024) };
}

test('terminal streaming holds 120 Hz', async () => {
  test.skip(process.env.PANE_FRAME_HARNESS !== '1', 'Set PANE_FRAME_HARNESS=1 and PLAYWRIGHT_PORT to a running Vite dev server.');
  test.setTimeout(20 * 60_000);
  const browser = await chromium.launch({
    headless: true,
    // Any chrome-headless-shell works; point at a cached one if Playwright's own is not installed.
    executablePath: process.env.FRAME_HEADLESS_SHELL || undefined,
    args: ['--use-angle=metal', '--enable-gpu'],
  });
  const results: Array<Awaited<ReturnType<typeof runOnce>>> = [];
  try {
    for (const workload of WORKLOADS) {
      for (let run = 0; run < RUNS; run++) results.push(await runOnce(browser, workload));
    }
  } finally {
    await browser.close();
  }
  const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
  const summary = WORKLOADS.map(workload => {
    const runs = results.filter(result => result.workload === workload);
    const pick = (key: 'dropped' | 'worstMs' | 'longTasks' | 'mainBusyMs' | 'kbRendered') => median(runs.map(run => run[key]));
    return {
      workload,
      runs: runs.length,
      droppedPer240: pick('dropped'),
      droppedRange: `${Math.min(...runs.map(r => r.dropped))}-${Math.max(...runs.map(r => r.dropped))}`,
      worstMs: pick('worstMs'),
      longTasks: pick('longTasks'),
      mainBusyMs: pick('mainBusyMs'),
      kbRendered: pick('kbRendered'),
    };
  });
  console.log(JSON.stringify({ perRun: results }));
  console.table(summary);
});
