import { createHash } from 'crypto';
import { promises as fs, readFileSync } from 'fs';
import net from 'net';
import os from 'os';
import path from 'path';
import type { RemoteDaemonClientRecord, RemoteRelaySettings } from '../../../../shared/types/remoteDaemon';
import type { RelayComputer, RelayPairingInfo, RelayStatus } from '../../../../shared/types/relay';
import { loadComputerKey, type ComputerKey, type KeyStore } from './computerKey';
import { ComputerCertificate, LETS_ENCRYPT_DIRECTORY } from './computerCertificate';
import { createComputerTlsServer, type ComputerTlsServer } from './computerTlsServer';
import { computerHost, localAddressHost } from './computerNames';
import { PairingExchange, type PairedEvent, type PairingExchangeResult } from './pairingExchange';
import { RelayAgent, type RelayAgentState, type RelayAlert } from './relayAgent';

/** Pane's relay domain (D-19). */
const PANE_RELAY_DOMAIN = 'runpane.net';
const PANE_RELAYS = ['us', 'eu', 'asia'].map((region) => `${region}.relay.${PANE_RELAY_DOMAIN}`);
/** The port same-network phones reach this computer on; another free port when it is taken. */
const LOCAL_PORT = 42138;
const RENEW_CHECK_MS = 12 * 60 * 60_000;

export interface RelaySecretStore {
  read(key: string): Promise<string | null>;
  write(key: string, value: string): Promise<void>;
}

export interface RelayServiceDeps {
  settings(): RemoteRelaySettings | undefined;
  onSettingsChanged(listener: () => void): () => void;
  secrets: RelaySecretStore;
  dataDir: string;
  /** The pairing listener's loopback port, or null while it is off. */
  serverPort(): number | null;
  /** The preview proxy's loopback port for relay names, or null while it is off. */
  previewPort(): number | null;
  displayName(): string;
  addClient(record: RemoteDaemonClientRecord): Promise<void>;
  /** Environment overrides for development and self-tests; `process.env` by default. */
  env?: NodeJS.ProcessEnv;
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
  private terminator: ComputerTlsServer | null = null;
  private localPort: number | null = null;
  private domain: string | null = null;
  private relayHost: string | null = null;
  private agentState: RelayAgentState = { status: 'stopped' };
  private lastError: string | null = null;
  private renewTimer: NodeJS.Timeout | null = null;
  private running: Promise<void> = Promise.resolve();
  private readonly exchange: PairingExchange;
  private readonly listeners = new Set<(status: RelayStatus) => void>();
  private readonly env: NodeJS.ProcessEnv;
  private unsubscribe: (() => void) | null = null;

  constructor(private readonly deps: RelayServiceDeps) {
    this.env = deps.env ?? process.env;
    this.exchange = new PairingExchange({ addClient: deps.addClient, log: deps.log });
  }

  start(): void {
    this.unsubscribe = this.deps.onSettingsChanged(() => { this.sync(); });
    this.sync();
  }

  async stop(): Promise<void> {
    this.unsubscribe?.();
    this.unsubscribe = null;
    await this.running;
    await this.shutdown();
  }

