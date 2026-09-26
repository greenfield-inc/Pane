import { createHash, createPrivateKey, createSign, randomUUID } from 'crypto';
import { readFileSync } from 'fs';
import { connect as connectHttp2, type ClientHttp2Session } from 'http2';
import { boundary, decodeBoundary, decodeOptionalBoundary, type JsonObject } from '../../../shared/validation/boundaryDecoder';
import type { AgentState, PanelAgentStatusEvent } from '../../../shared/types/agentStatus';
import {
  createDefaultRemoteDaemonConfig,
  normalizeRemoteDaemonConfig,
  type RemoteDaemonConfig,
  type RemoteMobilePlatform,
  type RemoteMobilePushRegistration,
  type RemoteMobilePushStatus,
} from '../../../shared/types/remoteDaemon';

interface MobilePushConfigManager {
  getConfig(): { remoteDaemon?: RemoteDaemonConfig };
  updateConfigWith(update: (current: { remoteDaemon?: RemoteDaemonConfig }) => { remoteDaemon: RemoteDaemonConfig }): Promise<{ remoteDaemon?: RemoteDaemonConfig }>;
}

export interface MobilePushRegistrationRequest {
  platform: RemoteMobilePlatform;
  token: string;
  installationId: string;
  hostProfileId: string;
  needsInputEnabled?: boolean;
  completedEnabled?: boolean;
}

interface ProviderResponse { status: number; body: string; }
interface AccessToken { value: string; expiresAt: number; }
interface PushNotification { eventId: string; kind: 'needs-input' | 'completed'; registrationIds: string[]; }
export interface MobilePushTransport {
  apns(request: { token: string; jwt: string; topic: string; environment: 'sandbox' | 'production'; credentialsId: string; payload: JsonObject }): Promise<ProviderResponse>;
  fcm(request: { token: string; accessToken: string; projectId: string; payload: JsonObject }): Promise<ProviderResponse>;
}
interface FcmCredentials { project_id: string; client_email: string; private_key: string; token_uri?: string; }
interface ApnsCredentials { teamId: string; keyId: string; privateKey: string; topic: string; environment: 'sandbox' | 'production'; }
class ProviderDeliveryError extends Error {
  constructor(readonly status: number, readonly body: string, message: string) { super(message); }
}

const MAX_RECENT_EVENTS = 64;
const MAX_PANEL_STATES = 1024;
const PROVIDER_TIMEOUT_MS = 15_000;
const senderByConfigManager = new WeakMap<MobilePushConfigManager, MobilePushSender>();

/**
 * Host-owned sender. Its credentials are read only from operator environment
 * variables, never from a pairing payload, remote config, or the mobile app.
 */
export class MobilePushSender {
  private panelStates: Map<string, AgentState>;
  private mutationQueue: Promise<void> = Promise.resolve();
  private apnsToken?: AccessToken & { credentials: string };
  private fcmToken?: AccessToken & { credentials: string };
  private fcmTokenRequest?: { credentials: string; promise: Promise<AccessToken> };

  constructor(private readonly configManager: MobilePushConfigManager, private readonly transport: MobilePushTransport = createProviderTransport()) {
    this.panelStates = new Map(Object.entries(this.config().host.mobilePush.panelStates).slice(-MAX_PANEL_STATES));
  }

  getStatus(clientId: string, platform: RemoteMobilePlatform, installationId: string): RemoteMobilePushStatus {
    const registration = this.config().host.mobilePush.registrations.find(item => (
      item.clientId === clientId && item.platform === platform && item.installationId === installationId && !item.revokedAt
    ));
    const status: RemoteMobilePushStatus = { platform, registration: registration ? 'registered' : 'not-registered', ...providerReadiness(platform) };
    if (registration) {
      status.needsInputEnabled = registration.needsInputEnabled;
      status.completedEnabled = registration.completedEnabled;
    }
    return status;
  }

