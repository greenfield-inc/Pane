import { generateKeyPairSync } from 'crypto';
import { connect, constants, createServer, type ClientHttp2Session, type ServerHttp2Session, type ServerHttp2Stream } from 'http2';
import { mkdtemp, rm, writeFile } from 'fs/promises';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDefaultRemoteDaemonConfig, type RemoteDaemonConfig } from '../../../shared/types/remoteDaemon';
import { createProviderTransport, MobilePushSender, type MobilePushTransport } from './mobilePushSender';
import { decodeRemoteConnectionCode } from '../../../frontend/src/remote/runtime/remoteProfile';
import { encodePaneRemoteConnection } from '../../../shared/types/remoteDaemon';
import { ConfigManager } from '../services/configManager';
import { boundary, decodeBoundary } from '../../../shared/validation/boundaryDecoder';

const originalEnvironment = {
  team: process.env.PANE_APNS_TEAM_ID,
  key: process.env.PANE_APNS_KEY_ID,
  keyPath: process.env.PANE_APNS_KEY_PATH,
  topic: process.env.PANE_APNS_TOPIC,
  environment: process.env.PANE_APNS_ENVIRONMENT,
  fcmPath: process.env.PANE_FCM_SERVICE_ACCOUNT_PATH,
};
const temporaryDirectories: string[] = [];