  onStatus(listener: (status: RelayStatus) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  onPaired(listener: (event: PairedEvent) => void): () => void {
    return this.exchange.onPaired(listener);
  }

  /** True while connected to the relay, so it can carry alerts. */
  isOnline(): boolean {
    return this.agent?.isOnline() === true;
  }

  sendAlert(alert: RelayAlert): Promise<{ status: number; body: string }> {
    if (!this.agent) return Promise.reject(new Error('Phone access is off on this computer.'));
    return this.agent.sendAlert(alert);
  }

  /** Before the computer sleeps: phones show "Asleep since …". */
  suspend(): void {
    this.agent?.sleep();
  }

  resume(): void {
    this.agent?.reconnectNow();
    void this.renewIfDue();
  }

  getStatus(): RelayStatus {
    const enabled = this.deps.settings()?.enabled === true;
    const certificate = this.certificate?.getStatus() ?? null;
    const id = this.key?.id ?? null;
    const address = id && this.domain ? `https://${computerHost(id, this.domain)}` : null;
    let phase: RelayStatus['phase'] = 'off';
    if (enabled) {
      if (this.agentState.status !== 'online') phase = 'connecting';
      else if (!this.certificate?.isValid()) phase = 'certificate';
      else phase = 'ready';
      if (this.lastError && phase !== 'ready') phase = 'error';
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
      lastError: this.lastError,
    };
  }

  /** A one-time QR code. Throws while the relay is not ready. */
  createPairingCode(): RelayPairingInfo {
    const status = this.getStatus();
    if (status.phase !== 'ready' || !status.id || !status.domain) {
      throw new Error(status.lastError ?? 'Phone access is still starting. Try again in a moment.');
    }
    const { secret, expiresAt } = this.exchange.createSecret();
    const fragment = new URLSearchParams({ s: secret, c: status.id, n: this.deps.displayName().slice(0, 60) });
    return { url: `https://${status.domain}/pair#${fragment.toString()}`, expiresAt };
  }

  /** The pairing listener's `POST /pair/exchange`. */
  async exchangeSecret(secret: string, label: string, phoneId?: string): Promise<PairingExchangeResult & { computer?: RelayComputer }> {
    const result = await this.exchange.exchange(secret, label, phoneId);
    if (!result.ok) return result;
    return { ...result, computer: this.computerInfo() };
  }

  /** What a paired phone stores about this computer. */
  computerInfo(): RelayComputer | undefined {
    const status = this.getStatus();
    if (!this.key || !status.address || !status.domain) return undefined;
    return {
      id: this.key.id,
      name: this.deps.displayName(),
      domain: status.domain,
      address: status.address,
      local: status.localAddresses,
      fingerprint: createHash('sha256').update(this.key.spki).digest('base64url'),
    };
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
      } else if (want !== this.relayHost || !this.agent) {
        await this.shutdown();
        await this.startup(want);
      }
      this.emit();
    }).catch((cause: unknown) => {
      this.lastError = cause instanceof Error ? cause.message : String(cause);
      this.deps.log?.(`[relay] ${this.lastError}`);
      this.emit();
    });
  }

  /** The configured relay address, a development override, or `''` for Pane's nearest relay. */
  private targetRelay(settings: RemoteRelaySettings): string {
    return settings.relayAddress ?? this.env.PANE_RELAY_ADDRESS ?? '';
  }

  private async startup(target: string): Promise<void> {
    this.lastError = null;
    const store = (name: string): KeyStore => ({
      read: () => this.deps.secrets.read(name),
      write: (value) => this.deps.secrets.write(name, value),
    });
    this.key ??= await loadComputerKey(store('relay/computer-key'));
    const key = this.key;
    const { host, port } = target ? parseHostPort(target) : { host: await nearestRelay(PANE_RELAYS), port: 443 };
    this.relayHost = target || host;
    const ca = readOptionalFile(this.env.PANE_RELAY_CA);

    const agent = new RelayAgent({
      relayHost: host,
      relayPort: port,
      connectHost: this.env.PANE_RELAY_CONNECT_HOST,
      key,
      ca,
      displayName: () => this.deps.displayName(),
      localAddresses: () => privateAddresses(),
      onClient: (stream) => this.terminator?.accept(stream),
      onState: (state) => {
        const cameOnline = state.status === 'online' && this.agentState.status !== 'online';
        this.agentState = state;
        if (state.status === 'online') {
          this.lastError = null;
          if (this.domain !== state.domain) this.domain = state.domain;
          if (cameOnline) void this.onOnline();
        } else if (state.status === 'connecting' && state.lastError) {
          this.lastError = `Can't reach ${host}: ${state.lastError}`;
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
    if (!this.certificate || this.certificate.getStatus() === null) {
      this.certificate = new ComputerCertificate({
        key,
        domain,
        certificateStore: fileStore(path.join(this.deps.dataDir, 'relay', `${domain}.certificate.pem`)),
        accountStore: {
          read: () => this.deps.secrets.read('relay/acme-account'),
          write: (value) => this.deps.secrets.write('relay/acme-account', value),
        },
        setTxt: (values) => this.agent?.setAcmeTxt(values) ?? Promise.reject(new Error('The relay is not connected.')),
        directoryUrl: this.env.PANE_ACME_DIRECTORY ?? LETS_ENCRYPT_DIRECTORY,
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
        target: (name) => (name.kind === 'server' ? this.deps.serverPort() : this.deps.previewPort()),
        log: this.deps.log,
      });
      this.localPort = await this.terminator.listen(LOCAL_PORT, '0.0.0.0')
        .catch(() => this.terminator?.listen(0, '0.0.0.0') ?? null);
    }
    await this.renewIfDue();
    if (!this.renewTimer) {
      this.renewTimer = setInterval(() => { void this.renewIfDue(); }, RENEW_CHECK_MS);
      this.renewTimer.unref();
    }
  }

  private async renewIfDue(): Promise<void> {
    if (!this.certificate || this.agentState.status !== 'online') return;
    try {
      await this.certificate.ensure();
      this.lastError = null;
    } catch (error) {
      // A valid certificate keeps serving; Remote Access shows the reason days before it matters.
      this.lastError = `Could not renew this computer's certificate: ${error instanceof Error ? error.message : String(error)}`;
      this.deps.log?.(`[relay] ${this.lastError}`);
    }
    this.emit();
  }

  private localUrls(): string[] {
    const id = this.key?.id;
    if (!id || !this.domain || this.localPort === null) return [];
    return privateAddresses().map((address) => `https://${localAddressHost(address, id, this.domain ?? '')}:${this.localPort}`);
  }

  private async shutdown(): Promise<void> {
    if (this.renewTimer) clearInterval(this.renewTimer);
    this.renewTimer = null;
    this.agent?.stop();
    this.agent = null;
    this.agentState = { status: 'stopped' };
    await this.terminator?.close();
    this.terminator = null;
    this.localPort = null;
    this.relayHost = null;
  }
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

/** This computer's private IPv4 addresses, Tailscale's 100.x CGNAT range excluded for the LAN path. */
function privateAddresses(): string[] {
  const seen = new Set<string>();
  for (const entries of Object.values(os.networkInterfaces())) {
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