  async register(clientId: string, request: MobilePushRegistrationRequest): Promise<RemoteMobilePushStatus> {
    return this.mutate(() => this.registerUnsafe(clientId, request));
  }
  private async registerUnsafe(clientId: string, request: MobilePushRegistrationRequest): Promise<RemoteMobilePushStatus> {
    if (!isSafeIdentifier(request.installationId) || !isSafeProfileId(request.hostProfileId) || !isSafeToken(request.token)) {
      throw new Error('Invalid mobile notification registration');
    }
    const readiness = providerReadiness(request.platform);
    if (readiness.provider !== 'ready') return { platform: request.platform, registration: 'not-registered', ...readiness };
    const config = this.config();
    const now = new Date().toISOString();
    const matchesInstallation = (existing: RemoteMobilePushRegistration) => (
      existing.clientId === clientId && existing.platform === request.platform && existing.installationId === request.installationId
    );
    const previous = config.host.mobilePush.registrations.find(existing => matchesInstallation(existing) && !existing.revokedAt);
    const registrations = config.host.mobilePush.registrations.filter(existing => (
      !matchesInstallation(existing)
    ));
    registrations.push({
      id: previous?.id ?? randomUUID(), clientId, platform: request.platform, token: request.token, installationId: request.installationId,
      hostProfileId: request.hostProfileId, needsInputEnabled: request.needsInputEnabled ?? previous?.needsInputEnabled ?? true,
      completedEnabled: request.completedEnabled ?? previous?.completedEnabled ?? true,
      createdAt: previous?.createdAt ?? now, updatedAt: now, recentEventIds: previous?.recentEventIds ?? [],
    });
    await this.save(configWithRegistrations(config, registrations));
    return this.getStatus(clientId, request.platform, request.installationId);
  }

  async updateControls(
    clientId: string,
    platform: RemoteMobilePlatform,
    installationId: string,
    controls: { needsInputEnabled?: boolean; completedEnabled?: boolean },
  ): Promise<RemoteMobilePushStatus> {
    return this.mutate(() => this.updateControlsUnsafe(clientId, platform, installationId, controls));
  }
  private async updateControlsUnsafe(
    clientId: string, platform: RemoteMobilePlatform, installationId: string,
    controls: { needsInputEnabled?: boolean; completedEnabled?: boolean },
  ): Promise<RemoteMobilePushStatus> {
    const config = this.config();
    const now = new Date().toISOString();
    const registrations = config.host.mobilePush.registrations.map(registration => {
      if (registration.clientId !== clientId || registration.platform !== platform || registration.installationId !== installationId || registration.revokedAt) return registration;
      const updated: RemoteMobilePushRegistration = { ...registration, updatedAt: now };
      if (controls.needsInputEnabled !== undefined) updated.needsInputEnabled = controls.needsInputEnabled;
      if (controls.completedEnabled !== undefined) updated.completedEnabled = controls.completedEnabled;
      return updated;
    });
    await this.save(configWithRegistrations(config, registrations));
    return this.getStatus(clientId, platform, installationId);
  }

  async revoke(clientId: string, platform: RemoteMobilePlatform, installationId: string): Promise<void> {
    await this.mutate(() => this.revokeUnsafe(clientId, platform, installationId));
  }
  private async revokeUnsafe(clientId: string, platform: RemoteMobilePlatform, installationId: string): Promise<void> {
    const config = this.config();
    const now = new Date().toISOString();
    const registrations = config.host.mobilePush.registrations.map(registration => (
      registration.clientId === clientId && registration.platform === platform && registration.installationId === installationId && !registration.revokedAt
        ? { ...registration, revokedAt: now, updatedAt: now }
        : registration
    ));
    await this.save(configWithRegistrations(config, registrations));
  }

  async observeStatus(event: PanelAgentStatusEvent): Promise<void> {
    const notification = await this.mutate(() => this.prepareStatus(event));
    if (!notification) return;
    const { eventId, kind } = notification;
    for (const id of notification.registrationIds) {
      // Registration and controls may change while an earlier delivery waits.
      const config = this.config();
      const registration = config.host.mobilePush.registrations.find(item => item.id === id);
      if (!registration || registration.revokedAt || !isEnabled(registration, kind)) continue;
      if (!config.host.clients.some(client => client.id === registration.clientId)) continue;
      if (registration.recentEventIds.includes(eventId)) continue;
      try {
        if (await this.deliver(registration, eventId, event, kind)) {
          await this.mutate(() => this.markDelivered(registration.id, eventId));
        }
      } catch (error) {
        if (error instanceof ProviderDeliveryError && isInvalidTokenResponse(error)) {
          await this.mutate(() => this.revokeRegistration(registration.id, registration.token));
        }
        const status = error instanceof ProviderDeliveryError ? error.status : undefined;
        console.warn('[Pane mobile push] Delivery failed', { platform: registration.platform, status });
      }
    }
  }

