import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { OrchestrationSessionOpenResult, OrchestrationSessionView } from '../../../shared/types/orchestrationSession';
import type { Session } from '../types/session';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { resolve, promise };
}

const peek = vi.fn();
const open = vi.fn();
const getPaneLayout = vi.fn();

function result(sessionId: string, panelType: 'chat' | 'terminal' = 'chat') {
  // SAFETY: the cache reads only these fields of the view; no record content is rendered.
  const view = {
    session: { id: sessionId, revision: 1 },
    internalSession: { id: `internal-${sessionId}` },
    panel: { id: `panel-${sessionId}`, type: panelType },
    agent: 'claude',
  } as OrchestrationSessionView<Session>;
  const data: OrchestrationSessionOpenResult<Session> = { view, panels: [], layout: null };
  return { success: true, data };
}

const target = (sessionId: string) => ({ sessionId, internalSessionId: `internal-${sessionId}`, hostId: null });

async function setup() {
  vi.resetModules();
  vi.stubGlobal('window', { electronAPI: { orchestrationSessions: { peek, open }, uiState: { getPaneLayout } } });
  return import('./sessionViewCache');
}

beforeEach(() => {
  vi.clearAllMocks();
  getPaneLayout.mockResolvedValue({ success: true, data: null });
});

describe('Session view cache (T-87)', () => {
  it('peeks a Session once, and not at all once it is held', async () => {
    const cache = await setup();
    const reply = deferred<ReturnType<typeof result>>();
    peek.mockReturnValueOnce(reply.promise);
    const first = cache.peekSessionView(target('a'));
    const second = cache.peekSessionView(target('a'));
    expect(peek).toHaveBeenCalledTimes(1);
    reply.resolve(result('a'));
    await Promise.all([first, second]);
    expect(cache.cachedSessionView('a')?.opened).toBe(false);
    await cache.peekSessionView(target('a'));
    expect(peek).toHaveBeenCalledTimes(1);
  });

  it('opens with the selection saved, and the open replaces a peeked entry', async () => {
    const cache = await setup();
    peek.mockResolvedValueOnce(result('a'));
    await cache.peekSessionView(target('a'));
    open.mockResolvedValueOnce(result('a'));
    await cache.openSessionView(target('a'), { select: true });
    expect(open).toHaveBeenCalledWith({ sessionId: 'a' }, { select: true });
    expect(cache.cachedSessionView('a')?.opened).toBe(true);
  });

  it('shares an open in flight with a peek of the same Session', async () => {
    const cache = await setup();
    const reply = deferred<ReturnType<typeof result>>();
    open.mockReturnValueOnce(reply.promise);
    const opening = cache.openSessionView(target('a'));
    const peeking = cache.peekSessionView(target('a'));
    reply.resolve(result('a'));
    await opening;
    expect((await peeking)?.opened).toBe(true);
    expect(peek).not.toHaveBeenCalled();
  });

  it('drops replies that arrive after the window switched machine', async () => {
    const cache = await setup();
    const reply = deferred<ReturnType<typeof result>>();
    peek.mockReturnValueOnce(reply.promise);
    const peeking = cache.peekSessionView(target('a'));
    cache.clearSessionViewCache();
    reply.resolve(result('a'));
    await peeking;
    expect(cache.cachedSessionView('a')).toBeUndefined();
  });

  it('remembers a Session with nothing to show yet', async () => {
    const cache = await setup();
    peek.mockResolvedValueOnce({ success: true, data: { view: null, panels: [], layout: null } });
    expect(await cache.peekSessionView(target('a'))).toBeNull();
    expect(cache.useSessionViewCache.getState().unpeekable.a).toBe(true);
  });

  it('keeps the desktop layout it already holds instead of reading it again', async () => {
    const cache = await setup();
    const remembered = { version: 1 };
    getPaneLayout.mockResolvedValueOnce({ success: true, data: remembered });
    peek.mockResolvedValueOnce(result('a'));
    await cache.peekSessionView(target('a'));
    open.mockResolvedValueOnce(result('a'));
    await cache.openSessionView(target('a'));
    expect(getPaneLayout).toHaveBeenCalledTimes(1);
    expect(cache.cachedSessionView('a')?.remembered).toBe(remembered);
  });
});
