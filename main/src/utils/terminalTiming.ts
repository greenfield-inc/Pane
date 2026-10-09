import { TerminalTiming } from '../../../shared/terminalTiming';

export const terminalTiming = process.env.PANE_TERMINAL_TIMING === '1' ? new TerminalTiming() : undefined;

if (terminalTiming) {
  const timing = terminalTiming;
  let previous = performance.now();
  setInterval(() => {
    const now = performance.now();
    timing.record('eventLoopDelay', Math.max(0, now - previous - 250));
    previous = now;
  }, 250).unref();
  setInterval(() => {
    console.info('[TerminalTiming]', JSON.stringify(timing.snapshot()));
  }, 10_000).unref();
}