  private async prepareStatus(event: PanelAgentStatusEvent): Promise<PushNotification | undefined> {
    const config = this.config();
    if (!config.host.mobilePush.registrations.some(item => !item.revokedAt && config.host.clients.some(client => client.id === item.clientId))) return;
    const previous = this.previousState(event, config);
    const kind = event.state === 'blocked' && previous !== 'blocked'
      ? 'needs-input'
      : previous === 'working' && event.state === 'idle'
        ? 'completed'
        : null;
    if (!kind) {
      this.rememberState(event);
      return;
    }
    const registrationIds = config.host.mobilePush.registrations.filter(item => (
      !item.revokedAt && isEnabled(item, kind) && config.host.clients.some(client => client.id === item.clientId)
    )).map(item => item.id);
    if (registrationIds.length === 0) {
      this.rememberState(event);
      return;
    }
    const sequence = config.host.mobilePush.attentionSequence + 1;
    const eventId = `pane:${event.sessionId}:${event.panelId}:${kind}:${sequence}`;
    const updatedConfig: RemoteDaemonConfig = {
      ...config,
      host: { ...config.host, mobilePush: { ...config.host.mobilePush, attentionSequence: sequence } },
    };
    await this.save(updatedConfig);
    this.rememberState(event);
    return { eventId, kind, registrationIds };
  }

  private rememberState(event: PanelAgentStatusEvent): void {
    this.panelStates.delete(event.panelId);
    this.panelStates.set(event.panelId, event.state);
    // Archived/deleted panels stop producing events; bound their retained state.
    if (this.panelStates.size > MAX_PANEL_STATES) {
      const oldest = this.panelStates.keys().next().value;
      if (oldest !== undefined) this.panelStates.delete(oldest);
    }
  }

  private previousState(event: PanelAgentStatusEvent, config: RemoteDaemonConfig): AgentState | undefined {
    const remembered = this.panelStates.get(event.panelId);
    if (remembered !== undefined) return remembered;
    // Delivery receipts already persist across restart. Use the latest receipt
    // as the initial baseline rather than replaying an unchanged blocked state.
    const prefix = `pane:${event.sessionId}:${event.panelId}:`;
    let latest = -1;
    let state: AgentState | undefined;
    for (const registration of config.host.mobilePush.registrations) {
      for (const eventId of registration.recentEventIds) {
        if (!eventId.startsWith(prefix)) continue;
        const [kind, sequence] = eventId.slice(prefix.length).split(':');
        const number = Number(sequence);
        if (Number.isSafeInteger(number) && number > latest && (kind === 'needs-input' || kind === 'completed')) {
          latest = number;
          state = kind === 'needs-input' ? 'blocked' : 'idle';
        }
      }
    }
    return state;
  }

