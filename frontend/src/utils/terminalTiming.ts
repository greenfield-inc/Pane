import { TerminalTiming } from '../../../shared/terminalTiming';

declare global {
  interface Window {
    paneTerminalTiming?: TerminalTiming;
  }
}

// Opt in before reloading. No timers, observers or per-output allocation when off.
export const terminalTiming = (() => {
  try {
    if (localStorage.getItem('pane:terminalTiming') !== '1') return undefined;
    const timing = new TerminalTiming();
    window.paneTerminalTiming = timing;
    let previous = performance.now();
    setInterval(() => {
      const now = performance.now();
      if (document.visibilityState === 'visible') timing.record('eventLoopDelay', Math.max(0, now - previous - 250));
      previous = now;
    }, 250);
    return timing;
  } catch {
    return undefined;
  }
})();
