import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { findCustomLinks } from '../../../shared/utils/customLinks';
import type { CustomLinkMatchRequest } from './customLinkMatcher';
import { CUSTOM_LINK_MATCH_TIMEOUT_MS, CUSTOM_LINK_WORKER_STARTUP_TIMEOUT_MS } from './customLinkMatcher';

const JIRA = { enabled: true, id: 'jira', label: 'Jira', pattern: 'PROJ-\\d+', urlTemplate: 'https://example.atlassian.net/browse/$0' };
const SLOW_LINE_MS = CUSTOM_LINK_MATCH_TIMEOUT_MS - 50;
let posted: string[] = [];
let terminated = 0;
let startupMs = 0;
/** How each next worker starts: it loads, never loads, or fails to load. Workers past the list load. */
let startups: Array<'load' | 'hang' | 'error'> = [];
// Loaded fresh for each test, so each starts with no worker, as the window does.
let matchCustomLinks: typeof import('./customLinkMatcher').matchCustomLinks;

/**
 * Answers like the real worker, one line at a time. Like a real worker it takes startupMs to load,
 * holds lines posted before then, and says when it has loaded (unless `startups` says it hangs or
 * fails to load). Text containing "stuck" never gets
 * an answer, as with a pattern that backtracks forever; text containing "slow" takes SLOW_LINE_MS.
 */
class FakeWorker extends EventTarget {
  private loaded = false;
  private held: CustomLinkMatchRequest[] = [];

  constructor() {
    super();
    const load = () => {
      this.loaded = true;
      this.dispatchEvent(new MessageEvent('message', { data: { ready: true } }));
      for (const request of this.held.splice(0)) this.answer(request);
    };
    const startup = startups.shift() ?? 'load';
    if (startup === 'hang') return;
    if (startup === 'error') queueMicrotask(() => this.dispatchEvent(new Event('error')));
    else if (startupMs > 0) setTimeout(load, startupMs);
    else queueMicrotask(load);
  }

  postMessage(request: CustomLinkMatchRequest): void {
    posted.push(request.text);
    if (this.loaded) this.answer(request);
    else this.held.push(request);
  }

  private answer({ id, text, links }: CustomLinkMatchRequest): void {
    if (text.includes('stuck')) return;
    const reply = () => this.dispatchEvent(new MessageEvent('message', { data: { id, matches: findCustomLinks(text, links) } }));
    if (text.includes('slow')) setTimeout(reply, SLOW_LINE_MS);
    else queueMicrotask(reply);
  }

  terminate(): void {
    terminated++;
  }
}

const proj = (n: number, start: number) => ({ start, end: start + `PROJ-${n}`.length, text: `PROJ-${n}`, url: `https://example.atlassian.net/browse/PROJ-${n}` });

beforeEach(async () => {
  vi.resetModules();
  ({ matchCustomLinks } = await import('./customLinkMatcher'));
  vi.useFakeTimers();
  vi.stubGlobal('Worker', FakeWorker);
  posted = [];
  terminated = 0;
  startupMs = 0;
  startups = [];
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it('stops a line that never finishes matching, and still links the line queued behind it', async () => {
  const stuck = matchCustomLinks('stuck on PROJ-1', [JIRA]);
  const queued = matchCustomLinks('see PROJ-2', [JIRA]);
  await vi.advanceTimersByTimeAsync(CUSTOM_LINK_MATCH_TIMEOUT_MS);

  expect(await stuck).toEqual({ matches: [], timedOut: true });
  expect(terminated).toBe(1);
  expect(await queued).toEqual({ matches: [proj(2, 4)], timedOut: false });
});

it('gives each line its full time once the worker starts on it', async () => {
  const slow = matchCustomLinks('slow PROJ-3', [JIRA]);
  const next = matchCustomLinks('slow PROJ-4', [JIRA]);
  await vi.advanceTimersByTimeAsync(2 * SLOW_LINE_MS);

  expect(await slow).toEqual({ matches: [proj(3, 5)], timedOut: false });
  expect(await next).toEqual({ matches: [proj(4, 5)], timedOut: false });
  expect(terminated).toBe(0);
});

it('drops a waiting line whose request was aborted without matching it', async () => {
  const left = new AbortController();
  const running = matchCustomLinks('slow PROJ-5', [JIRA]);
  const dropped = matchCustomLinks('see PROJ-6', [JIRA], left.signal);
  const current = matchCustomLinks('see PROJ-7', [JIRA]);
  left.abort();
  await vi.advanceTimersByTimeAsync(SLOW_LINE_MS);

  await Promise.all([running, dropped, current]);
  expect(posted).toEqual(['slow PROJ-5', 'see PROJ-7']);
  expect(await current).toEqual({ matches: [proj(7, 4)], timedOut: false });
});

it('starts timing a line only once the worker has loaded, so a slow start-up does not cost it its links', async () => {
  startupMs = 2 * CUSTOM_LINK_MATCH_TIMEOUT_MS;
  const first = matchCustomLinks('see PROJ-8', [JIRA]);
  await vi.advanceTimersByTimeAsync(startupMs);

  expect(await first).toEqual({ matches: [proj(8, 4)], timedOut: false });
  expect(terminated).toBe(0);
});

it('stops a worker that never loads after the start-up limit, and links the next line on a fresh one', async () => {
  startups = ['hang'];
  const first = matchCustomLinks('see PROJ-9', [JIRA]);
  const next = matchCustomLinks('see PROJ-10', [JIRA]);
  await vi.advanceTimersByTimeAsync(CUSTOM_LINK_WORKER_STARTUP_TIMEOUT_MS - 1);
  expect(terminated).toBe(0);
  await vi.advanceTimersByTimeAsync(1);

  expect(await first).toEqual({ matches: [], timedOut: true });
  expect(terminated).toBe(1);
  expect(await next).toEqual({ matches: [proj(10, 4)], timedOut: false });
});

it('stops a worker that fails to load, and links the next line on a fresh one', async () => {
  startups = ['error'];
  const first = matchCustomLinks('see PROJ-11', [JIRA]);
  const next = matchCustomLinks('see PROJ-12', [JIRA]);
  await vi.advanceTimersByTimeAsync(0);

  expect(await first).toEqual({ matches: [], timedOut: true });
  expect(terminated).toBe(1);
  expect(await next).toEqual({ matches: [proj(12, 4)], timedOut: false });
});

it('does not stop a loaded worker when its start-up limit would have passed', async () => {
  const first = matchCustomLinks('see PROJ-13', [JIRA]);
  await vi.advanceTimersByTimeAsync(0);
  expect(await first).toEqual({ matches: [proj(13, 4)], timedOut: false });
  const later = matchCustomLinks('slow PROJ-14', [JIRA]);
  await vi.advanceTimersByTimeAsync(CUSTOM_LINK_WORKER_STARTUP_TIMEOUT_MS);

  expect(await later).toEqual({ matches: [proj(14, 5)], timedOut: false });
  expect(terminated).toBe(0);
});
