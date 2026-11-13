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

interface PendingMatch {
  request: CustomLinkMatchRequest;
  resolve: (result: CustomLinkMatchResult) => void;
  timer: ReturnType<typeof setTimeout>;
}

let worker: Worker | null = null;
let nextId = 0;
/** In the order sent; the worker answers in the same order, so the first one is the line it is working on. */
const pending = new Map<number, PendingMatch>();

function settle(id: number, result: CustomLinkMatchResult): void {
  const entry = pending.get(id);
  if (!entry) return;
  clearTimeout(entry.timer);
  pending.delete(id);
  entry.resolve(result);
}

function send(request: CustomLinkMatchRequest, resolve: PendingMatch['resolve']): void {
  if (!worker) {
    worker = new MatcherWorker();
    worker.addEventListener('message', (event: MessageEvent<CustomLinkMatchResponse>) => {
      settle(event.data.id, { matches: event.data.matches, timedOut: false });
    });
  }
  pending.set(request.id, { request, resolve, timer: setTimeout(() => stopStuckLine(request.id), CUSTOM_LINK_MATCH_TIMEOUT_MS) });
  worker.postMessage(request);
}

/** Stops the worker stuck on `id`'s line, which gets no links, and sends the lines queued behind it to a fresh worker. */
function stopStuckLine(id: number): void {
  worker?.terminate();
  worker = null;
  settle(id, { matches: [], timedOut: true });
  const queued = [...pending.values()];
  pending.clear();
  for (const { request, resolve, timer } of queued) {
    clearTimeout(timer);
    send(request, resolve);
  }
}

/**
 * The custom links in one line of text, matched in a worker so a pattern that backtracks
 * forever stops after CUSTOM_LINK_MATCH_TIMEOUT_MS instead of freezing the window.
 */
export function matchCustomLinks(text: string, links: readonly CustomLink[]): Promise<CustomLinkMatchResult> {
  if (!text || !links.some((link) => link.enabled)) {
    return Promise.resolve({ matches: [], timedOut: false });
  }
  return new Promise((resolve) => send({ id: nextId++, text, links }, resolve));
}
