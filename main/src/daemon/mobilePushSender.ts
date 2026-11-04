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
import type { ApnsCredentialConfig } from '../../../shared/types/sharedCredentials';
import type { NotifyItem } from '../../../shared/types/notify';

interface MobilePushConfigManager {
  getConfig(): { remoteDaemon?: RemoteDaemonConfig; apns?: ApnsCredentialConfig };
  updateConfigWith(update: (current: { remoteDaemon?: RemoteDaemonConfig }) => { remoteDaemon: RemoteDaemonConfig }): Promise<{ remoteDaemon?: RemoteDaemonConfig }>;
}

export interface MobilePushRegistrationRequest {
  platform: RemoteMobilePlatform;
  token: string;
  installationId: string;
  hostProfileId: string;
  needsInputEnabled?: boolean;
  completedEnabled?: boolean;
  /** The app build draws Notify's answer buttons itself from a data-only Android message. */
  notifyButtons?: boolean;
}

interface ProviderResponse { status: number; body: string; }
export interface MobilePushTransport {
  /** `background`: a silent update the app handles (a Notify clear), at low priority and with no alert. */
  apns(request: { token: string; jwt: string; topic: string; collapseId: string; payload: JsonObject; pushType?: 'alert' | 'background'; environment: ApnsEnvironment }): Promise<ProviderResponse>;
  fcm(request: { token: string; accessToken: string; projectId: string; payload: JsonObject }): Promise<ProviderResponse>;
}
interface FcmServiceAccountKey { project_id: string; client_email: string; private_key: string; token_uri?: string; }
interface GcloudUserCredentials { client_id: string; client_secret: string; refresh_token: string; }
/** A service-account key file, or keyless impersonation of a sender account through the operator's gcloud login. */
type FcmCredentials =
  | { kind: 'key'; projectId: string; key: FcmServiceAccountKey }
  | { kind: 'impersonation'; projectId: string; serviceAccount: string; user: GcloudUserCredentials };
type ApnsCredentials = ApnsCredentialConfig;
type ApnsEnvironment = ApnsCredentialConfig['environment'];
class ProviderDeliveryError extends Error {
  constructor(readonly status: number, readonly body: string, message: string) { super(message); }
}

const MAX_RECENT_EVENTS = 64;
/** Phones one owner login keeps registered on a host; registering one more drops the oldest. */
const MAX_OWNER_REGISTRATIONS = 10;
/**
 * How long an agent must stay idle after visible work before the phone hears
 * it finished. Measured on Claude Code 2.1.289: the longest idle inside one
 * turn was 3.5 s, on top of the monitor's 10 s settle.
 */
export const STABLE_IDLE_MS = 10_000;
const PROVIDER_TIMEOUT_MS = 15_000;
const senderByConfigManager = new WeakMap<MobilePushConfigManager, MobilePushSender>();

type AttentionKind = 'needs-input' | 'completed';

/** iPhone notification categories the Pane app registers for Notify's answer buttons. */
const NOTIFY_CATEGORIES = { approve: 'pane.notify.approve', ask: 'pane.notify.ask', options: 'pane.notify.options' } as const;
/** Android shows at most three action buttons; an options question with more gets none. */
const NOTIFY_MAX_CHOICE_BUTTONS = 3;

/** A Notify alert's buttons: the iPhone category, plus the choice labels for an options question. */
interface NotifyAlertButtons {
  category?: string;
  choices?: string[];
}

/** The name a Pane's alert is titled with, and the Pane whose alerts it stacks under. */
export interface MobileAlertSubject {
  title: string;
  groupPaneId: string;
}

export interface MobilePushSenderOptions {
  resolveSubject?: (paneId: string) => MobileAlertSubject;
}

/**
 * Host-owned sender. Its credentials are read only from operator environment
 * variables, never from a pairing payload, remote config, or the mobile app.
 */
export class MobilePushSender {
  private mutationQueue: Promise<void> = Promise.resolve();
  /** Panels whose agent visibly worked and has not been reported finished yet. */
  private readonly unreportedWork = new Set<string>();
  /** Panels a person sent a prompt to whose turn has not been reported finished yet. */
  private readonly armed = new Set<string>();
  private readonly finishTimers = new Map<string, ReturnType<typeof setTimeout>>();
  /** Each Notify question's waits so far, and whether it waits now: Undo makes it wait, and alert, again. */
  private readonly questionRounds = new Map<string, { round: number; open: boolean }>();

