import type { CustomLink } from '../../../shared/types/customLinks';
import type { CustomLinkMatch } from '../../../shared/utils/customLinks';
import MatcherWorker from './customLinkMatcher.worker?worker&inline';

/** How long one line may take to match before the patterns are stopped and the line gets no links. */
export const CUSTOM_LINK_MATCH_TIMEOUT_MS = 250;

export interface CustomLinkMatchRequest {
  id: number;
  text: string;
  links: readonly CustomLink[];
}

export interface CustomLinkMatchResult {
  matches: CustomLinkMatch[];
  /** The patterns took longer than CUSTOM_LINK_MATCH_TIMEOUT_MS on this line and were stopped. */
  timedOut: boolean;
}

interface CustomLinkMatchResponse {
  id: number;
  matches: CustomLinkMatch[];
}

interface QueuedMatch {
  request: CustomLinkMatchRequest;
  resolve: (result: CustomLinkMatchResult) => void;
  signal?: AbortSignal;
}

const NO_LINKS: CustomLinkMatchResult = { matches: [], timedOut: false };

let worker: Worker | null = null;
let nextId = 0;
/** The line the worker is matching now; only it has a timer running. */
let running: (QueuedMatch & { timer: ReturnType<typeof setTimeout> }) | null = null;
const queue: QueuedMatch[] = [];

function finishRunning(result: CustomLinkMatchResult): void {
  if (!running) return;
  clearTimeout(running.timer);
  const { resolve } = running;
  running = null;
  resolve(result);
  sendNext();
}

/** Sends the next line nobody gave up on, starting its timer only now that the worker is free. */
function sendNext(): void {
  if (running) return;
  let next = queue.shift();
  while (next?.signal?.aborted) {
    next.resolve(NO_LINKS);
    next = queue.shift();
  }
  if (!next) return;
  if (!worker) {
    worker = new MatcherWorker();
    worker.addEventListener('message', (event: MessageEvent<CustomLinkMatchResponse>) => {
      if (event.data.id === running?.request.id) finishRunning({ matches: event.data.matches, timedOut: false });
    });
  }
  running = { ...next, timer: setTimeout(stopRunning, CUSTOM_LINK_MATCH_TIMEOUT_MS) };
  worker.postMessage(next.request);
}

/** Stops the worker stuck on the running line, which gets no links; the next line goes to a fresh worker. */
function stopRunning(): void {
  worker?.terminate();
  worker = null;
  finishRunning({ matches: [], timedOut: true });
}

/**
 * The custom links in one line of text, matched in a worker so a pattern that backtracks
 * forever stops after CUSTOM_LINK_MATCH_TIMEOUT_MS instead of freezing the window. Lines are
 * matched one at a time; aborting `signal` drops a line that is still waiting its turn.
 */
export function matchCustomLinks(text: string, links: readonly CustomLink[], signal?: AbortSignal): Promise<CustomLinkMatchResult> {
  if (!text || !links.some((link) => link.enabled)) {
    return Promise.resolve(NO_LINKS);
  }
  return new Promise((resolve) => {
    queue.push({ request: { id: nextId++, text, links }, resolve, signal });
    sendNext();
  });
}