afterEach(async () => {
  setEnvironment(originalEnvironment);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

describe('MobilePushSender', () => {
  it('reuses APNs authentication across notifications and refreshes it before one hour', async () => {
    await configureApns();
    const manager = new ConfigManagerStub(registeredHost());
    const apns = vi.fn(async () => ({ status: 200, body: '' }));
    const transport: MobilePushTransport = { apns, fcm: async () => ({ status: 200, body: '' }) };
    const sender = new MobilePushSender(manager, transport);
    await sender.register('client-1', { platform: 'ios', token: 'token', installationId: 'install', hostProfileId: 'profile' });
    const now = vi.spyOn(Date, 'now').mockReturnValue(Date.UTC(2026, 0, 1));
    await sender.observeStatus({ sessionId: 'pane', panelId: 'first', state: 'blocked', reason: null });
    now.mockReturnValue(Date.UTC(2026, 0, 1, 0, 19));
    await sender.observeStatus({ sessionId: 'pane', panelId: 'second', state: 'blocked', reason: null });
    now.mockReturnValue(Date.UTC(2026, 0, 1, 0, 51));
    await sender.observeStatus({ sessionId: 'pane', panelId: 'third', state: 'blocked', reason: null });
    const requests = vi.mocked(transport.apns).mock.calls;
    expect(requests).toHaveLength(3);
    expect(requests[1][0].jwt).toBe(requests[0][0].jwt);
    expect(requests[2][0].jwt).not.toBe(requests[0][0].jwt);
  });

  it('reuses an FCM access token until expiry and exchanges again after credential rotation', async () => {
    await configureFcm();
    const manager = new ConfigManagerStub(registeredHost());
    const transport: MobilePushTransport = { apns: async () => ({ status: 200, body: '' }), fcm: vi.fn(async () => ({ status: 200, body: '' })) };
    const exchange = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: 'first', expires_in: 3600 })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: 'renewed', expires_in: 3600 })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: 'rotated', expires_in: 3600 })));
    vi.stubGlobal('fetch', exchange);
    const sender = new MobilePushSender(manager, transport);
    await sender.register('client-1', { platform: 'android', token: 'phone', installationId: 'install', hostProfileId: 'profile' });
    const now = vi.spyOn(Date, 'now').mockReturnValue(Date.UTC(2026, 0, 1));
    await sender.observeStatus({ sessionId: 'pane', panelId: 'first', state: 'blocked', reason: null });
    now.mockReturnValue(Date.UTC(2026, 0, 1, 0, 10));
    await sender.observeStatus({ sessionId: 'pane', panelId: 'second', state: 'blocked', reason: null });
    now.mockReturnValue(Date.UTC(2026, 0, 1, 1, 1));
    await sender.observeStatus({ sessionId: 'pane', panelId: 'third', state: 'blocked', reason: null });
    await configureFcm();
    await sender.observeStatus({ sessionId: 'pane', panelId: 'fourth', state: 'blocked', reason: null });
    expect(vi.mocked(transport.fcm).mock.calls.map(([request]) => request.accessToken)).toEqual(['first', 'first', 'renewed', 'rotated']);
    expect(exchange).toHaveBeenCalledTimes(3);
  });

  it('shares an OAuth exchange across notifications and honors revocation while it is pending', async () => {
    await configureFcm();
    let finishExchange = () => {};
    const response = new Promise<Response>(resolve => {
      finishExchange = () => resolve(new Response(JSON.stringify({ access_token: 'shared', expires_in: 3600 })));
    });
    const exchange = vi.fn(() => response);
    vi.stubGlobal('fetch', exchange);
    const transport: MobilePushTransport = { apns: async () => ({ status: 200, body: '' }), fcm: vi.fn(async () => ({ status: 200, body: '' })) };
    const sender = new MobilePushSender(new ConfigManagerStub(registeredHost()), transport);
    await sender.register('client-1', { platform: 'android', token: 'revoked', installationId: 'old', hostProfileId: 'profile' });
    await sender.register('client-1', { platform: 'android', token: 'active', installationId: 'current', hostProfileId: 'profile' });
    const deliveries = ['one', 'two'].map(panelId => sender.observeStatus({ sessionId: 'pane', panelId, state: 'blocked', reason: null }));
    try {
      await expect.poll(() => exchange.mock.calls.length).toBe(1);
      await sender.revoke('client-1', 'android', 'old');
    } finally {
      finishExchange();
      await Promise.all(deliveries);
    }
    expect(exchange).toHaveBeenCalledTimes(1);
    expect(vi.mocked(transport.fcm).mock.calls.map(([request]) => request.token)).toEqual(['active', 'active']);
  });

  it('keeps ordinary panel activity in memory without rewriting registered hosts', async () => {
    await configureApns();
    const manager = new ConfigManagerStub(registeredHost());
    const sender = new MobilePushSender(manager);
    await sender.register('client-1', { platform: 'ios', token: 'token', installationId: 'install', hostProfileId: 'profile' });
    const write = vi.spyOn(manager, 'updateConfigWith');
    for (const state of ['working', 'unknown', 'idle', 'working'] as const) {
      await sender.observeStatus({ sessionId: 'pane', panelId: 'panel', state, reason: null });
    }
    expect(write).not.toHaveBeenCalled();
    expect(manager.config.host.mobilePush.panelStates).toEqual({});
    await sender.updateControls('client-1', 'ios', 'install', { needsInputEnabled: false, completedEnabled: false });
    write.mockClear();
    for (const state of ['blocked', 'working', 'idle'] as const) {
      await sender.observeStatus({ sessionId: 'pane', panelId: 'panel', state, reason: null });
    }
    expect(write).not.toHaveBeenCalled();
  });

  it('lets a phone rotate its token during delivery without revoking the replacement on a late rejection', async () => {
    await configureApns();
    let finishDelivery = () => {};
    const response = new Promise<{ status: number; body: string }>(resolve => {
      finishDelivery = () => resolve({ status: 410, body: 'Unregistered' });
    });
    let deliveryStarted = () => {};
    const started = new Promise<void>(resolve => { deliveryStarted = resolve; });
    const sender = new MobilePushSender(new ConfigManagerStub(registeredHost()), {
      apns: () => { deliveryStarted(); return response; }, fcm: async () => ({ status: 200, body: '' }),
    });
    const request = { platform: 'ios' as const, token: 'old', installationId: 'install', hostProfileId: 'profile' };
    await sender.register('client-1', request);
    const sending = sender.observeStatus({ sessionId: 'pane', panelId: 'panel', state: 'blocked', reason: null });
    await started;
    let rotated = false;
    const rotation = sender.register('client-1', { ...request, token: 'replacement' }).then(() => { rotated = true; });
    try {
      await expect.poll(() => rotated, { timeout: 200 }).toBe(true);
    } finally {
      finishDelivery();
      await Promise.all([sending, rotation]);
    }
    expect(sender.getStatus('client-1', 'ios', 'install').registration).toBe('registered');
  });

  it('reuses APNs sessions by environment and replaces a connection after GOAWAY or error', async () => {
    await configureApns();
    const server = createServer();
    const serverSessions: ServerHttp2Session[] = [];
    const heldStreams: ServerHttp2Stream[] = [];
    let holdResponses = false;
    server.on('session', session => { serverSessions.push(session); session.on('error', () => {}); });
    server.on('stream', stream => {
      stream.on('error', () => {});
      stream.resume();
      stream.on('end', () => {
        if (holdResponses) heldStreams.push(stream);
        else { stream.respond({ ':status': 200 }); stream.end(); }
      });
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = decodeBoundary(server.address(), boundary.object({ port: boundary.number }));
    const clients: ClientHttp2Session[] = [];
    const hosts: string[] = [];
    const transport = createProviderTransport(host => {
      hosts.push(host);
      const client = connect(`http://127.0.0.1:${address.port}`);
      clients.push(client);
      return client;
    });
    const manager = new ConfigManagerStub(registeredHost());
    const sender = new MobilePushSender(manager, transport);
    try {
      await sender.register('client-1', { platform: 'ios', token: 'phone', installationId: 'install', hostProfileId: 'profile' });
      const notify = (panelId: string) => sender.observeStatus({ sessionId: 'pane', panelId, state: 'blocked', reason: null });
      await notify('one');
      await notify('two');
      expect(clients).toHaveLength(1);
      expect(clients[0].destroyed).toBe(false);
      const goaway = new Promise<void>(resolve => clients[0].once('goaway', () => resolve()));
      serverSessions[0].goaway();
      await goaway;
      await notify('three');
      expect(clients).toHaveLength(2);
      setEnvironmentValue('PANE_APNS_ENVIRONMENT', 'production');
      await notify('four');
      expect(hosts[2]).toBe('https://api.push.apple.com');
      setEnvironmentValue('PANE_APNS_ENVIRONMENT', 'sandbox');
      await notify('five');
      expect(clients).toHaveLength(3);
      const closed = new Promise<void>(resolve => clients[1].once('close', () => resolve()));
      clients[1].destroy(new Error('Connection lost'));
      await closed;
      await notify('six');
      expect(clients).toHaveLength(4);

      holdResponses = true;
      const failed = notify('failed-request');
      const sibling = notify('sibling-request');
      await expect.poll(() => heldStreams.length).toBe(2);
      heldStreams[0].close(constants.NGHTTP2_INTERNAL_ERROR);
      heldStreams[1].respond({ ':status': 200 });
      heldStreams[1].end();
      await Promise.all([failed, sibling]);
      expect(clients[3].destroyed).toBe(false);
      const receipts = manager.config.host.mobilePush.registrations[0].recentEventIds;
      expect(receipts.some(id => id.includes(':sibling-request:'))).toBe(true);
      expect(receipts.some(id => id.includes(':failed-request:'))).toBe(false);
    } finally {
      clients.forEach(client => client.destroy());
      serverSessions.forEach(session => session.destroy());
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });

  it('preserves a host-access revocation queued before a push-state write', async () => {
    await configureApns();
    const directory = await mkdtemp(path.join(os.tmpdir(), 'pane-mobile-revoke-'));
    temporaryDirectories.push(directory);
    vi.stubEnv('PANE_DIR', directory);
    const manager = new ConfigManager();
    await manager.initialize();
    const config = createDefaultRemoteDaemonConfig();
    config.host.clients = [{ id: 'client-1', label: 'Phone', tokenHash: 'hash', createdAt: '2026-09-04T00:00:00.000Z' }];
    config.host.mobilePush.registrations = [{
      id: 'registration', clientId: 'client-1', installationId: 'install', platform: 'ios', token: 'token', hostProfileId: 'profile',
      needsInputEnabled: true, completedEnabled: true, recentEventIds: [], createdAt: '2026-09-04T00:00:00.000Z', updatedAt: '2026-09-04T00:00:00.000Z',
    }];
    await manager.updateConfig({ remoteDaemon: config });
    const sender = new MobilePushSender(manager, { apns: async () => ({ status: 200, body: '' }), fcm: async () => ({ status: 200, body: '' }) });
    await Promise.all([
      manager.updateConfig({ remoteDaemon: { ...config, host: { ...config.host, clients: [] } } }),
      sender.observeStatus({ sessionId: 'pane', panelId: 'panel', state: 'blocked', reason: null }),
    ]);
    expect(manager.getConfig().remoteDaemon?.host.clients).toEqual([]);
    expect(manager.getConfig().remoteDaemon?.host.mobilePush.registrations).toEqual([]);
  });

  it('delivers blocked and completed transitions once with a host-profile tap route', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'pane-mobile-push-'));
    temporaryDirectories.push(directory);
    const keyPath = path.join(directory, 'AuthKey.p8');
    const keyPair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    await writeFile(keyPath, keyPair.privateKey.export({ type: 'pkcs8', format: 'pem' }));
    setEnvironment({ team: 'TEAM', key: 'KEY', keyPath, topic: 'com.dcouple.pane.mobile', environment: 'sandbox' });

    const config = createDefaultRemoteDaemonConfig();
    config.host.clients = [{ id: 'client-1', label: 'Phone', tokenHash: 'hash', createdAt: '2026-09-04T00:00:00.000Z' }];
    const manager = new ConfigManagerStub(config);
    const requests: Parameters<MobilePushTransport['apns']>[0][] = [];
    const transport: MobilePushTransport = {
      apns: async request => { requests.push(request); return { status: 200, body: '' }; },
      fcm: async () => ({ status: 200, body: '' }),
    };
    const sender = new MobilePushSender(manager, transport);

    const profile = decodeRemoteConnectionCode(encodePaneRemoteConnection({
      v: 1, label: 'My Mac 💻', baseUrl: 'https://host.example.test/remote/browser', token: 'secret-token-12345678', transport: 'http+sse',
    }));
    const registration = { platform: 'ios' as const, token: 'token', installationId: 'install-1', hostProfileId: profile.id };
    await sender.register('client-1', registration);
    await sender.observeStatus({ sessionId: 'pane-1', panelId: 'panel-1', state: 'blocked', reason: 'prompt' });
    await sender.observeStatus({ sessionId: 'pane-1', panelId: 'panel-1', state: 'blocked', reason: 'prompt' });
    await sender.observeStatus({ sessionId: 'pane-1', panelId: 'panel-1', state: 'working', reason: 'working' });
    await sender.observeStatus({ sessionId: 'pane-1', panelId: 'panel-1', state: 'idle', reason: 'done' });

    expect(requests).toHaveLength(2);
    expect(requests[0]?.payload).toMatchObject({ hostProfileId: profile.id, paneId: 'pane-1', panelId: 'panel-1' });
    expect(Buffer.from(requests[0]?.jwt.split('.')[2] ?? '', 'base64url')).toHaveLength(64);
    expect(manager.config.host.mobilePush.registrations[0]?.recentEventIds).toHaveLength(2);

    await sender.updateControls('client-1', 'ios', 'install-1', { completedEnabled: false, needsInputEnabled: false });
    await expect(sender.register('client-1', { ...registration, token: 'rotated-token' })).resolves.toMatchObject({
      registration: 'registered', completedEnabled: false, needsInputEnabled: false,
    });
    expect(manager.config.host.mobilePush.registrations).toHaveLength(1);
    expect(manager.config.host.mobilePush.registrations[0]).toMatchObject({ token: 'rotated-token' });
    expect(manager.config.host.mobilePush.registrations[0]?.recentEventIds).toHaveLength(2);
    await sender.observeStatus({ sessionId: 'pane-1', panelId: 'panel-1', state: 'working', reason: 'working' });
    await sender.observeStatus({ sessionId: 'pane-1', panelId: 'panel-1', state: 'blocked', reason: 'prompt' });
    expect(requests).toHaveLength(2);
  });

  it('does not write mobile state for hosts without a registered mobile client', async () => {
    const manager = new ConfigManagerStub(createDefaultRemoteDaemonConfig());
    const save = vi.spyOn(manager, 'updateConfigWith');
    await new MobilePushSender(manager).observeStatus({ sessionId: 'pane', panelId: 'panel', state: 'working', reason: null });
    expect(save).not.toHaveBeenCalled();
  });

  it.each(['', 'bad\nprofile', 'x'.repeat(1025)])('rejects an invalid routing identifier', async hostProfileId => {
    const sender = new MobilePushSender(new ConfigManagerStub(createDefaultRemoteDaemonConfig()));
    await expect(sender.register('client-1', { platform: 'ios', token: 'token', installationId: 'install', hostProfileId })).rejects.toThrow('Invalid mobile notification registration');
  });

  it('does not replay an unchanged blocked state after a sender restart', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'pane-mobile-push-'));
    temporaryDirectories.push(directory);
    const keyPath = path.join(directory, 'AuthKey.p8');
    const keyPair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    await writeFile(keyPath, keyPair.privateKey.export({ type: 'pkcs8', format: 'pem' }));
    setEnvironment({ team: 'TEAM', key: 'KEY', keyPath, topic: 'com.dcouple.pane.mobile', environment: 'sandbox' });
    const config = createDefaultRemoteDaemonConfig();
    config.host.clients = [{ id: 'client-1', label: 'Phone', tokenHash: 'hash', createdAt: '2026-09-04T00:00:00.000Z' }];
    const manager = new ConfigManagerStub(config);
    const requests: unknown[] = [];
    const transport: MobilePushTransport = { apns: async request => { requests.push(request); return { status: 200, body: '' }; }, fcm: async () => ({ status: 200, body: '' }) };
    const first = new MobilePushSender(manager, transport);
    await first.register('client-1', { platform: 'ios', token: 'token', installationId: 'install-1', hostProfileId: 'profile-1' });
    await first.observeStatus({ sessionId: 'pane-1', panelId: 'panel-1', state: 'blocked', reason: 'prompt' });
    await new MobilePushSender(manager, transport).observeStatus({ sessionId: 'pane-1', panelId: 'panel-1', state: 'blocked', reason: 'prompt' });
    expect(requests).toHaveLength(1);
  });

  it('revokes an Android token when FCM reports UNREGISTERED', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'pane-mobile-push-'));
    temporaryDirectories.push(directory);
    const serviceAccountPath = path.join(directory, 'service-account.json');
    const keyPair = generateKeyPairSync('rsa', { modulusLength: 2048 });
    await writeFile(serviceAccountPath, JSON.stringify({ project_id: 'project', client_email: 'sender@example.test', private_key: keyPair.privateKey.export({ type: 'pkcs8', format: 'pem' }) }));
    setEnvironment({ fcmPath: serviceAccountPath });
    const config = createDefaultRemoteDaemonConfig();
    config.host.clients = [{ id: 'client-1', label: 'Phone', tokenHash: 'hash', createdAt: '2026-09-04T00:00:00.000Z' }];
    const manager = new ConfigManagerStub(config);
    const transport: MobilePushTransport = { apns: async () => ({ status: 200, body: '' }), fcm: async () => ({ status: 404, body: '{"error":{"status":"UNREGISTERED"}}' }) };
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ access_token: 'access-token' }), { status: 200 })));
    const sender = new MobilePushSender(manager, transport);
    await sender.register('client-1', { platform: 'android', token: 'token', installationId: 'install-1', hostProfileId: 'profile-1' });
    await sender.observeStatus({ sessionId: 'pane-1', panelId: 'panel-1', state: 'blocked', reason: 'prompt' });
    expect(manager.config.host.mobilePush.registrations[0]?.revokedAt).toBeTruthy();
  });
});

