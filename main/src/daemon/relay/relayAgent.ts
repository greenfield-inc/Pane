import tls from 'tls';
import type { Duplex } from 'stream';
import { signRelayChallenge, type ComputerKey } from './computerKey';

export type RelayAgentState =
  | { status: 'connecting'; attempt: number; lastError: string | null }
  | { status: 'online'; region: string; domain: string }
  | { status: 'stopped' };

export interface RelayAgentOptions {
  /** `<region>.relay.<D>` (or a self-hosted relay's host). */
  relayHost: string;
  relayPort?: number;
  /** The address to dial when it differs from `relayHost` (tests, a relay reached by IP). */
  connectHost?: string;
  key: ComputerKey;
  displayName(): string;
  localAddresses(): string[];
  /** Extra CA certificates to trust (a development relay's own CA). */
  ca?: string | Buffer;
  /** A client's raw TLS stream, starting with its ClientHello. */
  onClient(stream: Duplex, peer: string): void;
  onState?(state: RelayAgentState): void;
  log?(line: string): void;
}

type Frame = { t: string; [field: string]: unknown };

/** A request the relay refused, with its code (`throttled`, `unconfigured`, ...). */
export class RelayRequestError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'RelayRequestError';
  }
}

export type RelayAlert =
  | { platform: 'ios'; token: string; pushType: 'alert' | 'background'; collapseId?: string; payload: object }
  | { platform: 'android'; message: object };

const PING_INTERVAL_MS = 25_000;
const SILENCE_TIMEOUT_MS = 75_000;
const MAX_FRAME_BYTES = 64 * 1024;
const RETRY_MS = [1_000, 2_000, 4_000, 8_000, 16_000, 30_000];

/**
 * The computer's one outgoing control connection to its relay (relay/PROTOCOL.md): proves the
 * computer's key, then opens a data connection for each client the relay announces. Reconnects
 * with backoff up to 30 seconds and never gives up while running.
 */
export class RelayAgent {
  private control: tls.TLSSocket | null = null;
  private stopped = true;
  private attempt = 0;
  private retryTimer: NodeJS.Timeout | null = null;
  private pingTimer: NodeJS.Timeout | null = null;
  private lastHeard = 0;
  private nextRequest = 1;
  private readonly requests = new Map<string, { resolve(frame: Frame): void; reject(error: Error): void }>();
  private state: RelayAgentState = { status: 'stopped' };

  constructor(private readonly options: RelayAgentOptions) {}

  getState(): RelayAgentState {
    return this.state;
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.attempt = 0;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.teardown(new Error('Relay agent stopped'));
    this.setState({ status: 'stopped' });
  }

  /** Reconnects at once, as after waking from sleep or a network change. */
  reconnectNow(): void {
    if (this.stopped) return;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.teardown(new Error('Reconnecting'));
    this.connect();
  }

  /** Tells the relay the computer is going to sleep, so phones show "Asleep". */
  sleep(): void {
    this.send({ t: 'sleep' });
  }

  updateLocalAddresses(): void {
    this.send({ t: 'local', local: this.options.localAddresses() });
  }

  /** Sets the `_acme-challenge` TXT values for this computer's name. */
  async setAcmeTxt(values: string[]): Promise<void> {
    await this.request({ t: 'txt', values });
  }

  /** Delivers a push alert with the Pane app's keys held by the relay (relay/PROTOCOL.md, Alerts). */
  async sendAlert(alert: RelayAlert): Promise<{ status: number; body: string }> {
    const answer = await this.request({ t: 'alert', ...alert });
    return { status: Number(answer.status ?? 0), body: typeof answer.body === 'string' ? answer.body : '' };
  }

  isOnline(): boolean {
    return this.state.status === 'online';
  }

