import type { CustomLink } from '../../../shared/types/customLinks';
import type { CustomLinkMatch } from '../../../shared/utils/customLinks';
import MatcherWorker from './customLinkMatcher.worker?worker&inline';

/**
 * How long one line may take to match before the patterns are stopped and the line gets no links.
 * It counts from when the worker has loaded, so a slow worker start-up never costs a line its links.
 */
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

/** The worker's first message: its code has loaded and it is ready to match. */
export interface CustomLinkWorkerReady {
  ready: true;
}

interface QueuedMatch {
  request: CustomLinkMatchRequest;
  resolve: (result: CustomLinkMatchResult) => void;
  signal?: AbortSignal;
}

const NO_LINKS: CustomLinkMatchResult = { matches: [], timedOut: false };

let worker: Worker | null = null;
/** The worker has said it loaded; until then the running line waits without a timer. */
let workerReady = false;
let nextId = 0;
/** The line the worker is matching now; only it has a timer, started once it reaches a loaded worker. */
let running: (QueuedMatch & { timer?: ReturnType<typeof setTimeout> }) | null = null;
const queue: QueuedMatch[] = [];

function finishRunning(result: CustomLinkMatchResult): void {
  if (!running) return;
  clearTimeout(running.timer);
  const { resolve } = running;
  running = null;
  resolve(result);
  sendNext();
}

/** Sends the next line nobody gave up on, starting its timer only once the worker is free and loaded. */
function sendNext(): void {
  if (running) return;
  let next = queue.shift();
  while (next?.signal?.aborted) {
    next.resolve(NO_LINKS);
    next = queue.shift();
  }
  if (!next) return;
  running = { ...next };
  if (!worker) startWorker();
  else if (workerReady) postRunning();
}

function startWorker(): void {
  workerReady = false;
  worker = new MatcherWorker();
  worker.addEventListener('message', (event: MessageEvent<CustomLinkMatchResponse | CustomLinkWorkerReady>) => {
    if ('ready' in event.data) {
      workerReady = true;
      postRunning();
    } else if (event.data.id === running?.request.id) {
      finishRunning({ matches: event.data.matches, timedOut: false });
    }
  });
  // A worker that fails to load would never say it is ready; stop it so the lines behind it still run.
  worker.addEventListener('error', stopRunning);
}

function postRunning(): void {
  if (!running || !worker) return;
  running.timer = setTimeout(stopRunning, CUSTOM_LINK_MATCH_TIMEOUT_MS);
  worker.postMessage(running.request);
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