class ConfigManagerStub {
  config: RemoteDaemonConfig;
  constructor(config: RemoteDaemonConfig) { this.config = config; }
  getConfig() { return { remoteDaemon: this.config }; }
  async updateConfigWith(update: (current: { remoteDaemon?: RemoteDaemonConfig }) => { remoteDaemon: RemoteDaemonConfig }): Promise<{ remoteDaemon: RemoteDaemonConfig }> {
    this.config = update(this.getConfig()).remoteDaemon;
    return { remoteDaemon: this.config };
  }
}

function setEnvironment(values: { team?: string; key?: string; keyPath?: string; topic?: string; environment?: string; fcmPath?: string }): void {
  setEnvironmentValue('PANE_APNS_TEAM_ID', values.team);
  setEnvironmentValue('PANE_APNS_KEY_ID', values.key);
  setEnvironmentValue('PANE_APNS_KEY_PATH', values.keyPath);
  setEnvironmentValue('PANE_APNS_TOPIC', values.topic);
  setEnvironmentValue('PANE_APNS_ENVIRONMENT', values.environment);
  setEnvironmentValue('PANE_FCM_SERVICE_ACCOUNT_PATH', values.fcmPath);
}
function setEnvironmentValue(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

function registeredHost(): RemoteDaemonConfig {
  const config = createDefaultRemoteDaemonConfig();
  config.host.clients = [{ id: 'client-1', label: 'Phone', tokenHash: 'hash', createdAt: '2026-09-04T00:00:00.000Z' }];
  return config;
}

async function configureApns(): Promise<void> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'pane-mobile-auth-'));
  temporaryDirectories.push(directory);
  const keyPath = path.join(directory, 'AuthKey.p8');
  const keyPair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  await writeFile(keyPath, keyPair.privateKey.export({ type: 'pkcs8', format: 'pem' }));
  setEnvironment({ team: 'TEAM', key: 'KEY', keyPath, topic: 'com.dcouple.pane.mobile', environment: 'sandbox' });
}

async function configureFcm(): Promise<void> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'pane-mobile-fcm-'));
  temporaryDirectories.push(directory);
  const serviceAccountPath = path.join(directory, 'service-account.json');
  const keyPair = generateKeyPairSync('rsa', { modulusLength: 2048 });
  await writeFile(serviceAccountPath, JSON.stringify({ project_id: 'project', client_email: 'sender@example.test', private_key: keyPair.privateKey.export({ type: 'pkcs8', format: 'pem' }) }));
  setEnvironment({ fcmPath: serviceAccountPath });
}
