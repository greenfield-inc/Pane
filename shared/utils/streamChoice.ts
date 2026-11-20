/**
 * Whether a screen on another device shows a browser tab as its own copy or as the host's stream
 * (docs/BROWSER_AGENTS.md). The own copy is the default. The stream starts when an agent acts on the
 * page, stays while the agent drives, and ends STREAM_IDLE_MS after the last input by anyone: the
 * agent's, or the person's clicks, keys and scrolls on this screen's stream (after a Take over, say).
 * Back to my copy ends it sooner. Host files and dev servers never stream; callers check that first.
 */
export interface StreamChoice {
  stream: boolean;
  /** An agent drives the tab now. */
  agent: boolean;
  /** The last input by anyone, while no agent drives. */
  idleSince?: number;
}

export type StreamChoiceEvent =
  | { kind: 'agent'; driving: boolean; at: number }
  /** The person's input on this screen's stream. */
  | { kind: 'input'; at: number }
  | { kind: 'back' }
  | { kind: 'tick'; at: number };

/** How long after the last input by anyone the screen goes back to its own copy. */
export const STREAM_IDLE_MS = 30_000;

export function initialStreamChoice(agentDriving: boolean): StreamChoice {
  return { stream: agentDriving, agent: agentDriving };
}

export function streamChoice(state: StreamChoice, event: StreamChoiceEvent): StreamChoice {
  switch (event.kind) {
    case 'agent':
      if (event.driving === state.agent) return state;
      return event.driving ? { stream: true, agent: true } : { stream: state.stream, agent: false, idleSince: event.at };
    case 'input':
      return state.stream && !state.agent ? { ...state, idleSince: event.at } : state;
    case 'back':
      return { ...state, stream: false };
    case 'tick':
      if (!state.stream || state.agent || state.idleSince === undefined || event.at - state.idleSince < STREAM_IDLE_MS) return state;
      return { ...state, stream: false };
  }
}

/** When the next tick can change `state`, or undefined when none can. */
export function nextStreamTick(state: StreamChoice): number | undefined {
  return state.stream && !state.agent && state.idleSince !== undefined ? state.idleSince + STREAM_IDLE_MS : undefined;
}
