/**
 * How often a screen streaming a browser tab reads its frames (docs/BROWSER_AGENTS.md). Each read
 * waits on the host up to a second for a new frame, so a changing page streams as fast as the link
 * carries it. After a run of "unchanged" answers the screen pauses between reads, a little longer
 * each time, so a still page costs a read every few seconds instead of every second. A frame, the
 * person's input, or a change in the tab's state (the agent clicked or navigated) reads at once and
 * fast again. The longest gap between reads stays well under the host's 10 s screencast idle
 * timeout, so the host keeps encoding and the next change arrives with the next read.
 */

/** "Unchanged" answers in a row (about a second each) before reads slow down. */
const FAST_READS = 5;
/** Each further "unchanged" answer pauses this much longer, up to the cap. */
const PAUSE_STEP_MS = 1_000;
const PAUSE_MAX_MS = 3_000;

export interface FramePace {
  /** Records a frame read's answer and resolves when the next read should go out. */
  next(changed: boolean): Promise<void>;
  /** Reads go out at once and fast again: the person's input, or the tab's state changed. */
  hurry(): void;
  /** Ends a pause: the stream is stopping. */
  stop(): void;
}

export function framePace(): FramePace {
  let unchanged = 0;
  let pause: { timer: ReturnType<typeof setTimeout>; resolve: () => void } | undefined;
  const end = () => {
    if (!pause) return;
    clearTimeout(pause.timer);
    const { resolve } = pause;
    pause = undefined;
    resolve();
  };
  return {
    next(changed) {
      unchanged = changed ? 0 : unchanged + 1;
      const ms = Math.min((unchanged - FAST_READS + 1) * PAUSE_STEP_MS, PAUSE_MAX_MS);
      if (ms <= 0) return Promise.resolve();
      end();
      return new Promise(resolve => { pause = { timer: setTimeout(end, ms), resolve }; });
    },
    hurry() {
      unchanged = 0;
      end();
    },
    stop: end,
  };
}
