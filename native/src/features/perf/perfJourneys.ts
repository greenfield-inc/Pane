import { AppState } from 'react-native';

import { logStall, markNextFrame, PERF_BUILD, startJourney } from './perfMarks';

/** A JavaScript gap longer than this is logged as a stall in a perf build. */
const STALL_MS = 100;
const TICK_MS = 16;

// In a perf build: the app-wide journeys, `launch` when this module loads (the first import in
// `index.ts`) and `return` each time the app comes back from the background, and stall logging.
if (PERF_BUILD) {
  startJourney('launch');
  let backgrounded = false;
  AppState.addEventListener('change', state => {
    if (state === 'background') backgrounded = true;
    else if (state === 'active' && backgrounded) {
      backgrounded = false;
      startJourney('return');
      markNextFrame(['return']);
    }
  });
  watchStalls();
}

function watchStalls(): void {
  let last = performance.now();
  setInterval(() => {
    const at = performance.now();
    // A suspended app's timers stop, so only gaps while active count.
    if (at - last > STALL_MS && AppState.currentState === 'active') logStall(at - last - TICK_MS);
    last = at;
  }, TICK_MS);
}