  private async deliver(registration: RemoteMobilePushRegistration, eventId: string, event: PanelAgentStatusEvent, kind: 'needs-input' | 'completed'): Promise<boolean> {
    const title = kind === 'completed' ? 'Pane finished a turn' : 'Pane needs attention';
    const payload: JsonObject = {
      eventId, hostProfileId: registration.hostProfileId, paneId: event.sessionId, panelId: event.panelId,
      aps: { alert: { title, body: 'Open Pane to continue.' }, sound: 'default' },
    };
    if (registration.platform === 'ios') {
      const credentials = readApnsCredentials();
      if (!credentials) throw new ProviderDeliveryError(503, '', 'APNs is not configured');
      const response = await this.transport.apns({ token: registration.token, jwt: this.apnsJwt(credentials), topic: credentials.topic, environment: credentials.environment, credentialsId: credentialKey(credentials), payload });
      if (!isSuccess(response.status)) throw new ProviderDeliveryError(response.status, response.body, 'APNs rejected notification');
      return true;
    }
    const credentials = readFcmCredentials();
    if (!credentials) throw new ProviderDeliveryError(503, '', 'FCM is not configured');
    const accessToken = await this.fcmAccessToken(credentials);
    // OAuth may have waited while the phone rotated its token or revoked access.
    const current = this.config();
    if (!current.host.clients.some(client => client.id === registration.clientId)
      || !current.host.mobilePush.registrations.some(item => item.id === registration.id && item.token === registration.token
        && item.hostProfileId === registration.hostProfileId && !item.revokedAt && isEnabled(item, kind))) return false;
    const response = await this.transport.fcm({
      token: registration.token, accessToken, projectId: credentials.project_id,
      payload: { message: { token: registration.token, notification: { title, body: 'Open Pane to continue.' }, data: { eventId, hostProfileId: registration.hostProfileId, paneId: event.sessionId, panelId: event.panelId } } },
    });
    if (!isSuccess(response.status)) throw new ProviderDeliveryError(response.status, response.body, 'FCM rejected notification');
    return true;
  }

  private apnsJwt(credentials: ApnsCredentials): string {
    const key = credentialKey({ teamId: credentials.teamId, keyId: credentials.keyId, privateKey: credentials.privateKey });
    if (!this.apnsToken || this.apnsToken.credentials !== key || this.apnsToken.expiresAt <= Date.now()) {
      this.apnsToken = { credentials: key, value: createApnsJwt(credentials), expiresAt: Date.now() + 50 * 60_000 };
    }
    return this.apnsToken.value;
  }

  private async fcmAccessToken(credentials: FcmCredentials): Promise<string> {
    const key = credentialKey(credentials);
    if (this.fcmToken?.credentials === key && this.fcmToken.expiresAt > Date.now()) return this.fcmToken.value;
    let pending = this.fcmTokenRequest;
    if (!pending || pending.credentials !== key) {
      pending = { credentials: key, promise: createFcmAccessToken(credentials) };
      this.fcmTokenRequest = pending;
    }
    try {
      const token = await pending.promise;
      if (this.fcmTokenRequest === pending) this.fcmToken = { credentials: key, ...token };
      return token.value;
    } finally {
      if (this.fcmTokenRequest === pending) this.fcmTokenRequest = undefined;
    }
  }

  private async markDelivered(id: string, eventId: string): Promise<void> {
    const config = this.config();
    const now = new Date().toISOString();
    const registrations = config.host.mobilePush.registrations.map(item => {
      if (item.id !== id) return item;
      const recentEventIds = [...item.recentEventIds.filter(existing => existing !== eventId), eventId].slice(-MAX_RECENT_EVENTS);
      return { ...item, recentEventIds, updatedAt: now };
    });
    await this.save(configWithRegistrations(config, registrations));
  }

  private async revokeRegistration(id: string, token: string): Promise<void> {
    const config = this.config();
    if (!config.host.mobilePush.registrations.some(item => item.id === id && item.token === token && !item.revokedAt)) return;
    const now = new Date().toISOString();
    await this.save(configWithRegistrations(config, config.host.mobilePush.registrations.map(item => (
      item.id === id ? { ...item, revokedAt: now, updatedAt: now } : item
    ))));
  }

  private config(): RemoteDaemonConfig {
    return normalizeRemoteDaemonConfig(this.configManager.getConfig().remoteDaemon ?? createDefaultRemoteDaemonConfig());
  }
  private async save(config: RemoteDaemonConfig): Promise<void> {
    // Resolve the host at write time: an earlier queued access revocation must
    // never be overwritten by this sender's older configuration snapshot.
    await this.configManager.updateConfigWith(current => {
      const latest = normalizeRemoteDaemonConfig(current.remoteDaemon ?? createDefaultRemoteDaemonConfig());
      const mobilePush = {
        ...config.host.mobilePush,
        panelStates: {},
        registrations: config.host.mobilePush.registrations.filter(item => latest.host.clients.some(client => client.id === item.clientId)),
      };
      return { remoteDaemon: { ...latest, host: { ...latest.host, mobilePush } } };
    });
  }
  private async mutate<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.mutationQueue.then(operation, operation);
    this.mutationQueue = result.then(() => undefined, () => undefined);
    return result;
  }
}

