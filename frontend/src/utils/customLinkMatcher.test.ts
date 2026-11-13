import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { findCustomLinks } from '../../../shared/utils/customLinks';
import type { CustomLinkMatchRequest } from './customLinkMatcher';
import { CUSTOM_LINK_MATCH_TIMEOUT_MS, matchCustomLinks } from './customLinkMatcher';

const JIRA = { enabled: true, id: 'jira', label: 'Jira', pattern: 'PROJ-\\d+', urlTemplate: 'https://example.atlassian.net/browse/$0' };
const terminated: FakeWorker[] = [];

/** Answers like the real worker, except that text containing "stuck" never gets an answer, as with a pattern that backtracks forever. */
class FakeWorker extends EventTarget {
  postMessage({ id, text, links }: CustomLinkMatchRequest): void {
    if (text.includes('stuck')) return;
    queueMicrotask(() => this.dispatchEvent(new MessageEvent('message', { data: { id, matches: findCustomLinks(text, links) } })));
  }

  terminate(): void {
    terminated.push(this);
  }
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('Worker', FakeWorker);
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
  expect(terminated).toHaveLength(1);
  expect(await queued).toEqual({
    matches: [{ end: 10, start: 4, text: 'PROJ-2', url: 'https://example.atlassian.net/browse/PROJ-2' }],
    timedOut: false,
  });
});
