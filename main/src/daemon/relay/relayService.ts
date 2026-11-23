import { createHash, randomInt } from 'crypto';
import { existsSync, mkdirSync, promises as fs, readFileSync, writeFileSync } from 'fs';
import https from 'https';
import net from 'net';
import os from 'os';
import path from 'path';
import tls from 'tls';
import type { RemoteDaemonClientRecord, RemoteRelaySettings } from '../../../../shared/types/remoteDaemon';
import type { RelayComputer, RelayDirectEndpoint, RelayLinkLifetime, RelayPairingInfo, RelayStatus } from '../../../../shared/types/relay';
import { boundary, decodeBoundary } from '../../../../shared/validation/boundaryDecoder';
import { loadComputerKey, type ComputerKey, type KeyStore } from './computerKey';
import {
  CertificateAuthorityUnavailable, CertificateRateLimited, ComputerCertificate, GOOGLE_TRUST_SERVICES_DIRECTORY, GOOGLE_TRUST_SERVICES_STAGING_DIRECTORY,
  LETS_ENCRYPT_DIRECTORY, LETS_ENCRYPT_STAGING_DIRECTORY, type CertificateAuthority, type ExternalAccountKey,
} from './computerCertificate';
import { createComputerTlsServer, type ComputerTlsServer } from './computerTlsServer';
import { computerHost, localAddressHost } from './computerNames';
import { PairingExchange, type PairingExchangeRequest, type PairingExchangeResult, type PairingRefusal } from './pairingExchange';
import { RelayAgent, RelayRequestError, type RelayAgentState, type RelayAlert, type RelayGrantRequest } from './relayAgent';
import { findPaneDirect, PaneDirectProcess } from './paneDirect';
import { DEFAULT_RELAY_DOMAIN } from '../../../../shared/remoteClient/relay';
import { PaneError, reasonOf } from '../../../../shared/paneError';

const PANE_RELAYS = ['us', 'eu', 'asia', 'west'].map((region) => `${region}.relay.${DEFAULT_RELAY_DOMAIN}`);
/** The port same-network phones reach this computer on; another free port when it is taken. */
const LOCAL_PORT = 42138;
const RENEW_CHECK_MS = 12 * 60 * 60_000;
/** Without a valid certificate every connection is refused, so a failed order retries from 1 minute, doubling up to 30. */
const CERTIFICATE_RETRY_FIRST_MS = 60_000;
const CERTIFICATE_RETRY_MAX_MS = 30 * 60_000;
/** Computers a CA turned away all ask again when it said to; up to this much later spreads them out. */
const RATE_LIMIT_SPREAD_MS = 5 * 60_000;
/** A failed start (a locked keychain at launch) retries from 5 seconds, doubling up to 5 minutes. */
const START_RETRY_FIRST_MS = 5_000;
const START_RETRY_MAX_MS = 5 * 60_000;

export interface RelaySecretStore {
  read(key: string): Promise<string | null>;
  write(key: string, value: string): Promise<void>;
}

export interface RelayServiceDeps {
  settings(): RemoteRelaySettings | undefined;
  /** Calls `listener` when the settings or the pairing listener change. */
  onSettingsChanged(listener: () => void): () => void;
  secrets: RelaySecretStore;
  dataDir: string;
  /** The loopback port the pairing listener is bound to, or why it is not listening. */
  pairingListener(): { port: number } | { error: string };
  /** The preview proxy's loopback port for relay names, or null while it is off. */
  previewPort(): number | null;
  displayName(): string;
  addClient(record: RemoteDaemonClientRecord): Promise<void>;
  /** Environment overrides for development and self-tests; `process.env` by default. */
  env?: NodeJS.ProcessEnv;
  /** A development build orders from Let's Encrypt's and Google Trust Services' staging CAs, so test computers never spend the real ones' limits. */
  developmentBuild?: boolean;
  log?(line: string): void;
}

/**
 * Phone access without Tailscale: the computer's key and certificate, its connection to the
 * nearest relay, the local https listener for same-network phones, and one-time QR codes.
 */
