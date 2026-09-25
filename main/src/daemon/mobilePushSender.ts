import { createHash, createPrivateKey, createSign, randomUUID } from 'crypto';
import { readFileSync } from 'fs';
import os from 'os';
import path from 'path';
import { connect as connectHttp2 } from 'http2';
import { boundary, decodeBoundary, decodeOptionalBoundary, type JsonObject } from '../../../shared/validation/boundaryDecoder';
import type { PanelAgentStatusEvent } from '../../../shared/types/agentStatus';
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
export interface MobilePushTransport {
  apns(request: { token: string; jwt: string; topic: string; payload: JsonObject }): Promise<ProviderResponse>;
  fcm(request: { token: string; accessToken: string; projectId: string; payload: JsonObject }): Promise<ProviderResponse>;
}
interface FcmServiceAccountKey { project_id: string; client_email: string; private_key: string; token_uri?: string; }
interface GcloudUserCredentials { client_id: string; client_secret: string; refresh_token: string; }
/** A service-account key file, or keyless impersonation of a sender account through the operator's gcloud login. */
type FcmCredentials =
  | { kind: 'key'; projectId: string; key: FcmServiceAccountKey }
  | { kind: 'impersonation'; projectId: string; serviceAccount: string; user: GcloudUserCredentials };
interface ApnsCredentials { teamId: string; keyId: string; keyPath: string; topic: string; environment: 'sandbox' | 'production'; }
class ProviderDeliveryError extends Error {
  constructor(readonly status: number, readonly body: string, message: string) { super(message); }
}

const MAX_RECENT_EVENTS = 64;
const PROVIDER_TIMEOUT_MS = 15_000;
const senderByConfigManager = new WeakMap<MobilePushConfigManager, MobilePushSender>();

/**
 * Host-owned sender. Its credentials are read only from operator environment
 * variables, never from a pairing payload, remote config, or the mobile app.
 */
export class MobilePushSender {
  private mutationQueue: Promise<void> = Promise.resolve();

  constructor(private readonly configManager: MobilePushConfigManager, private readonly transport: MobilePushTransport = createProviderTransport()) {}

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

  observeStatus(event: PanelAgentStatusEvent): Promise<void> {
    return this.mutate(() => this.processStatus(event));
  }

  private async processStatus(event: PanelAgentStatusEvent): Promise<void> {
    const config = this.config();
    if (!config.host.mobilePush.registrations.some(item => !item.revokedAt && config.host.clients.some(client => client.id === item.clientId))) return;
    const previous = config.host.mobilePush.panelStates[event.panelId];
    const kind = event.state === 'blocked' && previous !== 'blocked'
      ? 'needs-input'
      : previous === 'working' && event.state === 'idle'
        ? 'completed'
        : null;
    if (!kind) {
      if (previous !== event.state) {
        await this.save({
          ...config,
          host: {
            ...config.host,
            mobilePush: {
              ...config.host.mobilePush,
              panelStates: { ...config.host.mobilePush.panelStates, [event.panelId]: event.state },
            },
          },
        });
      }
      return;
    }
    const sequence = config.host.mobilePush.attentionSequence + 1;
    const eventId = `pane:${event.sessionId}:${event.panelId}:${kind}:${sequence}`;
    const updatedConfig: RemoteDaemonConfig = {
      ...config,
      host: { ...config.host, mobilePush: { ...config.host.mobilePush, attentionSequence: sequence, panelStates: { ...config.host.mobilePush.panelStates, [event.panelId]: event.state } } },
    };
    await this.save(updatedConfig);
    for (const registration of updatedConfig.host.mobilePush.registrations) {
      if (registration.revokedAt || !isEnabled(registration, kind)) continue;
      if (!this.config().host.clients.some(client => client.id === registration.clientId)) continue;
      if (registration.recentEventIds.includes(eventId)) continue;
      try {
        await this.deliver(registration, eventId, event, kind);
        await this.markDelivered(registration.id, eventId);
      } catch (error) {
        if (error instanceof ProviderDeliveryError && isInvalidTokenResponse(error)) await this.revokeRegistration(registration.id);
        const status = error instanceof ProviderDeliveryError ? error.status : undefined;
        console.warn('[Pane mobile push] Delivery failed', { platform: registration.platform, status });
      }
    }
  }

