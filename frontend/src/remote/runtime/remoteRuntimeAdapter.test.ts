import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { JsonValue } from '../../../../shared/validation/boundaryDecoder';
import { RemoteRuntimeAdapter } from './remoteRuntimeAdapter';

const adapter = () => new RemoteRuntimeAdapter({ id: 'host', label: 'Host', baseUrl: 'https://host.test', token: 'test-token', transport: 'http+sse' });
const panel = { id: 'p1', sessionId: 's1', type: 'terminal', title: 'Shell', state: { isActive: true }, metadata: { createdAt: '2026-01-01', lastActiveAt: '2026-01-01', position: 0 } };
function respond(result: JsonValue) {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ ok: true, result }), { status: 200 })));
}
beforeEach(() => {
  vi.stubGlobal('window', { localStorage: { getItem: () => 'runtime', setItem: () => {} } });
  vi.stubGlobal('navigator', { platform: 'test' });
});
afterEach(() => vi.unstubAllGlobals());

it('accepts valid raw and IPC-wrapped panels and surfaces host failures', async () => {
  respond([panel]);
  expect(await adapter().getPanels('s1')).toEqual([panel]);
  respond({ success: true, data: panel });
  expect(await adapter().getActivePanel('s1')).toEqual(panel);
  respond({ success: false, error: 'Panel unavailable' });
  await expect(adapter().getPanels('s1')).rejects.toThrow('Panel unavailable');
});

it('rejects malformed panel state before returning it to a caller', async () => {
  respond({ success: true, data: [{ ...panel, state: { isActive: 'yes' } }] });
  await expect(adapter().getPanels('s1')).rejects.toThrow(/isActive/);
});

it('rejects non-boolean initialization and malformed branch listings', async () => {
  respond('false');
  await expect(adapter().checkPanelInitialized('p1')).rejects.toThrow(/boolean/);
  respond([{ name: 'main', isCurrent: 'true', hasWorktree: false, isRemote: false }]);
  await expect(adapter().listProjectBranches(1)).rejects.toThrow(/isCurrent/);
});

it('validates terminal write acknowledgements and streaming credentials', async () => {
  respond({ success: true });
  await expect(adapter().sendTerminalInput('p1', 'pwd\n')).resolves.toBeUndefined();
  respond({ success: true, data: { unexpected: 'payload' } });
  await expect(adapter().sendTerminalInput('p1', 'pwd\n')).rejects.toThrow();
  respond({ accessToken: 'token', expiresIn: 'never', expiresAt: 42 });
  await expect(adapter().getDeepgramStreamingToken()).rejects.toThrow(/expiresIn/);
});

it('normalizes nullable host session metadata for the renderer', async () => {
  respond({ success: true, data: {
    id: 's1', name: 'Host pane', worktreePath: '/tmp/host', prompt: '', status: 'stopped', createdAt: '2026-01-01', output: [], jsonMessages: [],
    statusMessage: null, pid: null, lastViewedAt: null, folderId: null, runStartedAt: null, baseCommit: null, baseBranch: null, favoritePinnedAt: null, isMainRepo: 0, isFavorite: 1, archived: 0, isHidden: 0, isRunning: 0,
  } });
  const session = await adapter().getSession('s1');
  expect(session.name).toBe('Host pane');
  expect(session.pid).toBeUndefined();
  expect(session.baseBranch).toBeUndefined();
  expect(session.isMainRepo).toBe(false);
  expect(session.isFavorite).toBe(true);
  expect(session.archived).toBe(false);
});

it('accepts SQLite boolean project fields from the host list endpoint', async () => {
  respond({ success: true, data: [{ id: 1, name: 'Repo', path: '/repo', active: 1, wsl_enabled: 0, created_at: '2026-01-01', updated_at: '2026-01-01', sessions: [] }] });
  const [project] = await adapter().getProjectsWithSessions();
  expect(project.active).toBe(true);
  expect(project.wsl_enabled).toBe(false);
});