export class RelayService {
  private key: ComputerKey | null = null;
  private agent: RelayAgent | null = null;
  private certificate: ComputerCertificate | null = null;
  /** The domain `certificate` was made for. */
  private certificateDomain: string | null = null;
  private terminator: ComputerTlsServer | null = null;
  private localPort: number | null = null;
  private domain: string | null = null;
  private relayHost: string | null = null;
  /** The target the running relay was started for: `''` means Pane's nearest relay. */
  private relayTarget: string | null = null;
  private agentState: RelayAgentState = { status: 'stopped' };
  private lastError: string | null = null;
  /** When the CA takes new computers again, while it turns this one away for its rate limits. */
  private certificateLimitUntil: number | null = null;
  private renewTimer: NodeJS.Timeout | null = null;
  private certificateRetry: NodeJS.Timeout | null = null;
  private certificateFailures = 0;
  private startRetry: NodeJS.Timeout | null = null;
  private startFailures = 0;
  private running: Promise<void> = Promise.resolve();
  private readonly exchange: PairingExchange;
  private readonly listeners = new Set<(status: RelayStatus) => void>();
  private readonly env: NodeJS.ProcessEnv;
  private unsubscribe: (() => void) | null = null;
  /** How to reach the relay's own API: its name, port, the address to dial and any extra CA. */
  private relayApi: { host: string; port: number; connectHost?: string; ca?: Buffer } | null = null;
  /** `pane-direct serve`: the computer's QUIC endpoint, piping each stream to the local TLS listener. */
  private direct: PaneDirectProcess | null = null;
  private directEndpoint: RelayDirectEndpoint | null = null;
  private directMissingLogged = false;

  constructor(private readonly deps: RelayServiceDeps) {
    this.env = deps.env ?? process.env;
    const pendingFile = path.join(deps.dataDir, 'relay', 'pending-links.json');
    this.exchange = new PairingExchange({
      addClient: deps.addClient,
      log: deps.log,
      store: deps.dataDir ? {
        read: () => (existsSync(pendingFile) ? readFileSync(pendingFile, 'utf8') : null),
        write: (text) => {
          mkdirSync(path.dirname(pendingFile), { recursive: true });
          writeFileSync(pendingFile, text, { mode: 0o600 });
        },
      } : undefined,
    });
    const prepared = this.prebootPairing();
    if (prepared) this.exchange.addPrepared(prepared.sha256, prepared.expiresAt);
  }

  /**
   * A file Pane Cloud's host wrote onto a VM's secrets volume before its first boot (D-104), under
   * `$PANE_SECRETS_DIR/relay/`. Pane Cloud's contract names the same paths (PREBOOT_RELAY_FILES).
   */
  private prebootFile(name: 'computer-key.pem' | 'pairing.json'): string | undefined {
    const dir = this.env.PANE_SECRETS_DIR;
    return dir ? path.join(dir, 'relay', name) : undefined;
  }

  /** The first pairing secret the host prepared, by its hash; undefined when there is none or it doesn't read. */
  private prebootPairing(): { sha256: string; expiresAt: number } | undefined {
    const text = readOptionalFile(this.prebootFile('pairing.json'))?.toString('utf8');
    if (!text) return undefined;
    try {
      const prepared = decodeBoundary(JSON.parse(text), boundary.object({ sha256: boundary.nonEmptyString, expiresAt: boundary.nonEmptyString }));
      const expiresAt = Date.parse(prepared.expiresAt);
      if (/^[0-9a-f]{64}$/u.test(prepared.sha256) && Number.isFinite(expiresAt)) return { sha256: prepared.sha256, expiresAt };
      this.deps.log?.('[relay] the pairing secret prepared before boot has no lowercase hex SHA-256 or no readable expiry, so pairing waits for a new link');
      return undefined;
    } catch (error) {
      this.deps.log?.(`[relay] the pairing secret prepared before boot doesn't read, so pairing waits for a new link: ${reasonOf(error)}`);
      return undefined;
    }
  }

