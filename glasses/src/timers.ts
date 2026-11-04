// Adapted from GlanceCode (https://github.com/sousyllc/glancecode), MIT License, Copyright (c) 2026 Sousy LLC. See LICENSE.
// Timers that keep firing while the app sits idle.
//
// The Even Hub SDK replaces the global timer functions with its own ("shadow
// timers") so apps keep running when the phone backgrounds the WebView. Measured
// in the simulator, those only tick around bridge activity: an idle app got zero
// ticks in 20 seconds, then two after a single swipe. Renders, reconnects and
// the voice auto-send all depend on timers, so an idle session stopped updating.
//
// This module must be imported before the SDK. It captures the browser's own
// timers, and every helper schedules through both the native and the SDK timer,
// running the callback on whichever fires first.
const g = globalThis;
const native = {
  setTimeout: g.setTimeout.bind(g),
  clearTimeout: g.clearTimeout.bind(g),
  setInterval: g.setInterval.bind(g),
  clearInterval: g.clearInterval.bind(g),
};

export interface Cancel {
  cancel(): void;
}

/** Run `fn` once after `ms`. */
export function later(fn: () => void, ms: number): Cancel {
  let done = false;
  const run = () => {
    if (done) return;
    done = true;
    native.clearTimeout(a);
    g.clearTimeout(b);
    fn();
  };
  const a = native.setTimeout(run, ms);
  const b = g.setTimeout(run, ms);
  return {
    cancel() {
      done = true;
      native.clearTimeout(a);
      g.clearTimeout(b);
    },
  };
}

/** Run `fn` every `ms`. Ticks from the two timers closer than half a period collapse. */
export function every(fn: () => void, ms: number): Cancel {
  let last = 0;
  const tick = () => {
    const now = Date.now();
    if (now - last < ms / 2) return;
    last = now;
    fn();
  };
  const a = native.setInterval(tick, ms);
  const b = g.setInterval(tick, ms);
  return {
    cancel() {
      native.clearInterval(a);
      g.clearInterval(b);
    },
  };
}
