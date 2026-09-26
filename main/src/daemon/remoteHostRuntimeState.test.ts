import { beforeEach, expect, it, vi } from 'vitest';
import { DEFAULT_REMOTE_DAEMON_HOST_CONFIG, type RemoteDaemonExecutableHealth } from '../../../shared/types/remoteDaemon';
import { RemoteHostRuntimeStateStore } from './remoteHostRuntimeState';

const collectHealth = vi.fn<() => Promise<RemoteDaemonExecutableHealth>>();
let store: RemoteHostRuntimeStateStore;

const health: RemoteDaemonExecutableHealth = {
  processImage: { status: 'current', runtimePath: '/opt/pane', installedPath: '/opt/pane', evidence: 'fixture' },
  restart: { status: 'ready', launcherPath: '/tmp/pane/start.sh', resolvedPath: '/opt/pane', evidence: 'fixture' },
  checkedAt: '2026-01-01T00:00:00.000Z',
};

beforeEach(async () => {
  collectHealth.mockResolvedValue(health);
  store = new RemoteHostRuntimeStateStore(collectHealth);
  await store.refreshExecutableHealth();
});

it('keeps executable health stable while clients heartbeat until an explicit refresh', async () => {
  store.setLive({ ...DEFAULT_REMOTE_DAEMON_HOST_CONFIG, enabled: true });
  const changed = { ...health, checkedAt: '2026-01-02T00:00:00.000Z' };
  collectHealth.mockResolvedValue(changed);
  store.setConnectedClients([]);
  expect(store.getState().executableHealth).toEqual(health);
  expect((await store.refreshExecutableHealth()).executableHealth).toEqual(changed);
});

it('publishes startup health asynchronously without replacing newer live state', async () => {
  let finish!: (value: RemoteDaemonExecutableHealth) => void;
  const pending = new Promise<RemoteDaemonExecutableHealth>(resolve => { finish = resolve; });
  const startupStore = new RemoteHostRuntimeStateStore(() => pending);
  const updates: Array<ReturnType<typeof startupStore.getState>> = [];
  startupStore.on('state-changed', state => updates.push(state));
  startupStore.setInactive();
  startupStore.setLive({ ...DEFAULT_REMOTE_DAEMON_HOST_CONFIG, enabled: true });
  expect(startupStore.getState().status).toBe('live');
  finish(health);
  await new Promise<void>(resolve => setImmediate(resolve));
  expect(startupStore.getState().executableHealth).toEqual(health);
  expect(updates.at(-1)).toMatchObject({ status: 'live', executableHealth: health });
});
