import { generateKeyPairSync } from 'crypto';
import { mkdtemp, rm, writeFile } from 'fs/promises';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDefaultRemoteDaemonConfig, type RemoteDaemonConfig } from '../../../shared/types/remoteDaemon';
import { MobilePushSender, type MobilePushTransport } from './mobilePushSender';
import { decodeRemoteConnectionCode } from '../../../shared/remoteClient/pairing';
import { encodePaneRemoteConnection } from '../../../shared/types/remoteDaemon';
import { ConfigManager } from '../services/configManager';

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
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

describe('MobilePushSender', () => {
  it('preserves a host-access revocation queued before a push-state write', async () => {
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
    const sender = new MobilePushSender(manager);
    await Promise.all([
      manager.updateConfig({ remoteDaemon: { ...config, host: { ...config.host, clients: [] } } }),
      sender.observeStatus({ sessionId: 'pane', panelId: 'panel', state: 'working', reason: null }),
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
