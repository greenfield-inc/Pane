import { generateKeyPairSync } from 'crypto';
import { mkdtemp, rm, writeFile } from 'fs/promises';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDefaultRemoteDaemonConfig, type RemoteDaemonConfig } from '../../../shared/types/remoteDaemon';
import { MobilePushSender, STABLE_IDLE_MS, type MobilePushTransport } from './mobilePushSender';
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
  vi.useRealTimers();
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
      sender.observeStatus({ sessionId: 'pane', panelId: 'panel', state: 'working', reason: null, agentType: 'claude' }),
    ]);
    expect(manager.getConfig().remoteDaemon?.host.clients).toEqual([]);
    expect(manager.getConfig().remoteDaemon?.host.mobilePush.registrations).toEqual([]);
  });

  it('sends with APNs credentials saved in host config when the host environment has none', async () => {
    setEnvironment({});
    const directory = await mkdtemp(path.join(os.tmpdir(), 'pane-mobile-apns-config-'));
    temporaryDirectories.push(directory);
    vi.stubEnv('PANE_DIR', directory);
    const manager = new ConfigManager();
    await manager.initialize();
    const config = createDefaultRemoteDaemonConfig();
    config.host.clients = [{ id: 'client-1', label: 'Phone', tokenHash: 'hash', createdAt: '2026-09-04T00:00:00.000Z' }];
    const privateKey = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    await manager.updateConfig({ remoteDaemon: config, apns: { teamId: 'TEAM', keyId: 'KEY', privateKey, topic: 'com.example.shared', environment: 'production' } });
    const requests: Parameters<MobilePushTransport['apns']>[0][] = [];
    const sender = new MobilePushSender(manager, {
      apns: async request => { requests.push(request); return { status: 200, body: '' }; },
      fcm: async () => ({ status: 200, body: '' }),
    });

    await expect(sender.register('client-1', { platform: 'ios', token: 'token', installationId: 'install-1', hostProfileId: 'profile' }))
      .resolves.toMatchObject({ provider: 'ready' });
    await sender.observeStatus({ sessionId: 'pane-1', panelId: 'panel-1', state: 'blocked', reason: 'prompt', agentType: 'claude' });

    expect(requests.map(request => request.topic)).toEqual(['com.example.shared']);
  });

  it('delivers blocked and completed transitions once with a host-profile tap route', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
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
    await sender.observeStatus({ sessionId: 'pane-1', panelId: 'panel-1', state: 'blocked', reason: 'prompt', agentType: 'claude' });
    await sender.observeStatus({ sessionId: 'pane-1', panelId: 'panel-1', state: 'blocked', reason: 'prompt', agentType: 'claude' });
    sender.arm('panel-1');
    await sender.observeStatus({ sessionId: 'pane-1', panelId: 'panel-1', state: 'working', reason: 'working', agentType: 'claude' });
    await sender.observeStatus({ sessionId: 'pane-1', panelId: 'panel-1', state: 'idle', reason: 'done', agentType: 'claude', workedVisibly: true });
    await vi.advanceTimersByTimeAsync(STABLE_IDLE_MS);

    expect(requests).toHaveLength(2);
    expect(requests[0]?.payload).toMatchObject({ hostProfileId: profile.id, paneId: 'pane-1', panelId: 'panel-1' });
    expect(Buffer.from(requests[0]?.jwt.split('.')[2] ?? '', 'base64url')).toHaveLength(64);
    expect(manager.config.host.mobilePush.registrations[0]?.recentEventIds).toHaveLength(2);

    for (const reason of ['exit', 'destroyed']) {
      sender.arm('panel-1');
      await sender.observeStatus({ sessionId: 'pane-1', panelId: 'panel-1', state: 'working', reason: 'working', agentType: 'claude' });
      await sender.observeStatus({ sessionId: 'pane-1', panelId: 'panel-1', state: 'idle', reason, agentType: 'claude', workedVisibly: true });
      await vi.advanceTimersByTimeAsync(STABLE_IDLE_MS);
      expect(manager.config.host.mobilePush.panelStates['panel-1']).toBe('idle');
      expect(manager.config.host.mobilePush.attentionSequence).toBe(2);
      expect(requests).toHaveLength(2);
    }

    await sender.updateControls('client-1', 'ios', 'install-1', { completedEnabled: false, needsInputEnabled: false });
    await expect(sender.register('client-1', { ...registration, token: 'rotated-token' })).resolves.toMatchObject({
      registration: 'registered', completedEnabled: false, needsInputEnabled: false,
    });
    expect(manager.config.host.mobilePush.registrations).toHaveLength(1);
    expect(manager.config.host.mobilePush.registrations[0]).toMatchObject({ token: 'rotated-token' });
    expect(manager.config.host.mobilePush.registrations[0]?.recentEventIds).toHaveLength(2);
    await sender.observeStatus({ sessionId: 'pane-1', panelId: 'panel-1', state: 'working', reason: 'working', agentType: 'claude' });
    await sender.observeStatus({ sessionId: 'pane-1', panelId: 'panel-1', state: 'blocked', reason: 'prompt', agentType: 'claude' });
    expect(requests).toHaveLength(2);
  });

  describe('attention timing and copy', () => {
    async function apnsHost(names: Record<string, string> = { 'pane-1': 'api-fix' }, groups: Record<string, string> = {}) {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      const directory = await mkdtemp(path.join(os.tmpdir(), 'pane-mobile-push-'));
      temporaryDirectories.push(directory);
      const keyPath = path.join(directory, 'AuthKey.p8');
      await writeFile(keyPath, generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey.export({ type: 'pkcs8', format: 'pem' }));
      setEnvironment({ team: 'TEAM', key: 'KEY', keyPath, topic: 'com.dcouple.pane.mobile', environment: 'production' });
      const config = createDefaultRemoteDaemonConfig();
      config.host.clients = [{ id: 'client-1', label: 'Phone', tokenHash: 'hash', createdAt: '2026-09-04T00:00:00.000Z' }];
      const requests: Parameters<MobilePushTransport['apns']>[0][] = [];
      const transport: MobilePushTransport = {
        apns: async request => { requests.push(request); return { status: 200, body: '' }; },
        fcm: async () => ({ status: 200, body: '' }),
      };
      const sender = new MobilePushSender(new ConfigManagerStub(config), transport, {
        resolveSubject: paneId => ({ title: names[paneId] ?? '', groupPaneId: groups[paneId] ?? paneId }),
      });
      await sender.register('client-1', { platform: 'ios', token: 'token', installationId: 'install-1', hostProfileId: 'profile-1' });
      const alerts = () => requests.map(request => request.payload.aps);
      return { sender, requests, alerts };
    }
    const alert = (title: string, body: string) => expect.objectContaining({ alert: { title, body } });
    const event = (state: 'working' | 'idle' | 'blocked', extra: { workedVisibly?: boolean; agentType?: string; sessionId?: string } = {}) => ({
      sessionId: extra.sessionId ?? 'pane-1', panelId: `panel-${extra.sessionId ?? 'pane-1'}`, state, reason: null, agentType: extra.agentType ?? 'claude', workedVisibly: extra.workedVisibly,
    });

    it('says a pane finished only after it stays idle, and names the pane', async () => {
      const { sender, alerts } = await apnsHost();
      sender.arm('panel-pane-1');
      await sender.observeStatus(event('working'));
      await sender.observeStatus(event('idle', { workedVisibly: true }));
      await vi.advanceTimersByTimeAsync(STABLE_IDLE_MS - 1);
      expect(alerts()).toEqual([]);
      await vi.advanceTimersByTimeAsync(1);
      expect(alerts()).toEqual([alert('api-fix', 'api-fix needs your attention')]);
    });

    it('waits out a pause inside a turn and sends one alert at the end', async () => {
      const { sender, alerts } = await apnsHost();
      sender.arm('panel-pane-1');
      await sender.observeStatus(event('working'));
      await sender.observeStatus(event('idle', { workedVisibly: true }));
      await vi.advanceTimersByTimeAsync(3_500);
      await sender.observeStatus(event('working'));
      await vi.advanceTimersByTimeAsync(60_000);
      expect(alerts()).toEqual([]);
      await sender.observeStatus(event('idle', { workedVisibly: true }));
      await vi.advanceTimersByTimeAsync(STABLE_IDLE_MS);
      expect(alerts()).toHaveLength(1);
    });

    it('still reports a finished turn when typing or a redraw follows it', async () => {
      const { sender, alerts } = await apnsHost();
      sender.arm('panel-pane-1');
      await sender.observeStatus(event('working'));
      await sender.observeStatus(event('idle', { workedVisibly: true }));
      await vi.advanceTimersByTimeAsync(2_000);
      await sender.observeStatus(event('working'));
      await sender.observeStatus(event('idle', { workedVisibly: false }));
      await vi.advanceTimersByTimeAsync(STABLE_IDLE_MS);
      expect(alerts()).toHaveLength(1);
    });

    it('never says finished for output the agent did not visibly work on', async () => {
      const { sender, alerts } = await apnsHost();
      sender.arm('panel-pane-1');
      for (let index = 0; index < 3; index += 1) {
        await sender.observeStatus(event('working'));
        await sender.observeStatus(event('idle', { workedVisibly: false }));
        await vi.advanceTimersByTimeAsync(60_000);
      }
      expect(alerts()).toEqual([]);
    });

    it('says a pane is blocked at once, prompted or not, and drops its pending finished alert', async () => {
      const { sender, alerts } = await apnsHost();
      await sender.observeStatus(event('working'));
      await sender.observeStatus(event('idle', { workedVisibly: true }));
      await sender.observeStatus(event('blocked'));
      await vi.advanceTimersByTimeAsync(60_000);
      expect(alerts()).toEqual([alert('api-fix', 'api-fix is blocked')]);
    });

    it('sends nothing for plain shells', async () => {
      const { sender, alerts } = await apnsHost();
      const shell = { sessionId: 'pane-1', panelId: 'shell-1', reason: null, workedVisibly: true } as const;
      await sender.observeStatus({ ...shell, state: 'working' });
      await sender.observeStatus({ ...shell, state: 'idle' });
      await sender.observeStatus({ ...shell, state: 'blocked' });
      await vi.advanceTimersByTimeAsync(60_000);
      expect(alerts()).toEqual([]);
    });

    it('replaces and groups alerts per pane', async () => {
      const { sender, requests } = await apnsHost({ 'pane-1': 'api-fix', 'pane-2': 'docs' });
      for (const sessionId of ['pane-1', 'pane-1', 'pane-2']) {
        await sender.observeStatus(event('working', { sessionId }));
        await sender.observeStatus(event('blocked', { sessionId }));
      }
      const [first, second, other] = requests;
      expect(first?.collapseId).toBe(second?.collapseId);
      expect(other?.collapseId).not.toBe(first?.collapseId);
      expect(Buffer.byteLength(first?.collapseId ?? '')).toBeLessThanOrEqual(64);
      expect(requests.map(request => request.payload.aps)).toEqual(['pane-1', 'pane-1', 'pane-2'].map(thread => expect.objectContaining({ 'thread-id': thread })));
    });

    it('says finished only for a turn a person prompted, once', async () => {
      const { sender, alerts } = await apnsHost();
      const turn = async () => {
        await sender.observeStatus(event('working'));
        await sender.observeStatus(event('idle', { workedVisibly: true }));
        await vi.advanceTimersByTimeAsync(STABLE_IDLE_MS);
      };
      await turn();
      expect(alerts()).toEqual([]);
      sender.arm('panel-pane-1');
      await turn();
      await turn();
      expect(alerts()).toEqual([alert('api-fix', 'api-fix needs your attention')]);
    });

    it('lets a prompt replace a finish that is still settling', async () => {
      const { sender, alerts } = await apnsHost();
      await sender.observeStatus(event('working'));
      await sender.observeStatus(event('idle', { workedVisibly: true }));
      await vi.advanceTimersByTimeAsync(2_000);
      sender.arm('panel-pane-1');
      await vi.advanceTimersByTimeAsync(60_000);
      expect(alerts()).toEqual([]);
      await sender.observeStatus(event('working'));
      await sender.observeStatus(event('idle', { workedVisibly: true }));
      await vi.advanceTimersByTimeAsync(STABLE_IDLE_MS);
      expect(alerts()).toHaveLength(1);
    });

    it('stacks a worker under its Session and still replaces per Pane', async () => {
      const { sender, requests } = await apnsHost({ 'pane-1': 'Launch › api-fix', 'pane-2': 'Launch › docs' }, { 'pane-1': 'session-pane', 'pane-2': 'session-pane' });
      for (const sessionId of ['pane-1', 'pane-2']) await sender.observeStatus(event('blocked', { sessionId }));
      const [first, second] = requests;
      expect(first?.payload).toMatchObject({ paneId: 'pane-1', sessionPaneId: 'session-pane', aps: { 'thread-id': 'session-pane', alert: { title: 'Launch › api-fix', body: 'Launch › api-fix is blocked' } } });
      expect(second?.payload).toMatchObject({ paneId: 'pane-2', sessionPaneId: 'session-pane', aps: { 'thread-id': 'session-pane' } });
      expect(second?.collapseId).not.toBe(first?.collapseId);
    });

    it('falls back to "Pane" when the name is unknown', async () => {
      const { sender, alerts } = await apnsHost({});
      await sender.observeStatus(event('blocked'));
      expect(alerts()).toEqual([alert('Pane', 'Pane is blocked')]);
    });
  });

  it('does not write mobile state for hosts without a registered mobile client', async () => {
    const manager = new ConfigManagerStub(createDefaultRemoteDaemonConfig());
    const save = vi.spyOn(manager, 'updateConfigWith');
    await new MobilePushSender(manager).observeStatus({ sessionId: 'pane', panelId: 'panel', state: 'working', reason: null, agentType: 'claude' });
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
    await first.observeStatus({ sessionId: 'pane-1', panelId: 'panel-1', state: 'blocked', reason: 'prompt', agentType: 'claude' });
    await new MobilePushSender(manager, transport).observeStatus({ sessionId: 'pane-1', panelId: 'panel-1', state: 'blocked', reason: 'prompt', agentType: 'claude' });
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
    await sender.observeStatus({ sessionId: 'pane-1', panelId: 'panel-1', state: 'blocked', reason: 'prompt', agentType: 'claude' });
    expect(manager.config.host.mobilePush.registrations[0]?.revokedAt).toBeTruthy();
  });

  it('sends FCM as an impersonated sender using the operator\'s gcloud login, without a key file', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'pane-mobile-push-'));
    temporaryDirectories.push(directory);
    const adcPath = path.join(directory, 'application_default_credentials.json');
    await writeFile(adcPath, JSON.stringify({ type: 'authorized_user', client_id: 'client-id', client_secret: 'client-secret', refresh_token: 'refresh-token' }));
    setEnvironment({});
    vi.stubEnv('GOOGLE_APPLICATION_CREDENTIALS', adcPath);
    vi.stubEnv('PANE_FCM_IMPERSONATE_SERVICE_ACCOUNT', 'sender@pane-project.iam.gserviceaccount.com');
    vi.stubEnv('PANE_FCM_PROJECT_ID', 'pane-project');
    const googleRequests: { url: string; authorization: string | null; body: string }[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
      googleRequests.push({ url, authorization: new Headers(init.headers).get('Authorization'), body: String(init.body) });
      if (url === 'https://oauth2.googleapis.com/token') return new Response(JSON.stringify({ access_token: 'user-token' }), { status: 200 });
      return new Response(JSON.stringify({ accessToken: 'sender-token', expireTime: '2026-09-25T01:00:00Z' }), { status: 200 });
    }));
    const config = createDefaultRemoteDaemonConfig();
    config.host.clients = [{ id: 'client-1', label: 'Phone', tokenHash: 'hash', createdAt: '2026-09-04T00:00:00.000Z' }];
    const manager = new ConfigManagerStub(config);
    const fcmRequests: Parameters<MobilePushTransport['fcm']>[0][] = [];
    const transport: MobilePushTransport = { apns: async () => ({ status: 200, body: '' }), fcm: async request => { fcmRequests.push(request); return { status: 200, body: '' }; } };
    const sender = new MobilePushSender(manager, transport);

    await expect(sender.register('client-1', { platform: 'android', token: 'device-token', installationId: 'install-1', hostProfileId: 'profile-1' }))
      .resolves.toMatchObject({ registration: 'registered', provider: 'ready' });
    await sender.observeStatus({ sessionId: 'pane-1', panelId: 'panel-1', state: 'blocked', reason: 'prompt', agentType: 'claude' });

    expect(fcmRequests).toEqual([expect.objectContaining({ token: 'device-token', accessToken: 'sender-token', projectId: 'pane-project' })]);
    expect(fcmRequests[0]?.payload).toMatchObject({ message: { android: { notification: { tag: expect.stringMatching(/^[0-9a-f]{64}$/) } } } });
    expect(new URLSearchParams(googleRequests[0]?.body)).toEqual(new URLSearchParams({
      grant_type: 'refresh_token', client_id: 'client-id', client_secret: 'client-secret', refresh_token: 'refresh-token',
    }));
    expect(googleRequests[1]).toEqual({
      url: 'https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/sender%40pane-project.iam.gserviceaccount.com:generateAccessToken',
      authorization: 'Bearer user-token',
      body: JSON.stringify({ scope: ['https://www.googleapis.com/auth/firebase.messaging'] }),
    });
  });

  it('reports FCM as not configured when the impersonation setup has no gcloud login', async () => {
    setEnvironment({});
    vi.stubEnv('GOOGLE_APPLICATION_CREDENTIALS', path.join(os.tmpdir(), 'pane-missing-adc', 'application_default_credentials.json'));
    vi.stubEnv('PANE_FCM_IMPERSONATE_SERVICE_ACCOUNT', 'sender@pane-project.iam.gserviceaccount.com');
    vi.stubEnv('PANE_FCM_PROJECT_ID', 'pane-project');
    const sender = new MobilePushSender(new ConfigManagerStub(createDefaultRemoteDaemonConfig()));
    await expect(sender.register('client-1', { platform: 'android', token: 'device-token', installationId: 'install-1', hostProfileId: 'profile-1' }))
      .resolves.toMatchObject({ registration: 'not-registered', provider: 'missing-config', code: 'ERR_FCM_NOT_CONFIGURED' });
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