  /** The relay key: the one the host made before boot when there is one (D-104), else this computer's own. */
  private relayKeyStore(): KeyStore {
    const own = this.secretStore('relay/computer-key');
    const file = this.prebootFile('computer-key.pem');
    return {
      // Only an absent file falls back to this computer's own key; an unreadable or empty one is an error naming it.
      read: async () => {
        if (!file) return own.read();
        let pem: string;
        try {
          pem = readFileSync(file, 'utf8');
        } catch (error) {
          if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return own.read();
          throw error;
        }
        if (!pem.trim()) throw new Error('the file is empty');
        return pem;
      },
      write: (pem) => own.write(pem),
    };
  }

  start(): void {
    this.unsubscribe = this.deps.onSettingsChanged(() => { this.sync(); });
    this.sync();
  }

  async stop(): Promise<void> {
    this.unsubscribe?.();
    this.unsubscribe = null;
    await this.running;
    if (this.startRetry) clearTimeout(this.startRetry);
    this.startRetry = null;
    await this.shutdown();
  }

  onStatus(listener: (status: RelayStatus) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** True while connected to the relay, so it can carry alerts. */
  isOnline(): boolean {
    return this.agent?.isOnline() === true;
  }

  sendAlert(alert: RelayAlert): Promise<{ status: number; body: string }> {
    if (!this.agent) {
      return Promise.reject(new PaneError('ERR_RELAY_OFF', 'Phone access is off on this computer, so the alert was not sent.', 'Open Settings › Remote Access › Add a device on this computer, which turns phone access on.'));
    }
    return this.agent.sendAlert(alert);
  }

  requestGrant(request: RelayGrantRequest): Promise<{ status: number; body: string }> {
    if (!this.agent) {
      return Promise.reject(new PaneError('ERR_RELAY_OFF', 'Phone access is off on this computer, so the phone could not confirm it for alerts.', 'Open Settings › Remote Access › Add a device on this computer, which turns phone access on.'));
    }
    return this.agent.requestGrant(request);
  }

  /** This computer's relay id, once its key exists. */
  computerId(): string | null {
    return this.key?.id ?? null;
  }

  /** Before the computer sleeps: phones show "Asleep since …". */
  suspend(): void {
    this.agent?.sleep();
    void this.stopDirect();
  }

  resume(): void {
    this.agent?.reconnectNow();
    void this.renewIfDue();
  }

  /** Try again: asks for a missing certificate now instead of at the next scheduled retry. */
  retryNow(): void {
    if (!this.certificateRetry) return;
    clearTimeout(this.certificateRetry);
    this.certificateRetry = null;
    // The old reason clears at once, so Add a device shows the order running.
    this.lastError = null;
    this.certificateLimitUntil = null;
    this.emit();
    void this.renewIfDue();
  }

  getStatus(): RelayStatus {
    const enabled = this.deps.settings()?.enabled === true;
    const listenerError = enabled ? this.listenerError() : null;
    const lastError = listenerError ?? this.lastError;
    const certificate = this.certificate?.getStatus() ?? null;
    const id = this.key?.id ?? null;
    const address = id && this.domain ? `https://${computerHost(id, this.domain)}` : null;
    let phase: RelayStatus['phase'] = 'off';
    if (enabled) {
      if (this.agentState.status !== 'online') phase = 'connecting';
      else if (!this.certificate?.isValid()) phase = 'certificate';
      else phase = 'ready';
      if (listenerError || (this.lastError && phase !== 'ready')) phase = 'error';
    }
    return {
      enabled,
      phase,
      id,
      domain: this.domain,
      address,
      relay: this.relayHost,
      region: this.agentState.status === 'online' ? this.agentState.region : null,
      localAddresses: this.localUrls(),
      certificate,
      lastError,
      certificateLimit: enabled && this.certificateLimitUntil !== null ? { until: new Date(this.certificateLimitUntil).toISOString() } : null,
    };
  }

  /** Why phones can't reach the pairing listener, or null while it listens. */
  private listenerError(): string | null {
    const listener = this.deps.pairingListener();
    if ('port' in listener) return null;
    return `Phones can't connect: this computer's phone listener isn't running (${reasonOf(listener.error)}). In Settings › Remote Access › Tailscale › Advanced, turn on the host listener or give it a free port.`;
  }

  /** A one-time QR code or link, 10 minutes unless the link asks for longer. Throws while the relay is not ready. */
  createPairingCode(lifetime: RelayLinkLifetime = '10m'): RelayPairingInfo {
    const status = this.getStatus();
    if (status.phase !== 'ready' || !status.id || !status.domain) {
      throw new PaneError(
        'ERR_RELAY_NOT_READY',
        status.lastError ? `Phone access is not ready, so no code was made: ${reasonOf(status.lastError)}.` : 'Phone access is still starting, so no code was made.',
        'Try again in a moment; Settings › Remote Access shows when phone access is ready.',
      );
    }
    const { secret, expiresAt } = this.exchange.createSecret(lifetime);
    const fragment = new URLSearchParams({ s: secret, c: status.id, n: this.deps.displayName().slice(0, 60) });
    return { url: `https://${status.domain}/pair#${fragment.toString()}`, expiresAt };
  }

  /** The pairing listener's `POST /pair/preview`: whether a secret would trade, without spending it. */
  checkSecret(secret: string, source: string): { ok: true; expiresAt: string } | PairingRefusal {
    return this.exchange.check(secret, source);
  }

  /** The pairing listener's `POST /pair/exchange`. */
  async exchangeSecret(request: PairingExchangeRequest): Promise<PairingExchangeResult & { computer?: RelayComputer }> {
    const result = await this.exchange.exchange(request);
    if (!result.ok) return result;
    return { ...result, computer: this.computerInfo() };
  }

  /** The client IP behind a connection the TLS terminator forwarded to a loopback listener; null for any other. */
  clientAddress(remoteAddress: string | undefined, remotePort: number | undefined): string | null {
    return this.terminator?.clientAddress(remoteAddress, remotePort) ?? null;
  }

  /** What a paired phone stores about this computer. */
  computerInfo(): RelayComputer | undefined {
    const status = this.getStatus();
    if (!this.key || !status.address || !status.domain) return undefined;
    const computer: RelayComputer = {
      id: this.key.id,
      name: this.deps.displayName(),
      domain: status.domain,
      address: status.address,
      local: status.localAddresses,
      fingerprint: createHash('sha256').update(this.key.spki).digest('base64url'),
    };
    if (this.directEndpoint) computer.direct = this.directEndpoint;
    return computer;
  }

  private emit(): void {
    const status = this.getStatus();
    for (const listener of this.listeners) listener(status);
  }

  private sync(): void {
    this.running = this.running.then(async () => {
      const settings = this.deps.settings();
      const want = settings?.enabled === true ? this.targetRelay(settings) : null;
      if (want === null) {
        await this.shutdown();
      } else if (want !== this.relayTarget || !this.agent) {
        await this.shutdown();
        await this.startup(want);
      }
      this.startFailures = 0;
      this.emit();
    }).catch((cause: unknown) => {
      this.lastError = `${reasonOf(cause)}. Pane tries again by itself; choose Try again to try now.`;
      this.deps.log?.(`[relay] ${this.lastError}`);
      this.emit();
      this.retryStart();
    });
  }

  private retryStart(): void {
    if (this.startRetry || !this.unsubscribe) return;
    const delay = Math.min(START_RETRY_MAX_MS, START_RETRY_FIRST_MS * 2 ** this.startFailures);
    this.startFailures += 1;
    this.startRetry = setTimeout(() => {
      this.startRetry = null;
      this.sync();
    }, delay);
    this.startRetry.unref();
  }

  /** The configured relay address, a development override, or `''` for Pane's nearest relay. */
  private targetRelay(settings: RemoteRelaySettings): string {
    return settings.relayAddress ?? this.env.PANE_RELAY_ADDRESS ?? '';
  }

  private async startup(target: string): Promise<void> {
    this.lastError = null;
    this.key ??= await loadComputerKey(this.relayKeyStore()).catch((cause: unknown) => {
      const file = this.prebootFile('computer-key.pem');
      if (!file || !existsSync(file)) throw cause;
      throw new PaneError(
        'ERR_RELAY_PREBOOT_KEY',
        // The relay status shows only the message, so it carries the next step too.
        `The relay key Pane Cloud's host wrote at ${file} doesn't read (${reasonOf(cause)}), so this VM can't be reached through the relay. Restart the Session from Pane Cloud`,
        'Restart the Session from Pane Cloud; if it happens again, write to Pane Cloud support with the Session name.',
      );
    });
    const key = this.key;
    const { host, port } = target ? parseHostPort(target) : { host: await nearestRelay(PANE_RELAYS), port: 443 };
    this.relayHost = target || host;
    this.relayTarget = target;
    const ca = readOptionalFile(this.env.PANE_RELAY_CA);
    this.relayApi = { host, port, connectHost: this.env.PANE_RELAY_CONNECT_HOST, ca };

    const agent = new RelayAgent({
      relayHost: host,
      relayPort: port,
      connectHost: this.env.PANE_RELAY_CONNECT_HOST,
      key,
      ca,
      displayName: () => this.deps.displayName(),
      localAddresses: () => privateAddresses(),
      onClient: (stream, peer) => {
        // Until the TLS listener exists (the certificate is still loading), the phone retries.
        if (this.terminator) this.terminator.accept(stream, peer);
        else stream.destroy();
      },
      onState: (state) => {
        const cameOnline = state.status === 'online' && this.agentState.status !== 'online';
        this.agentState = state;
        if (state.status === 'online') {
          this.lastError = null;
          if (this.domain !== state.domain) this.domain = state.domain;
          if (cameOnline) {
            this.onOnline().catch((cause: unknown) => {
              this.lastError = `Could not set up this computer's certificate: ${reasonOf(cause)}. Quit and reopen Pane to try again.`;
              this.deps.log?.(`[relay] ${this.lastError}`);
              this.emit();
            });
          }
        } else if (state.status === 'connecting' && state.lastError) {
          this.lastError = `Can't reach ${host}: ${reasonOf(state.lastError)}. Check this computer's internet connection; Pane keeps trying.`;
        }
        this.emit();
      },
      log: this.deps.log,
    });
    this.agent = agent;
    agent.start();
  }

  private async onOnline(): Promise<void> {
    const key = this.key;
    const domain = this.domain;
    if (!key || !domain) return;
    // One certificate per domain: a reconnect while the first order is in flight shares that order.
    if (!this.certificate || this.certificateDomain !== domain) {
      this.certificateDomain = domain;
      const authorities = this.certificateAuthorities();
      // A staging certificate is kept apart, so switching to a trusted CA orders a new one instead of loading it.
      const stagingDirectories = [LETS_ENCRYPT_STAGING_DIRECTORY, GOOGLE_TRUST_SERVICES_STAGING_DIRECTORY];
      const staging = authorities.some((authority) => stagingDirectories.includes(authority.directoryUrl)) ? '.staging' : '';
      this.certificate = new ComputerCertificate({
        key,
        domain,
        certificateStore: fileStore(path.join(this.deps.dataDir, 'relay', `${domain}${staging}.certificate.pem`)),
        authorities,
        setTxt: (values) => this.agent?.setAcmeTxt(values) ?? Promise.reject(new Error('The relay is not connected.')),
        acmeCa: readOptionalFile(this.env.PANE_ACME_CA)?.toString(),
        log: this.deps.log,
      });
      await this.certificate.load();
    }
    if (!this.terminator) {
      const certificate = this.certificate;
      this.terminator = createComputerTlsServer({
        id: key.id,
        domain,
        // An expired certificate is never served: connections wait for the renewal.
        secureContext: () => (certificate.isValid() ? certificate.secureContext() : null),
        // Only to the port this Pane's listener is bound to; while it is down, no connection is accepted, previews included.
        target: (name) => {
          const listener = this.deps.pairingListener();
          if (!('port' in listener)) return null;
          return name.kind === 'server' ? listener.port : this.deps.previewPort();
        },
        log: this.deps.log,
      });
      this.localPort = await this.terminator.listen(LOCAL_PORT, '0.0.0.0')
        .catch(() => this.terminator?.listen(0, '0.0.0.0') ?? null);
    }
    await this.startDirect();
    await this.renewIfDue();
    if (!this.renewTimer) {
      this.renewTimer = setInterval(() => { void this.renewIfDue(); }, RENEW_CHECK_MS);
      this.renewTimer.unref();
    }
  }

  /**
   * Let's Encrypt, then Google Trust Services when Let's Encrypt refuses for its rate limits, with a
   * one-time EAB key from the relay. Development builds use both staging CAs. `PANE_ACME_DIRECTORY`
   * pins one CA (tests, self-tests); `PANE_ACME_FALLBACK_DIRECTORY` adds a fallback to it.
   */
  private certificateAuthorities(): CertificateAuthority[] {
    const pinned = this.env.PANE_ACME_DIRECTORY;
    const development = this.deps.developmentBuild === true;
    const primary: CertificateAuthority = {
      name: "Let's Encrypt",
      directoryUrl: pinned ?? (development ? LETS_ENCRYPT_STAGING_DIRECTORY : LETS_ENCRYPT_DIRECTORY),
      accountStore: this.secretStore('relay/acme-account'),
    };
    const fallbackUrl = this.env.PANE_ACME_FALLBACK_DIRECTORY
      ?? (pinned ? undefined : development ? GOOGLE_TRUST_SERVICES_STAGING_DIRECTORY : GOOGLE_TRUST_SERVICES_DIRECTORY);
    if (!fallbackUrl) return [primary];
    return [primary, {
      name: 'Google Trust Services',
      directoryUrl: fallbackUrl,
      accountStore: this.secretStore('relay/acme-account-gts'),
      // Anything but the trusted CA gets a staging key, so a test never spends a production one.
      externalAccountKey: () => this.externalAccountKey(fallbackUrl !== GOOGLE_TRUST_SERVICES_DIRECTORY),
    }];
  }

  private secretStore(name: string): KeyStore {
    return {
      read: () => this.deps.secrets.read(name),
      write: (value) => this.deps.secrets.write(name, value),
    };
  }

  /**
   * A relay with no keys left for now counts as Google Trust Services refusing; one that has none to
   * give, or doesn't answer (a relay from before EAB keys), makes it unavailable.
   */
  private async externalAccountKey(staging: boolean): Promise<ExternalAccountKey> {
    const agent = this.agent;
    if (!agent) throw new Error('The relay is not connected.');
    try {
      return await agent.externalAccountKey(staging);
    } catch (error) {
      if (!(error instanceof RelayRequestError)) throw error;
      if (error.code === 'throttled') throw new CertificateRateLimited(error.message, null);
      if (error.code === 'unconfigured' || error.code === 'timeout') throw new CertificateAuthorityUnavailable(error.message);
      throw error;
    }
  }

  private async renewIfDue(): Promise<void> {
    // A scheduled retry waits for the CA's time; a reconnect or wake doesn't order early.
    if (!this.certificate || this.agentState.status !== 'online' || this.certificateRetry) return;
    try {
      await this.certificate.ensure();
      this.lastError = null;
      this.certificateLimitUntil = null;
      this.certificateFailures = 0;
    } catch (error) {
      // A valid certificate keeps serving; Remote Access shows the reason days before it matters.
      if (this.certificate.isValid()) {
        this.lastError = `Could not renew this computer's certificate: ${reasonOf(error)}`;
      } else {
        const caTime = error instanceof CertificateRateLimited ? error.retryAt : null;
        const retryAt = this.retryCertificate(caTime);
        this.certificateLimitUntil = error instanceof CertificateRateLimited ? caTime ?? retryAt : null;
        this.lastError = error instanceof CertificateRateLimited && this.certificateLimitUntil !== null
          ? certificateRefused(this.certificateLimitUntil, error.refusedBy)
          : certificateFailed(reasonOf(error), retryAt);
      }
      this.deps.log?.(`[relay] ${this.lastError}`);
    }
    this.emit();
  }

  /** Schedules the next order for a missing certificate, at `at` when the CA named a time; returns when it runs. */
  private retryCertificate(at: number | null): number {
    if (this.certificateRetry) clearTimeout(this.certificateRetry);
    const backoff = Math.min(CERTIFICATE_RETRY_MAX_MS, CERTIFICATE_RETRY_FIRST_MS * 2 ** this.certificateFailures);
    this.certificateFailures += 1;
    const delay = at === null
      ? backoff / 2 + randomInt(Math.ceil(backoff / 2))
      : Math.max(CERTIFICATE_RETRY_FIRST_MS, at - Date.now()) + randomInt(RATE_LIMIT_SPREAD_MS);
    this.certificateRetry = setTimeout(() => {
      this.certificateRetry = null;
      void this.renewIfDue();
    }, delay);
    this.certificateRetry.unref();
    return Date.now() + delay;
  }

  private localUrls(): string[] {
    const id = this.key?.id;
    if (!id || !this.domain || this.localPort === null) return [];
    return privateAddresses().map((address) => `https://${localAddressHost(address, id, this.domain ?? '')}:${this.localPort}`);
  }

  /** Starts `pane-direct serve` once the local TLS listener is up; without the helper, direct paths stay off. */
  private async startDirect(): Promise<void> {
    if (this.direct || this.localPort === null || this.agentState.status !== 'online') return;
    const bin = findPaneDirect(this.env);
    if (!bin) {
      if (!this.directMissingLogged) this.deps.log?.('[relay] pane-direct is not installed, so devices reach this computer through the relay only.');
      this.directMissingLogged = true;
      return;
    }
    const relayUrls = await this.directRelayUrls(this.agentState.region);
    if (this.direct || this.localPort === null || this.agentState.status !== 'online') return;
    const args = ['serve', '--secret-key-file', path.join(this.deps.dataDir, 'relay', 'direct-key'), '--target', `127.0.0.1:${this.localPort}`];
    for (const url of relayUrls) args.push('--relay-url', url);
    const direct = new PaneDirectProcess({
      bin,
      args,
      onEvent: (event) => {
        if (this.direct !== direct) return;
        if (event.t === 'ready' && event.nodeId) this.directEndpoint = { nodeId: event.nodeId, addrs: event.addrs ?? [], relayUrls };
        else if (event.t === 'addrs' && this.directEndpoint) this.directEndpoint = { ...this.directEndpoint, addrs: event.addrs ?? [] };
        else if (event.t === 'exit') this.directEndpoint = null;
      },
      log: this.deps.log,
    });
    this.direct = direct;
    direct.start();
  }

  private async stopDirect(): Promise<void> {
    const direct = this.direct;
    this.direct = null;
    this.directEndpoint = null;
    await direct?.stop();
  }

  /** The iroh relay of this computer's region (`directRelay` in `GET /v1/relays`); none when the relay lists none. */
  private async directRelayUrls(region: string): Promise<string[]> {
    const api = this.relayApi;
    if (!api) return [];
    try {
      const body = await new Promise<string>((resolve, reject) => {
        const request = https.get({
          host: api.connectHost ?? api.host,
          port: api.port,
          servername: api.host,
          headers: { host: api.host },
          path: '/v1/relays',
          ca: api.ca ? [...tls.rootCertificates, api.ca.toString()] : undefined,
          timeout: 5_000,
        }, (response) => {
          let text = '';
          response.setEncoding('utf8');
          response.on('data', (chunk: string) => { text += chunk; });
          response.on('end', () => (response.statusCode === 200 ? resolve(text) : reject(new Error(`HTTP ${response.statusCode}`))));
          response.on('close', () => { if (!response.complete) reject(new Error('the answer was cut off')); });
        });
        request.on('timeout', () => request.destroy(new Error('no answer within 5 s')));
        const deadline = setTimeout(() => request.destroy(new Error('no full answer within 10 s')), 10_000);
        request.on('close', () => clearTimeout(deadline));
        request.on('error', reject);
      });
      const { relays } = decodeBoundary(JSON.parse(body), relayListSchema);
      return relays.flatMap((entry) => (entry.region === region && entry.directRelay ? [entry.directRelay] : []));
    } catch (error) {
      this.deps.log?.(`[relay] ${api.host} did not list its direct relay, so direct paths use local addresses only: ${error instanceof Error ? error.message : String(error)}`);
      return [];
    }
  }

  private async shutdown(): Promise<void> {
    await this.stopDirect();
    if (this.renewTimer) clearInterval(this.renewTimer);
    this.renewTimer = null;
    if (this.certificateRetry) clearTimeout(this.certificateRetry);
    this.certificateRetry = null;
    this.certificateFailures = 0;
    this.certificateLimitUntil = null;
    this.agent?.stop();
    this.agent = null;
    this.agentState = { status: 'stopped' };
    await this.terminator?.close();
    this.terminator = null;
    this.localPort = null;
    this.relayHost = null;
    this.relayTarget = null;
  }
}


/** `GET /v1/relays` (relay/PROTOCOL.md); `directRelay` is absent on relays without one. */
const relayListSchema = boundary.object({
  relays: boundary.array(boundary.object({ region: boundary.string, directRelay: boundary.optional(boundary.string) })),
});

/** A clock time in this computer's locale, such as 2:16 PM. */
function clockTime(at: number): string {
  return new Date(at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

/** The CA turned this computer away for its rate limits until `at`. */
function certificateRefused(at: number, authorities: string[]): string {
  const issuers = authorities.length > 1 ? `${authorities.join(' and ')}, which issue them, are` : `${authorities[0] ?? 'the service'}, which issues them, is`;
  return `Phones can't reach this computer yet: it needs a security certificate, and ${issuers} turning away new computers until ${clockTime(at)}. Keep Add a device open and Pane asks again then, or open it again after that time.`;
}

/** The order failed for another reason; Pane asks again at `at`. */
function certificateFailed(reason: string, at: number): string {
  return `Phones can't reach this computer yet: it could not get its security certificate (${reason}). Pane asks again at ${clockTime(at)} while Add a device is open, or choose Try again.`;
}

function parseHostPort(value: string) {
  const match = /^(.+?)(?::(\d+))?$/u.exec(value.trim());
  return { host: match?.[1] ?? value, port: match?.[2] ? Number(match[2]) : 443 };
}

function readOptionalFile(file: string | undefined): Buffer | undefined {
  if (!file) return undefined;
  try {
    return readFileSync(file);
  } catch {
    return undefined;
  }
}

function fileStore(file: string): KeyStore {
  return {
    read: () => fs.readFile(file, 'utf8').catch(() => null),
    write: async (value) => {
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(`${file}.tmp`, value);
      await fs.rename(`${file}.tmp`, file);
    },
  };
}

const PRIVATE_V4 = [/^10\./u, /^192\.168\./u, /^172\.(1[6-9]|2\d|3[01])\./u, /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./u];

/**
 * Adapters only this computer can reach: Hyper-V's internal switches (WSL, Default Switch) on
 * Windows, and container and VM bridges. Their addresses never answer from another computer.
 */
const HOST_ONLY_ADAPTER = /^(?:vEthernet \((?:WSL|Default Switch)|docker|br-|veth|virbr|vmnet|vboxnet|VirtualBox Host-Only|VMware Network Adapter)/u;

/**
 * This computer's private IPv4 addresses that another computer on its network can reach: Tailscale's
 * 100.x range and host-only adapters are left out.
 */
export function privateAddresses(interfaces: NodeJS.Dict<os.NetworkInterfaceInfo[]> = os.networkInterfaces()): string[] {
  const seen = new Set<string>();
  for (const [name, entries] of Object.entries(interfaces)) {
    if (HOST_ONLY_ADAPTER.test(name)) continue;
    for (const entry of entries ?? []) {
      if (entry.family !== 'IPv4' || entry.internal) continue;
      if (PRIVATE_V4.slice(0, 3).some((pattern) => pattern.test(entry.address))) seen.add(entry.address);
    }
  }
  return [...seen];
}

/** The relay that answers a TCP connect fastest; the first when none answers. */
async function nearestRelay(hosts: string[]): Promise<string> {
  const timings = await Promise.all(hosts.map((host) => new Promise<number>((resolve) => {
    const started = Date.now();
    const socket = net.connect({ host, port: 443 });
    const done = (value: number) => { socket.destroy(); resolve(value); };
    socket.setTimeout(3_000, () => done(Number.POSITIVE_INFINITY));
    socket.once('connect', () => done(Date.now() - started));
    socket.once('error', () => done(Number.POSITIVE_INFINITY));
  })));
  const best = timings.indexOf(Math.min(...timings));
  return hosts[best === -1 ? 0 : best];
}