  private async deliver(registration: RemoteMobilePushRegistration, eventId: string, event: PanelAgentStatusEvent, kind: 'needs-input' | 'completed'): Promise<void> {
    const title = kind === 'completed' ? 'Pane finished a turn' : 'Pane needs attention';
    const payload: JsonObject = {
      eventId, hostProfileId: registration.hostProfileId, paneId: event.sessionId, panelId: event.panelId,
      aps: { alert: { title, body: 'Open Pane to continue.' }, sound: 'default' },
    };
    if (registration.platform === 'ios') {
      const credentials = readApnsCredentials();
      if (!credentials) throw new ProviderDeliveryError(503, '', 'APNs is not configured');
      const response = await this.transport.apns({ token: registration.token, jwt: createApnsJwt(credentials), topic: credentials.topic, payload });
      if (!isSuccess(response.status)) throw new ProviderDeliveryError(response.status, response.body, 'APNs rejected notification');
      return;
    }
    const credentials = readFcmCredentials();
    if (!credentials) throw new ProviderDeliveryError(503, '', 'FCM is not configured');
    const response = await this.transport.fcm({
      token: registration.token, accessToken: await createFcmAccessToken(credentials), projectId: credentials.projectId,
      payload: { message: { token: registration.token, notification: { title, body: 'Open Pane to continue.' }, data: { eventId, hostProfileId: registration.hostProfileId, paneId: event.sessionId, panelId: event.panelId } } },
    });
    if (!isSuccess(response.status)) throw new ProviderDeliveryError(response.status, response.body, 'FCM rejected notification');
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

  private async revokeRegistration(id: string): Promise<void> {
    const config = this.config();
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

/** One host config has one serial mutation stream across IPC and SSE delivery. */
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
    : { provider: 'missing-config', code: 'ERR_FCM_NOT_CONFIGURED', message: 'This host has no valid FCM sender configuration.' };
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
  try { readFileSync(keyPath, 'utf8'); } catch { return null; }
  return { teamId, keyId, keyPath, topic, environment: environment ?? 'sandbox' };
}
function createApnsJwt(credentials: ApnsCredentials): string {
  const header = base64url(JSON.stringify({ alg: 'ES256', kid: credentials.keyId }));
  const claims = base64url(JSON.stringify({ iss: credentials.teamId, iat: Math.floor(Date.now() / 1000) }));
  const signer = createSign('SHA256'); signer.update(`${header}.${claims}`); signer.end();
  const signature = signer.sign({ key: createPrivateKey(readFileSync(credentials.keyPath, 'utf8')), dsaEncoding: 'ieee-p1363' });
  return `${header}.${claims}.${signature.toString('base64url')}`;
}
const FCM_SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';
const fcmServiceAccountKeySchema = boundary.object({ project_id: boundary.nonEmptyString, client_email: boundary.nonEmptyString, private_key: boundary.nonEmptyString, token_uri: boundary.optional(boundary.nonEmptyString) });
const gcloudUserCredentialsSchema = boundary.object({ type: boundary.literal('authorized_user'), client_id: boundary.nonEmptyString, client_secret: boundary.nonEmptyString, refresh_token: boundary.nonEmptyString });
function readFcmCredentials(): FcmCredentials | null {
  const { PANE_FCM_SERVICE_ACCOUNT_PATH: keyPath, PANE_FCM_IMPERSONATE_SERVICE_ACCOUNT: serviceAccount, PANE_FCM_PROJECT_ID: projectId } = process.env;
  try {
    if (keyPath) {
      const key = decodeBoundary(JSON.parse(readFileSync(keyPath, 'utf8')), fcmServiceAccountKeySchema);
      return { kind: 'key', projectId: key.project_id, key };
    }
    if (serviceAccount && projectId) {
      const user = decodeBoundary(JSON.parse(readFileSync(gcloudApplicationDefaultCredentialsPath(), 'utf8')), gcloudUserCredentialsSchema);
      return { kind: 'impersonation', projectId, serviceAccount, user };
    }
  } catch { return null; }
  return null;
}
/** Where `gcloud auth application-default login` writes the operator's user credentials. */
function gcloudApplicationDefaultCredentialsPath(): string {
  if (process.env.GOOGLE_APPLICATION_CREDENTIALS) return process.env.GOOGLE_APPLICATION_CREDENTIALS;
  const configDirectory = process.platform === 'win32' ? path.join(process.env.APPDATA ?? '', 'gcloud') : path.join(os.homedir(), '.config', 'gcloud');
  return path.join(configDirectory, 'application_default_credentials.json');
}
async function createFcmAccessToken(credentials: FcmCredentials): Promise<string> {
  if (credentials.kind === 'key') return createServiceAccountKeyAccessToken(credentials.key);
  const userToken = await postOAuthToken('https://oauth2.googleapis.com/token', {
    grant_type: 'refresh_token', client_id: credentials.user.client_id, client_secret: credentials.user.client_secret, refresh_token: credentials.user.refresh_token,
  });
  const response = await fetch(`https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${encodeURIComponent(credentials.serviceAccount)}:generateAccessToken`, {
    method: 'POST', signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
    headers: { Authorization: `Bearer ${userToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ scope: [FCM_SCOPE] }),
  });
  const payload = decodeOptionalBoundary(await response.json(), boundary.object({ accessToken: boundary.optional(boundary.nonEmptyString) }));
  if (!response.ok || !payload?.accessToken) throw new ProviderDeliveryError(response.status, '', 'FCM sender impersonation failed');
  return payload.accessToken;
}
function createServiceAccountKeyAccessToken(key: FcmServiceAccountKey): Promise<string> {
  const tokenUri = key.token_uri ?? 'https://oauth2.googleapis.com/token';
  const now = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = base64url(JSON.stringify({ iss: key.client_email, scope: FCM_SCOPE, aud: tokenUri, iat: now, exp: now + 3600 }));
  const signer = createSign('RSA-SHA256'); signer.update(`${header}.${claims}`); signer.end();
  const assertion = `${header}.${claims}.${signer.sign(key.private_key).toString('base64url')}`;
  return postOAuthToken(tokenUri, { grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion });
}
async function postOAuthToken(tokenUri: string, form: Record<string, string>): Promise<string> {
  const response = await fetch(tokenUri, { method: 'POST', signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS), headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(form) });
  const payload = decodeOptionalBoundary(await response.json(), boundary.object({ access_token: boundary.optional(boundary.nonEmptyString) }));
  if (!response.ok || !payload?.access_token) throw new ProviderDeliveryError(response.status, '', 'FCM OAuth exchange failed');
  return payload.access_token;
}
function createProviderTransport(): MobilePushTransport {
  return {
    apns: ({ token, jwt, topic, payload }) => new Promise((resolve, reject) => {
      const host = process.env.PANE_APNS_ENVIRONMENT === 'production' ? 'https://api.push.apple.com' : 'https://api.sandbox.push.apple.com';
      const client = connectHttp2(host);
      let settled = false;
      const finish = (response: ProviderResponse | Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        client.destroy();
        if (response instanceof Error) reject(response);
        else resolve(response);
      };
      const timeout = setTimeout(() => finish(new Error('APNs delivery timed out')), PROVIDER_TIMEOUT_MS);
      client.on('error', finish);
      client.on('close', () => finish(new Error('APNs connection closed before delivery completed')));
      // APNs restricts collapse identifiers to 64 bytes. The opaque event ID
      // can contain UUIDs, so derive a fixed-size, non-sensitive identifier.
      const collapseId = createHash('sha256').update(String(payload.eventId)).digest('hex');
      const request = client.request({ ':method': 'POST', ':path': `/3/device/${encodeURIComponent(token)}`, authorization: `bearer ${jwt}`, 'apns-topic': topic, 'apns-push-type': 'alert', 'apns-collapse-id': collapseId });
      let body = '';
      request.setEncoding('utf8');
      request.on('response', headers => {
        request.on('data', chunk => { body += chunk; });
        request.on('end', () => finish({ status: Number(headers[':status'] ?? 500), body }));
      });
      request.on('error', finish);
      request.end(JSON.stringify(payload));
    }),
    fcm: async ({ accessToken, projectId, payload }) => {
      const response = await fetch(`https://fcm.googleapis.com/v1/projects/${encodeURIComponent(projectId)}/messages:send`, { method: 'POST', signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS), headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
      return { status: response.status, body: await response.text() };
    },
  };
}
function base64url(value: string): string { return Buffer.from(value).toString('base64url'); }
