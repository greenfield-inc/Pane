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
const connectionListeners: Array<(state: { status: string }) => void> = [];
const remoteDaemon = {
  getConnectionState: vi.fn(async () => ({ success: true, data: { status: 'restoring' } })),
  onConnectionStateChanged: vi.fn((listener: (state: { status: string }) => void) => { connectionListeners.push(listener); return () => undefined; }),
};

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
  vi.stubGlobal('window', { electronAPI: { orchestrationSessions: { peek, open }, uiState: { getPaneLayout }, remoteDaemon } });
  return import('./sessionViewCache');
}

beforeEach(() => {
  vi.clearAllMocks();
  connectionListeners.length = 0;
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

  it('a Session opened while the window\'s host is still restoring shows from a peek, and opens once the host is connected (T-116 D-20)', async () => {
    const cache = await setup();
    open.mockRejectedValueOnce(new Error("Error invoking remote method 'daemon:invoke': Error [ERR_REMOTE_OFFLINE]: Remote connection interrupted: the action was not sent while the workspace is disconnected."));
    open.mockResolvedValueOnce(result('a'));
    peek.mockResolvedValueOnce(result('a'));

    const opening = cache.openSessionView({ sessionId: 'a', internalSessionId: 'internal-a', hostId: 'build' });
    await vi.waitFor(() => expect(cache.cachedSessionView('a')?.opened).toBe(false));
    expect(open).toHaveBeenCalledTimes(1);
    expect(cache.isOpening('a')).toBe(true);

    for (const listener of connectionListeners) listener({ status: 'connected' });
    await opening;
    expect(open).toHaveBeenCalledTimes(2);
    expect(cache.cachedSessionView('a')?.opened).toBe(true);
  });

  it('opens with the selection saved, and the open replaces a peeked entry', async () => {
    const cache = await setup();
    peek.mockResolvedValueOnce(result('a'));
    await cache.peekSessionView(target('a'));
    open.mockResolvedValueOnce(result('a'));
    await cache.openSessionView(target('a'), { select: true });
    expect(open).toHaveBeenCalledWith({ sessionId: 'a' }, { select: true, resume: true });
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

  it('holds nothing for a Session with nothing to show yet, and peeks it again next time', async () => {
    const cache = await setup();
    peek.mockResolvedValue({ success: true, data: { view: null, panels: [], layout: null } });
    expect(await cache.peekSessionView(target('a'))).toBeNull();
    expect(await cache.peekSessionView(target('a'))).toBeNull();
    expect(peek).toHaveBeenCalledTimes(2);
    expect(cache.cachedSessionView('a')).toBeUndefined();
  });

  it('a peek answering after an open never replaces what the open read', async () => {
    const cache = await setup();
    const peeked = deferred<ReturnType<typeof result>>();
    peek.mockReturnValueOnce(peeked.promise);
    const peeking = cache.peekSessionView(target('a'));
    open.mockResolvedValueOnce(result('a'));
    await cache.openSessionView(target('a'), { select: true });
    peeked.resolve(result('a'));
    await peeking;
    expect(cache.cachedSessionView('a')?.opened).toBe(true);
  });

  it('an older open answering last never replaces a newer one', async () => {
    const cache = await setup();
    const older = deferred<ReturnType<typeof result>>();
    open.mockReturnValueOnce(older.promise);
    const first = cache.openSessionView(target('a'), { select: true });
    const newer = result('a');
    newer.data.layout = { version: 1, root: { type: 'group', id: 'g', panelIds: [], activePanelId: null }, focusedGroupId: 'g' };
    open.mockResolvedValueOnce(newer);
    await cache.openSessionView(target('a'), { select: true });
    older.resolve(result('a'));
    await first;
    expect(cache.cachedSessionView('a')?.layout).toEqual(newer.data.layout);
  });

  it('passes an implicit settle on as a read that does not resume a paused chat', async () => {
    const cache = await setup();
    open.mockResolvedValueOnce(result('a'));
    await cache.openSessionView(target('a'), { select: true, resume: false });
    expect(open).toHaveBeenCalledWith({ sessionId: 'a' }, { select: true, resume: false });
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