  constructor(
    private readonly configManager: MobilePushConfigManager,
    private readonly transport: MobilePushTransport = createProviderTransport(),
    private readonly options: MobilePushSenderOptions = {},
  ) {}

  getStatus(clientId: string, platform: RemoteMobilePlatform, installationId: string): RemoteMobilePushStatus {
    const registration = this.config().host.mobilePush.registrations.find(item => (
      item.clientId === clientId && item.platform === platform && item.installationId === installationId && !item.revokedAt
    ));
    const status: RemoteMobilePushStatus = { platform, registration: registration ? 'registered' : 'not-registered', ...providerReadiness(platform, this.configManager.getConfig().apns) };
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
    const readiness = providerReadiness(request.platform, this.configManager.getConfig().apns);
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
    const registration: RemoteMobilePushRegistration = {
      id: previous?.id ?? randomUUID(), clientId, platform: request.platform, token: request.token, installationId: request.installationId,
      hostProfileId: request.hostProfileId, needsInputEnabled: request.needsInputEnabled ?? previous?.needsInputEnabled ?? true,
      completedEnabled: request.completedEnabled ?? previous?.completedEnabled ?? true,
      createdAt: previous?.createdAt ?? now, updatedAt: now, recentEventIds: previous?.recentEventIds ?? [],
    };
    if (request.notifyButtons) registration.notifyButtons = true;
    if (previous?.apnsEnvironment) registration.apnsEnvironment = previous.apnsEnvironment;
    registrations.push(registration);
    await this.save(configWithRegistrations(config, withinOwnerLimit(registrations, clientId)));
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

  /**
   * A person submitted input to this panel, so its next finished turn tells the phone. A finish
   * still settling from the turn before is theirs to see already, so it is dropped.
   */
  arm(panelId: string): void {
    clearTimeout(this.finishTimers.get(panelId));
    this.finishTimers.delete(panelId);
    this.unreportedWork.delete(panelId);
    this.armed.add(panelId);
  }

  /** Terminal input a person typed. Enter submits; ESC CR is a newline inside a pasted prompt. */
  observeInput(panelId: string, data: string): void {
    if (data.endsWith('\r') && !data.endsWith('\x1b\r')) this.arm(panelId);
  }

  observeStatus(event: PanelAgentStatusEvent): Promise<void> {
    // Plain shells go quiet all the time; only agents tell the phone anything.
    if (!event.agentType) return Promise.resolve();
    this.scheduleFinished(event);
    return this.mutate(() => this.processStatus(event));
  }

  /**
   * "Finished" waits for visible work followed by a stable idle: output alone
   * (typing, a redraw) never arms it, and a pause inside a turn re-arms it.
   */
  private scheduleFinished(event: PanelAgentStatusEvent): void {
    clearTimeout(this.finishTimers.get(event.panelId));
    this.finishTimers.delete(event.panelId);
    const ended = event.reason === 'exit' || event.reason === 'destroyed';
    if (ended) this.armed.delete(event.panelId);
    if (ended || event.state === 'blocked') {
      this.unreportedWork.delete(event.panelId);
      return;
    }
    if (event.state !== 'idle') return;
    if (event.workedVisibly) this.unreportedWork.add(event.panelId);
    if (!this.unreportedWork.has(event.panelId)) return;
    this.finishTimers.set(event.panelId, setTimeout(() => {
      this.finishTimers.delete(event.panelId);
      this.unreportedWork.delete(event.panelId);
      // Self-wakes, timers and agent-sent prompts finish silently.
      if (!this.armed.delete(event.panelId)) return;
      void this.mutate(() => this.notify(event, 'completed')).catch(() => {
        console.warn('[Pane mobile push] Could not send a finished alert');
      });
    }, STABLE_IDLE_MS));
  }

  /**
   * A Notify question started waiting (`open`), or stopped: answered, expired, withdrawn. Each
   * phone with Needs Input on gets one alert per wait, titled with the Pane and saying only that
   * it has a question; when it stops, a silent update lets the app remove that alert.
   */
  observeQuestion(event: { item: NotifyItem; open: boolean }): Promise<void> {
    if (event.item.ui === 'info') return Promise.resolve();
    return this.mutate(() => this.processQuestion(event.item, event.open));
  }

  private async processQuestion(item: NotifyItem, open: boolean): Promise<void> {
    const config = this.config();
    if (!hasLiveRegistration(config)) {
      if (open) console.log('[Pane mobile push] No phone is registered for alerts on this computer', { kind: 'question' });
      return;
    }
    const previous = this.questionRounds.get(item.id) ?? { round: 0, open: false };
    if (previous.open === open) return;
    const round = previous.round + (open ? 1 : 0);
    this.questionRounds.set(item.id, { round, open });
    const eventId = `notify:${item.id}:${open ? `ask:${round}` : 'clear'}`;
    for (const registration of config.host.mobilePush.registrations) {
      if (!isLive(config, registration) || !registration.needsInputEnabled) continue;
      if (registration.recentEventIds.includes(eventId)) continue;
      // An Android build that can't draw buttons can't remove its alert either; the system one stays.
      if (!open && registration.platform === 'android' && !registration.notifyButtons) continue;
      try {
        await this.deliverQuestion(registration, eventId, item, open);
        if (open) await this.markDelivered(registration.id, eventId);
        console.log('[Pane mobile push] Delivered', { platform: registration.platform, kind: open ? 'question' : 'question-clear' });
      } catch (error) {
        if (error instanceof ProviderDeliveryError && isInvalidTokenResponse(error)) await this.revokeRegistration(registration.id);
        const status = error instanceof ProviderDeliveryError ? error.status : undefined;
        const reason = error instanceof ProviderDeliveryError ? providerReason(error.body) : undefined;
        console.warn('[Pane mobile push] Delivery failed', { platform: registration.platform, kind: open ? 'question' : 'question-clear', status, reason });
      }
    }
  }

  private async deliverQuestion(registration: RemoteMobilePushRegistration, eventId: string, item: NotifyItem, open: boolean): Promise<void> {
    const title = item.source.name.trim() || 'Pane';
    const body = `${title} has a question`;
    const collapseId = createHash('sha256').update(`notify:${item.id}`).digest('hex');
    const routing: JsonObject = { eventId, hostProfileId: registration.hostProfileId, notifyId: item.id };
    const threadId = item.source.paneId ? this.options.resolveSubject?.(item.source.paneId).groupPaneId ?? item.source.paneId : item.id;
    if (item.source.paneId) {
      routing.paneId = item.source.paneId;
      routing.sessionPaneId = threadId;
    }
    if (item.source.panelId) routing.panelId = item.source.panelId;
    const buttons = notifyButtons(item);
    if (registration.platform === 'ios') {
      const credentials = readApnsCredentials(this.configManager.getConfig().apns);
      if (!credentials) throw new ProviderDeliveryError(503, '', 'APNs is not configured');
      const payload: JsonObject = { ...routing };
      if (open) {
        const aps: JsonObject = { alert: { title, body }, sound: 'default', 'thread-id': threadId };
        payload.notifyUi = item.ui;
        if (buttons.category) aps.category = buttons.category;
        if (buttons.choices) {
          payload.notifyChoices = buttons.choices;
          // The app's notification service extension registers this question's choice buttons.
          aps['mutable-content'] = 1;
        }
        payload.aps = aps;
      } else {
        payload.notifyClear = true;
        payload.aps = { 'content-available': 1 };
      }
      await this.sendApns(registration, credentials, { collapseId, payload, pushType: open ? 'alert' : 'background' });
      return;
    }
    const credentials = readFcmCredentials();
    if (!credentials) throw new ProviderDeliveryError(503, '', 'FCM is not configured');
    // A build that draws buttons builds the alert itself, so it gets data only; older builds get the system alert.
    let message: JsonObject;
    if (!registration.notifyButtons) {
      message = { token: registration.token, notification: { title, body }, android: { notification: { tag: collapseId } }, data: routing };
    } else {
      const data: JsonObject = { ...routing, notifyTag: collapseId };
      if (open) {
        data.notifyUi = item.ui;
        data.notifyTitle = title;
        data.notifyBody = body;
        if (buttons.choices) data.notifyChoices = JSON.stringify(buttons.choices);
      } else {
        data.notifyClear = '1';
      }
      message = { token: registration.token, android: { priority: 'high' }, data };
    }
    const response = await this.transport.fcm({
      token: registration.token, accessToken: await createFcmAccessToken(credentials), projectId: credentials.projectId, payload: { message },
    });
    if (!isSuccess(response.status)) throw new ProviderDeliveryError(response.status, response.body, 'FCM rejected notification');
  }

  private async processStatus(event: PanelAgentStatusEvent): Promise<void> {
    const config = this.config();
    if (!hasLiveRegistration(config)) return;
    const previous = config.host.mobilePush.panelStates[event.panelId];
    const ended = event.reason === 'exit' || event.reason === 'destroyed';
    if (!ended && event.state === 'blocked' && previous !== 'blocked') {
      await this.notify(event, 'needs-input');
      return;
    }
    if (previous !== event.state) await this.save(withPanelState(config, event));
  }

  private async notify(event: PanelAgentStatusEvent, kind: AttentionKind): Promise<void> {
    const config = this.config();
    if (!hasLiveRegistration(config)) return;
    const sequence = config.host.mobilePush.attentionSequence + 1;
    const eventId = `pane:${event.sessionId}:${event.panelId}:${kind}:${sequence}`;
    const updatedConfig = withPanelState(config, event, sequence);
    await this.save(updatedConfig);
    for (const registration of updatedConfig.host.mobilePush.registrations) {
      if (!isLive(this.config(), registration) || !isEnabled(registration, kind)) continue;
      if (registration.recentEventIds.includes(eventId)) continue;
      try {
        await this.deliver(registration, eventId, event, kind);
        await this.markDelivered(registration.id, eventId);
        console.log('[Pane mobile push] Delivered', { platform: registration.platform, kind });
      } catch (error) {
        if (error instanceof ProviderDeliveryError && isInvalidTokenResponse(error)) await this.revokeRegistration(registration.id);
        const status = error instanceof ProviderDeliveryError ? error.status : undefined;
        const reason = error instanceof ProviderDeliveryError ? providerReason(error.body) : undefined;
        console.warn('[Pane mobile push] Delivery failed', { platform: registration.platform, kind, status, reason });
      }
    }
  }

  private async deliver(registration: RemoteMobilePushRegistration, eventId: string, event: PanelAgentStatusEvent, kind: AttentionKind): Promise<void> {
    const subject: MobileAlertSubject = this.options.resolveSubject?.(event.sessionId) ?? { title: '', groupPaneId: event.sessionId };
    const title = subject.title.trim() || 'Pane';
    const body = kind === 'completed' ? `${title} needs your attention` : `${title} is blocked`;
    // One alert per Pane: a newer one replaces the last. They stack under their Session, and the
    // phone clears a Session's alerts with its own.
    const collapseId = createHash('sha256').update(event.sessionId).digest('hex');
    const routing = { eventId, hostProfileId: registration.hostProfileId, paneId: event.sessionId, panelId: event.panelId, sessionPaneId: subject.groupPaneId };
    const payload: JsonObject = { ...routing, aps: { alert: { title, body }, sound: 'default', 'thread-id': subject.groupPaneId } };
    if (registration.platform === 'ios') {
      const credentials = readApnsCredentials(this.configManager.getConfig().apns);
      if (!credentials) throw new ProviderDeliveryError(503, '', 'APNs is not configured');
      await this.sendApns(registration, credentials, { collapseId, payload });
      return;
    }
    const credentials = readFcmCredentials();
    if (!credentials) throw new ProviderDeliveryError(503, '', 'FCM is not configured');
    const response = await this.transport.fcm({
      token: registration.token, accessToken: await createFcmAccessToken(credentials), projectId: credentials.projectId,
      payload: { message: {
        token: registration.token, notification: { title, body },
        android: { notification: { tag: collapseId } },
        data: routing,
      } },
    });
    if (!isSuccess(response.status)) throw new ProviderDeliveryError(response.status, response.body, 'FCM rejected notification');
  }

  /**
   * The phone's build picks its APNs endpoint (a dev client sandbox, TestFlight and the App Store
   * production), not the key. Start where this phone last worked, else at the key's environment;
   * on BadDeviceToken try the other endpoint once, and remember it when it accepts.
   */
  private async sendApns(
    registration: RemoteMobilePushRegistration,
    credentials: ApnsCredentials,
    request: { collapseId: string; payload: JsonObject; pushType?: 'alert' | 'background' },
  ): Promise<void> {
    const first = registration.apnsEnvironment ?? credentials.environment;
    const send = (environment: ApnsEnvironment) => this.transport.apns({
      ...request, token: registration.token, jwt: createApnsJwt(credentials), topic: credentials.topic, environment,
    });
    let response = await send(first);
    if (response.status === 400 && /BadDeviceToken/.test(response.body)) {
      const other: ApnsEnvironment = first === 'production' ? 'sandbox' : 'production';
      const retried = await send(other);
      if (isSuccess(retried.status)) await this.rememberApnsEnvironment(registration.id, other);
      // A second refusal is the one that decides whether the token is revoked.
      response = retried;
    }
    if (!isSuccess(response.status)) throw new ProviderDeliveryError(response.status, response.body, 'APNs rejected notification');
  }

  private async rememberApnsEnvironment(id: string, apnsEnvironment: ApnsEnvironment): Promise<void> {
    const config = this.config();
    await this.save(configWithRegistrations(config, config.host.mobilePush.registrations.map(item => (
      item.id === id ? { ...item, apnsEnvironment } : item
    ))));
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
        registrations: config.host.mobilePush.registrations.filter(item => isOwnerRegistration(item) || latest.host.clients.some(client => client.id === item.clientId)),
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
export function getMobilePushSender(configManager: MobilePushConfigManager, options?: MobilePushSenderOptions): MobilePushSender {
  const existing = senderByConfigManager.get(configManager);
  if (existing) return existing;
  const sender = new MobilePushSender(configManager, undefined, options);
  senderByConfigManager.set(configManager, sender);
  return sender;
}

function providerReadiness(platform: RemoteMobilePlatform, apns: ApnsCredentialConfig | undefined): Pick<RemoteMobilePushStatus, 'provider' | 'code' | 'message'> {
  if (platform === 'ios') return readApnsCredentials(apns)
    ? { provider: 'ready', code: 'PUSH_READY', message: 'APNs delivery is configured.' }
    : { provider: 'missing-config', code: 'ERR_APNS_NOT_CONFIGURED', message: 'This host has no valid APNs configuration.' };
  return readFcmCredentials()
    ? { provider: 'ready', code: 'PUSH_READY', message: 'FCM delivery is configured.' }
    : { provider: 'missing-config', code: 'ERR_FCM_NOT_CONFIGURED', message: 'This host has no valid FCM sender configuration.' };
}

/**
 * The buttons an alert offers, chosen so each makes sense without the question shown: Approve and
 * Deny, Reply, or up to three choices by label, recommended first. Anything else opens the sheet.
 */
function notifyButtons(item: NotifyItem): NotifyAlertButtons {
  if (item.ui === 'approve') return { category: NOTIFY_CATEGORIES.approve };
  if (item.ui === 'ask') return { category: NOTIFY_CATEGORIES.ask };
  // An agent's prompt offers the phone list's Yes and No; the rest of its choices need the card.
  if (item.agentPrompt) return { category: NOTIFY_CATEGORIES.options, choices: [item.agentPrompt.yes, item.agentPrompt.no] };
  const choices = item.choices ?? [];
  if (item.ui !== 'options' || choices.length === 0 || choices.length > NOTIFY_MAX_CHOICE_BUTTONS) return {};
  const ordered = [...choices.filter(choice => choice.recommended), ...choices.filter(choice => !choice.recommended)];
  return { category: NOTIFY_CATEGORIES.options, choices: ordered.map(choice => choice.label) };
}

/**
 * A paired phone's registration lives as long as its client does. One from the owner's Tailscale
 * login was checked when it registered and stays until it is revoked or its token goes dead.
 */
function isLive(config: RemoteDaemonConfig, registration: RemoteMobilePushRegistration): boolean {
  return !registration.revokedAt && (isOwnerRegistration(registration) || config.host.clients.some(client => client.id === registration.clientId));
}
function isOwnerRegistration(registration: RemoteMobilePushRegistration): boolean {
  return registration.clientId.startsWith('tailnet:');
}
function hasLiveRegistration(config: RemoteDaemonConfig): boolean {
  return config.host.mobilePush.registrations.some(item => isLive(config, item));
}
/** Drops the oldest live registrations past the owner limit, so one login cannot grow config without bound. */
function withinOwnerLimit(registrations: RemoteMobilePushRegistration[], clientId: string): RemoteMobilePushRegistration[] {
  if (!clientId.startsWith('tailnet:')) return registrations;
  const live = registrations.filter(item => item.clientId === clientId && !item.revokedAt);
  const dropped = new Set(live.slice(0, Math.max(0, live.length - MAX_OWNER_REGISTRATIONS)).map(item => item.id));
  return registrations.filter(item => !dropped.has(item.id));
}
function withPanelState(config: RemoteDaemonConfig, event: PanelAgentStatusEvent, attentionSequence = config.host.mobilePush.attentionSequence): RemoteDaemonConfig {
  const mobilePush = { ...config.host.mobilePush, attentionSequence, panelStates: { ...config.host.mobilePush.panelStates, [event.panelId]: event.state } };
  return { ...config, host: { ...config.host, mobilePush } };
}
/** APNs `reason` or FCM `status` from an error body, never the token. */
function providerReason(body: string): string | undefined {
  return /"(?:reason|status)"\s*:\s*"([A-Za-z_]+)"/.exec(body)?.[1];
}
function configWithRegistrations(config: RemoteDaemonConfig, registrations: RemoteMobilePushRegistration[]): RemoteDaemonConfig {
  return { ...config, host: { ...config.host, mobilePush: { ...config.host.mobilePush, registrations } } };
}
function isEnabled(registration: RemoteMobilePushRegistration, kind: AttentionKind): boolean {
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
/** The host environment wins; otherwise the credentials saved in host config, which paired devices share. */
function readApnsCredentials(saved: ApnsCredentialConfig | undefined): ApnsCredentials | null {
  const { PANE_APNS_TEAM_ID: teamId, PANE_APNS_KEY_ID: keyId, PANE_APNS_KEY_PATH: keyPath, PANE_APNS_TOPIC: topic, PANE_APNS_ENVIRONMENT: environment } = process.env;
  if (!teamId && !keyId && !keyPath && !topic) return saved ?? null;
  if (!teamId || !keyId || !keyPath || !topic || (environment !== undefined && environment !== 'sandbox' && environment !== 'production')) return null;
  try { return { teamId, keyId, privateKey: readFileSync(keyPath, 'utf8'), topic, environment: environment ?? 'sandbox' }; } catch { return null; }
}
function createApnsJwt(credentials: ApnsCredentials): string {
  const header = base64url(JSON.stringify({ alg: 'ES256', kid: credentials.keyId }));
  const claims = base64url(JSON.stringify({ iss: credentials.teamId, iat: Math.floor(Date.now() / 1000) }));
  const signer = createSign('SHA256'); signer.update(`${header}.${claims}`); signer.end();
  const signature = signer.sign({ key: createPrivateKey(credentials.privateKey), dsaEncoding: 'ieee-p1363' });
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
    apns: ({ token, jwt, topic, collapseId, payload, pushType = 'alert', environment }) => new Promise((resolve, reject) => {
      const host = environment === 'production' ? 'https://api.push.apple.com' : 'https://api.sandbox.push.apple.com';
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
      // APNs requires priority 5 for a background update.
      const request = client.request({
        ':method': 'POST', ':path': `/3/device/${encodeURIComponent(token)}`, authorization: `bearer ${jwt}`, 'apns-topic': topic,
        'apns-push-type': pushType, ...(pushType === 'background' ? { 'apns-priority': '5' } : { 'apns-collapse-id': collapseId }),
      });
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