/** Share registration mutations and provider caches across IPC and SSE callers. */
export function getMobilePushSender(configManager: MobilePushConfigManager): MobilePushSender {
  const existing = senderByConfigManager.get(configManager);
  if (existing) return existing;
  const sender = new MobilePushSender(configManager);
  senderByConfigManager.set(configManager, sender);
  return sender;
}

function providerReadiness(platform: RemoteMobilePlatform): Pick<RemoteMobilePushStatus, 'provider' | 'code' | 'message'> {
  if (platform === 'ios') return readApnsCredentials()
    ? { provider: 'ready', code: 'PUSH_READY', message: 'APNs delivery is configured.' }
    : { provider: 'missing-config', code: 'ERR_APNS_NOT_CONFIGURED', message: 'This host has no valid APNs configuration.' };
  return readFcmCredentials()
    ? { provider: 'ready', code: 'PUSH_READY', message: 'FCM delivery is configured.' }
    : { provider: 'missing-config', code: 'ERR_FCM_NOT_CONFIGURED', message: 'This host has no valid FCM service account.' };
}

function configWithRegistrations(config: RemoteDaemonConfig, registrations: RemoteMobilePushRegistration[]): RemoteDaemonConfig {
  return { ...config, host: { ...config.host, mobilePush: { ...config.host.mobilePush, registrations } } };
}
function isEnabled(registration: RemoteMobilePushRegistration, kind: 'needs-input' | 'completed'): boolean {
  return kind === 'needs-input' ? registration.needsInputEnabled : registration.completedEnabled;
}
function isSuccess(status: number): boolean { return status >= 200 && status < 300; }
function isSafeIdentifier(value: string): boolean { return value.length > 0 && value.length <= 200 && /^[a-zA-Z0-9._:-]+$/.test(value); }
// Imported IDs include a user label and a normalized URL, including spaces and slashes.
function isSafeProfileId(value: string): boolean { return value.length > 0 && Buffer.byteLength(value, 'utf8') <= 1024 && !/\p{Cc}/u.test(value); }
function isSafeToken(value: string): boolean { return value.length > 0 && value.length <= 8192; }
function isInvalidTokenResponse(error: ProviderDeliveryError): boolean {
  return error.status === 410 || ((error.status === 400 || error.status === 404) && /BadDeviceToken|Unregistered|registration-token-not-registered/i.test(error.body));
}
function readApnsCredentials(): ApnsCredentials | null {
  const { PANE_APNS_TEAM_ID: teamId, PANE_APNS_KEY_ID: keyId, PANE_APNS_KEY_PATH: keyPath, PANE_APNS_TOPIC: topic, PANE_APNS_ENVIRONMENT: environment } = process.env;
  if (!teamId || !keyId || !keyPath || !topic || (environment !== undefined && environment !== 'sandbox' && environment !== 'production')) return null;
  try {
    return { teamId, keyId, privateKey: readFileSync(keyPath, 'utf8'), topic, environment: environment ?? 'sandbox' };
  } catch { return null; }
}
function createApnsJwt(credentials: ApnsCredentials): string {
  const header = base64url(JSON.stringify({ alg: 'ES256', kid: credentials.keyId }));
  const claims = base64url(JSON.stringify({ iss: credentials.teamId, iat: Math.floor(Date.now() / 1000) }));
  const signer = createSign('SHA256'); signer.update(`${header}.${claims}`); signer.end();
  const signature = signer.sign({ key: createPrivateKey(credentials.privateKey), dsaEncoding: 'ieee-p1363' });
  return `${header}.${claims}.${signature.toString('base64url')}`;
}
const fcmCredentialsSchema = boundary.object({ project_id: boundary.nonEmptyString, client_email: boundary.nonEmptyString, private_key: boundary.nonEmptyString, token_uri: boundary.optional(boundary.nonEmptyString) });
function readFcmCredentials(): FcmCredentials | null {
  const path = process.env.PANE_FCM_SERVICE_ACCOUNT_PATH;
  if (!path) return null;
  try { return decodeBoundary(JSON.parse(readFileSync(path, 'utf8')), fcmCredentialsSchema); } catch { return null; }
}
async function createFcmAccessToken(credentials: FcmCredentials): Promise<AccessToken> {
  const tokenUri = credentials.token_uri ?? 'https://oauth2.googleapis.com/token';
  const now = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = base64url(JSON.stringify({ iss: credentials.client_email, scope: 'https://www.googleapis.com/auth/firebase.messaging', aud: tokenUri, iat: now, exp: now + 3600 }));
  const signer = createSign('RSA-SHA256'); signer.update(`${header}.${claims}`); signer.end();
  const assertion = `${header}.${claims}.${signer.sign(credentials.private_key).toString('base64url')}`;
  const response = await fetch(tokenUri, { method: 'POST', signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS), headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }) });
  const payload = decodeOptionalBoundary(await response.json(), boundary.object({ access_token: boundary.optional(boundary.nonEmptyString), expires_in: boundary.optional(boundary.number) }));
  if (!response.ok || !payload?.access_token) throw new ProviderDeliveryError(response.status, '', 'FCM OAuth exchange failed');
  return { value: payload.access_token, expiresAt: Date.now() + Math.max(0, (payload.expires_in ?? 0) * 1000 - 30_000) };
}
export function createProviderTransport(connect: (authority: string) => ClientHttp2Session = connectHttp2): MobilePushTransport {
  const sessions = new Map<string, { client: ClientHttp2Session; credentialsId: string }>();
  const connection = (environment: 'sandbox' | 'production', credentialsId: string): ClientHttp2Session => {
    const cached = sessions.get(environment);
    if (cached && cached.credentialsId === credentialsId && !cached.client.closed && !cached.client.destroyed) return cached.client;
    cached?.client.close();
    const host = environment === 'production' ? 'https://api.push.apple.com' : 'https://api.sandbox.push.apple.com';
    const client = connect(host);
    const forget = () => { if (sessions.get(environment)?.client === client) sessions.delete(environment); };
    client.on('error', () => { forget(); client.destroy(); });
    client.on('goaway', () => { forget(); client.close(); });
    client.on('close', forget);
    client.unref();
    sessions.set(environment, { client, credentialsId });
    return client;
  };
  return {
    apns: ({ token, jwt, topic, environment, credentialsId, payload }) => new Promise((resolve, reject) => {
      const client = connection(environment, credentialsId);
      // APNs collapse identifiers are limited to 64 bytes.
      const collapseId = createHash('sha256').update(String(payload.eventId)).digest('hex');
      const request = client.request({ ':method': 'POST', ':path': `/3/device/${encodeURIComponent(token)}`, authorization: `bearer ${jwt}`, 'apns-topic': topic, 'apns-push-type': 'alert', 'apns-collapse-id': collapseId });
      let settled = false;
      const finish = (response: ProviderResponse | Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        if (response instanceof Error) {
          request.close();
          reject(response);
        } else resolve(response);
      };
      const timeout = setTimeout(() => finish(new Error('APNs delivery timed out')), PROVIDER_TIMEOUT_MS);
      let body = '';
      request.setEncoding('utf8');
      request.on('response', headers => {
        request.on('data', chunk => { body += chunk; });
        request.on('end', () => finish({ status: Number(headers[':status'] ?? 500), body }));
      });
      request.on('error', finish);
      request.on('close', () => finish(new Error('APNs stream closed before delivery completed')));
      request.end(JSON.stringify(payload));
    }),
    fcm: async ({ accessToken, projectId, payload }) => {
      const response = await fetch(`https://fcm.googleapis.com/v1/projects/${encodeURIComponent(projectId)}/messages:send`, { method: 'POST', signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS), headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
      return { status: response.status, body: await response.text() };
    },
  };
}
function base64url(value: string): string { return Buffer.from(value).toString('base64url'); }

function credentialKey(credentials: FcmCredentials | Pick<ApnsCredentials, 'teamId' | 'keyId' | 'privateKey'>): string {
  return createHash('sha256').update(JSON.stringify(credentials)).digest('hex');
}