  /** Sends a request frame and waits for its `ok`. */
  request(frame: Frame): Promise<Frame> {
    if (this.state.status !== 'online') return Promise.reject(new Error('The relay is not connected yet.'));
    const req = String(this.nextRequest++);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.requests.delete(req);
        reject(new Error('The relay did not answer within 20 seconds.'));
      }, 20_000);
      this.requests.set(req, {
        resolve: (answer) => { clearTimeout(timer); resolve(answer); },
        reject: (error) => { clearTimeout(timer); reject(error); },
      });
      this.send({ ...frame, req });
    });
  }

  private setState(state: RelayAgentState): void {
    this.state = state;
    this.options.onState?.(state);
  }

  private connect(): void {
    this.attempt += 1;
    this.setState({ status: 'connecting', attempt: this.attempt, lastError: this.state.status === 'connecting' ? this.state.lastError : null });
    let socket: tls.TLSSocket;
    upgrade(this.options, '/v1/agent')
      .then(({ stream }) => {
        socket = stream;
        if (this.stopped) {
          socket.destroy();
          return;
        }
        this.control = socket;
        this.lastHeard = Date.now();
        this.readFrames(socket);
        socket.on('close', () => this.onControlClosed(socket, 'The relay closed the connection.'));
        socket.on('error', (error) => this.onControlClosed(socket, error.message));
        socket.resume();
      })
      .catch((error: Error) => this.scheduleRetry(error.message));
  }

  private readFrames(socket: tls.TLSSocket): void {
    let buffered = '';
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => {
      this.lastHeard = Date.now();
      buffered += chunk;
      if (buffered.length > MAX_FRAME_BYTES && !buffered.includes('\n')) {
        socket.destroy(new Error('The relay sent a frame over 64 KiB.'));
        return;
      }
      let newline: number;
      while ((newline = buffered.indexOf('\n')) !== -1) {
        const line = buffered.slice(0, newline).trim();
        buffered = buffered.slice(newline + 1);
        if (!line) continue;
        let frame: Frame;
        try {
          frame = JSON.parse(line) as Frame;
        } catch {
          continue;
        }
        this.onFrame(frame);
      }
    });
  }

  private onFrame(frame: Frame): void {
    switch (frame.t) {
      case 'challenge': {
        const nonce = typeof frame.nonce === 'string' ? frame.nonce : '';
        this.send({
          t: 'hello',
          v: 1,
          spki: this.options.key.spki.toString('base64url'),
          sig: signRelayChallenge(this.options.key, nonce).toString('base64url'),
          local: this.options.localAddresses(),
          name: this.options.displayName().slice(0, 60),
        });
        return;
      }
      case 'welcome':
        this.attempt = 0;
        this.setState({ status: 'online', region: String(frame.region ?? ''), domain: String(frame.domain ?? '') });
        this.options.log?.(`[relay] connected to ${this.options.relayHost} as ${String(frame.id)}`);
        this.startPings();
        return;
      case 'open':
        if (typeof frame.conn === 'string') this.openData(frame.conn, typeof frame.peer === 'string' ? frame.peer : '');
        return;
      case 'ok':
        this.settle(frame, null);
        return;
      case 'error':
        if (frame.req !== undefined) this.settle(frame, new RelayRequestError(String(frame.code ?? 'error'), String(frame.message ?? frame.code ?? 'Relay error')));
        else this.control?.destroy(new Error(`The relay refused this computer: ${String(frame.message ?? frame.code)}`));
        return;
      case 'ping':
        this.send({ t: 'pong' });
        return;
      case 'close':
        this.options.log?.(`[relay] the relay closed the connection: ${String(frame.code)} ${String(frame.message ?? '')}`);
        this.control?.destroy(new Error(`The relay closed the connection (${String(frame.code)}).`));
        return;
      default:
    }
  }

  private settle(frame: Frame, error: Error | null): void {
    const pending = this.requests.get(String(frame.req));
    if (!pending) return;
    this.requests.delete(String(frame.req));
    if (error) pending.reject(error);
    else pending.resolve(frame);
  }

  private openData(conn: string, peer: string): void {
    upgrade(this.options, `/v1/data/${encodeURIComponent(conn)}`)
      .then(({ stream }) => this.options.onClient(stream, peer))
      .catch((error: Error) => this.options.log?.(`[relay] could not open a data connection: ${error.message}`));
  }

  private startPings(): void {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = setInterval(() => {
      if (Date.now() - this.lastHeard > SILENCE_TIMEOUT_MS) {
        this.control?.destroy(new Error('The relay stopped answering.'));
        return;
      }
      this.send({ t: 'ping' });
    }, PING_INTERVAL_MS);
    this.pingTimer.unref();
  }

  private send(frame: Frame): void {
    if (this.control && !this.control.destroyed) this.control.write(`${JSON.stringify(frame)}\n`);
  }

  private onControlClosed(socket: tls.TLSSocket, reason: string): void {
    if (this.control !== socket) return;
    this.teardown(new Error(reason));
    this.scheduleRetry(reason);
  }

  private teardown(error: Error): void {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = null;
    for (const pending of this.requests.values()) pending.reject(error);
    this.requests.clear();
    const control = this.control;
    this.control = null;
    control?.destroy();
  }

  private scheduleRetry(reason: string): void {
    if (this.stopped || this.retryTimer) return;
    const delay = RETRY_MS[Math.min(this.attempt, RETRY_MS.length) - 1] ?? RETRY_MS[RETRY_MS.length - 1];
    this.setState({ status: 'connecting', attempt: this.attempt, lastError: reason });
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.connect();
    }, delay * (0.8 + Math.random() * 0.4));
    this.retryTimer.unref();
  }
}

/** Opens TLS to the relay and performs the `pane-relay/1` upgrade on `path`. */
function upgrade(options: RelayAgentOptions, path: string): Promise<{ stream: tls.TLSSocket }> {
  return new Promise((resolve, reject) => {
    const socket = tls.connect({
      host: options.connectHost ?? options.relayHost,
      port: options.relayPort ?? 443,
      servername: options.relayHost,
      ca: options.ca ? [...tls.rootCertificates, options.ca.toString()] : undefined,
      ALPNProtocols: ['http/1.1'],
    });
    const timer = setTimeout(() => socket.destroy(new Error(`${options.relayHost} did not answer within 15 seconds.`)), 15_000);
    let head = Buffer.alloc(0);
    const onData = (chunk: Buffer) => {
      head = Buffer.concat([head, chunk]);
      const end = head.indexOf('\r\n\r\n');
      if (end === -1) {
        if (head.length > 16 * 1024) socket.destroy(new Error('The relay sent an oversized answer.'));
        return;
      }
      socket.off('data', onData);
      socket.off('error', onError);
      clearTimeout(timer);
      const statusLine = head.subarray(0, head.indexOf('\r\n')).toString('latin1');
      if (!/^HTTP\/1\.1 101 /u.test(statusLine)) {
        socket.destroy();
        reject(new Error(`The relay refused ${path.startsWith('/v1/data') ? 'a data connection' : 'this computer'}: ${statusLine}`));
        return;
      }
      // Paused, so nothing is emitted before the caller attaches its reader.
      socket.pause();
      const rest = head.subarray(end + 4);
      if (rest.length) socket.unshift(rest);
      resolve({ stream: socket });
    };
    const onError = (error: Error) => {
      clearTimeout(timer);
      reject(error);
    };
    socket.on('data', onData);
    socket.once('error', onError);
    socket.once('secureConnect', () => {
      socket.write(`GET ${path} HTTP/1.1\r\nHost: ${options.relayHost}\r\nUpgrade: pane-relay/1\r\nConnection: Upgrade\r\n\r\n`);
    });
  });
}
