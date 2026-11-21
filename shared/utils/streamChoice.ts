import type { BrowserPanelState } from '../types/panels';
import { isHostLocalUrl } from './browserUrl';

/**
 * Whether a screen on another device shows a browser tab as its own copy or as the host's stream
 * (docs/BROWSER_AGENTS.md). The own copy is the default. The stream starts when an agent acts on the
 * page, stays while the agent drives, and ends STREAM_IDLE_MS after the last input by anyone: the
 * agent's, or the person's clicks, keys and scrolls on this screen's stream (after a Take over, say).
 * A page an agent typed into (`typed`), and a stream the person asked for with View live, stay until
 * Back to my copy. Back to my copy ends any stream. Host files and dev servers never stream; callers
 * check that first.
 */
export interface StreamChoice {
  stream: boolean;
  /** An agent drives the tab now. */
  agent: boolean;
  /** The host's page holds input an agent typed, which its URL doesn't. */
  typed: boolean;
  /** The person chose View live. */
  live: boolean;
  /** The last input by anyone, while no agent drives. */
  idleSince?: number;
}

export type StreamChoiceEvent =
  | { kind: 'agent'; driving: boolean; at: number }
  | { kind: 'typed'; typed: boolean; at: number }
  /** The person's input on this screen's stream. */
  | { kind: 'input'; at: number }
  | { kind: 'back' }
  | { kind: 'live' }
  | { kind: 'tick'; at: number };

/** How long after the last input by anyone the screen goes back to its own copy. */
export const STREAM_IDLE_MS = 30_000;

/** A screen opening the tab streams it when an agent drives it or typed into its page. */
export function initialStreamChoice(agentDriving: boolean, typed = false): StreamChoice {
  return { stream: agentDriving || typed, agent: agentDriving, typed, live: false };
}

export function streamChoice(state: StreamChoice, event: StreamChoiceEvent): StreamChoice {
  switch (event.kind) {
    case 'agent':
      if (event.driving === state.agent) return state;
      return event.driving ? { ...state, stream: true, agent: true, idleSince: undefined } : { ...state, agent: false, idleSince: event.at };
    case 'typed':
      if (event.typed === state.typed) return state;
      // The page left what the agent typed (it loaded a new document): the 30 s start now.
      return event.typed ? { ...state, typed: true } : { ...state, typed: false, idleSince: event.at };
    case 'input':
      return state.stream && !state.agent ? { ...state, idleSince: event.at } : state;
    case 'back':
      return { ...state, stream: false, live: false };
    case 'live':
      return { ...state, stream: true, live: true };
    case 'tick': {
      const due = nextStreamTick(state);
      return due !== undefined && event.at >= due ? { ...state, stream: false } : state;
    }
  }
}

/** When the next tick can change `state`, or undefined when none can. */
export function nextStreamTick(state: StreamChoice): number | undefined {
  if (!state.stream || state.agent || state.typed || state.live || state.idleSince === undefined) return undefined;
  return state.idleSince + STREAM_IDLE_MS;
}

/**
 * Each tab's choice on this screen, kept while its view is closed (another tab or Pane in front), so
 * Back to my copy and View live last until the next change, and tab menus can offer View live.
 * `all` is a new map after each change, for useSyncExternalStore.
 */
let choices: ReadonlyMap<string, StreamChoice> = new Map();
const listeners = new Set<() => void>();

export const streamChoices = {
  all: (): ReadonlyMap<string, StreamChoice> => choices,
  dispatch(panelId: string, event: StreamChoiceEvent, initial: () => StreamChoice): void {
    const current = choices.get(panelId) ?? initial();
    const next = streamChoice(current, event);
    if (next === current && choices.has(panelId)) return;
    choices = new Map(choices).set(panelId, next);
    for (const listener of listeners) listener();
  },
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  },
};

/** A tab's choice before this screen made one, from its state on the host. */
export function tabStreamChoice(state: BrowserPanelState | undefined): StreamChoice {
  return initialStreamChoice(state?.driver?.by === 'agent', state?.agentUse === 'typed');
}

/**
 * View live applies to a tab an agent has used while this screen shows its own copy (`choice`, from
 * streamChoices.all()); host files and dev servers never stream.
 */
export function offersViewLive(choice: StreamChoice | undefined, state: BrowserPanelState | undefined): boolean {
  if (!state?.agentUse || isHostLocalUrl(state.currentUrl)) return false;
  return !(choice ?? tabStreamChoice(state)).stream;
}

/** Shows the host's live page for the tab on this screen until Back to my copy. */
export function viewLive(panelId: string, state: BrowserPanelState | undefined): void {
  streamChoices.dispatch(panelId, { kind: 'live' }, () => tabStreamChoice(state));
}
