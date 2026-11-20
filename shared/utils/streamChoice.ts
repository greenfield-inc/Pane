/**
 * Whether a screen on another device shows a browser tab as its own copy or as the host's stream
 * (docs/BROWSER_AGENTS.md). The own copy is the default. The stream starts when an agent acts on the
 * page (the tab's driver is the agent), stays while it does, and ends STREAM_IDLE_MS after its last
 * action, or sooner when the person picks Back to my copy. Host files and dev servers never stream;
 * callers check that first.
 */
export interface StreamChoice {
  stream: boolean;
  /** An agent drives the tab now. */
  driving: boolean;
  /** When the agent last stopped driving, while it doesn't. */
  idleSince?: number;
  /** The person went back to the own copy while this run of agent actions went on. */
  keptCopy: boolean;
}

export type StreamChoiceEvent =
  | { kind: 'driver'; driving: boolean; at: number }
  | { kind: 'back' }
  | { kind: 'tick'; at: number };

/** How long after an agent's last action the screen goes back to its own copy. */
export const STREAM_IDLE_MS = 30_000;

export function initialStreamChoice(driving: boolean): StreamChoice {
  return { stream: driving, driving, keptCopy: false };
}

export function streamChoice(state: StreamChoice, event: StreamChoiceEvent): StreamChoice {
  switch (event.kind) {
    case 'driver':
      if (event.driving === state.driving) return state;
      return event.driving
        ? { stream: state.stream || !state.keptCopy, driving: true, keptCopy: state.keptCopy }
        : { stream: state.stream, driving: false, idleSince: event.at, keptCopy: false };
    case 'back':
      return { ...state, stream: false, keptCopy: state.driving };
    case 'tick':
      if (!state.stream || state.driving || state.idleSince === undefined || event.at - state.idleSince < STREAM_IDLE_MS) return state;
      return { ...state, stream: false };
  }
}

/** When the next tick can change `state`, or undefined when none can. */
export function nextStreamTick(state: StreamChoice): number | undefined {
  return state.stream && !state.driving && state.idleSince !== undefined ? state.idleSince + STREAM_IDLE_MS : undefined;
}
