// Run after pnpm build:main, under Electron's Node so the runtime matches the app:
// ELECTRON_RUN_AS_NODE=1 node_modules/.bin/electron scripts/benchmark-terminal-emulation.js
//
// Streams agent-style TUI frames into 8 headless terminal models and measures
// how busy that keeps the calling (main) thread. "inline" parses on the calling
// thread, as the main process did before; "worker" uses the emulator thread;
// "none" drops the output, which measures the harness's own floor.
const { performance } = require('node:perf_hooks');
const { TerminalStateEmulator } = require('../main/dist/main/src/services/terminalStateEmulator.js');
const { sharedEmulatorThread } = require('../main/dist/main/src/services/terminalEmulatorClient.js');

const PANES = Number(process.env.PANES ?? 8);
const SECONDS = Number(process.env.SECONDS ?? 10);
const CHUNKS_PER_SECOND = 60;
const COLS = 160;
const ROWS = 48;

// One redraw of a full-screen agent UI: cursor-addressed, colored rows plus a
// spinner and status line, about 12 KB per frame.
function frame(pane, tick) {
  const spinner = '⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏'[tick % 10];
  let out = '\x1b[?2026h\x1b[H';
  for (let row = 1; row < ROWS; row += 1) {
    const color = 16 + ((row + tick) % 216);
    out += `\x1b[${row};1H\x1b[2K\x1b[38;5;${color}m${spinner} pane ${pane} row ${row} tick ${tick} \x1b[1m`;
    out += `${'lorem ipsum dolor sit amet '.repeat(4)}`.slice(0, COLS - 40) + '\x1b[0m';
  }
  out += `\x1b[${ROWS};1H\x1b[7m status: working ${tick} \x1b[0m\x1b[?2026l`;
  return out;
}

// Pre-render the frames so the producer's own string building does not count
// against the main thread being measured.
const FRAME_CYCLE = 120;
const frames = Array.from({ length: PANES }, (_, pane) =>
  Array.from({ length: FRAME_CYCLE }, (_, tick) => frame(pane, tick)));

async function run(mode) {
  const emulators = Array.from({ length: PANES }, () => mode === 'worker'
    ? sharedEmulatorThread().createEmulator(COLS, ROWS)
    : new TerminalStateEmulator(COLS, ROWS));
  for (const emulator of emulators) emulator.write('\x1b[?1049h');

  // Event-loop delay: a 16 ms heartbeat stands in for main-process work that
  // must stay on time (IPC replies, output batching); lateness is how long it
  // waited past due.
  const lateness = [];
  let expected = performance.now() + 16;
  const heartbeat = setInterval(() => {
    const now = performance.now();
    lateness.push(Math.max(0, now - expected));
    expected = now + 16;
  }, 16);

  let tick = 0;
  let bytes = 0;
  const eluStart = performance.eventLoopUtilization();
  const started = performance.now();
  await new Promise((resolve) => {
    const producer = setInterval(() => {
      tick += 1;
      for (let pane = 0; pane < PANES; pane += 1) {
        const chunk = frames[pane][tick % FRAME_CYCLE];
        bytes += chunk.length;
        if (mode !== 'none') emulators[pane].write(chunk);
      }
      if (performance.now() - started >= SECONDS * 1000) {
        clearInterval(producer);
        resolve();
      }
    }, 1000 / CHUNKS_PER_SECOND);
  });
  clearInterval(heartbeat);
  const elu = performance.eventLoopUtilization(eluStart);

  // Every frame must still be parsed: time until all models are caught up.
  // The emulator thread is unref'd (it never holds the app open), so keep this
  // script alive while it drains.
  const keepAlive = setInterval(() => {}, 1000);
  const drainStarted = performance.now();
  await Promise.all(emulators.map((emulator) => mode === 'worker' ? emulator.refresh() : emulator.waitForIdle()));
  const drainMs = performance.now() - drainStarted;
  clearInterval(keepAlive);
  const screen = mode === 'worker' ? emulators[0].state.screenText : emulators[0].getScreenText();
  if (mode !== 'none' && !screen.includes(`status: working ${tick % FRAME_CYCLE} `)) throw new Error(`${mode}: final frame missing`);
  for (const emulator of emulators) emulator.dispose();

  lateness.sort((a, b) => a - b);
  const pct = (p) => Number(lateness[Math.min(lateness.length - 1, Math.floor(lateness.length * p))].toFixed(1));
  return {
    mode,
    inputMiBPerSecond: Number((bytes / 1024 / 1024 / SECONDS).toFixed(1)),
    mainThreadBusyPercent: Number((elu.utilization * 100).toFixed(1)),
    eventLoopDelayMs: { p50: pct(0.5), p99: pct(0.99), max: pct(1) },
    drainAfterStopMs: Math.round(drainMs),
  };
}

(async () => {
  const modes = process.argv.slice(2).length > 0 ? process.argv.slice(2) : ['none', 'inline', 'worker'];
  const results = [];
  for (const mode of modes) results.push(await run(mode));
  console.log(JSON.stringify({ electronNode: process.version, panes: PANES, seconds: SECONDS, results }, null, 2));
  process.exit(0);
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
