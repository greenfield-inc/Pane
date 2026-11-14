import https from 'https';
import type { ClientRequestArgs } from 'http';
import type { Duplex } from 'stream';
import tls from 'tls';
import type { RelayDirectEndpoint } from '../../../../shared/types/relay';
import { pinnedServerIdentity } from './keyPinning';
import { PaneDirectProcess } from './paneDirect';

type PathKind = 'relay' | 'direct';

/** The path new connections use, and how many probes in a row found the other one clearly faster. */
export interface PathChoice {
  path: PathKind;
  streak: number;
}

/** One probe round: each path's round trip in milliseconds, or null when it failed. */
export type PathProbe = Record<PathKind, number | null>;

const PROBES_TO_SWITCH = 3;
/** "Clearly faster": at least 20% and at least 5 ms quicker than the current path. */
const FASTER_RATIO = 0.8;
const FASTER_MS = 5;
const PROBE_INTERVAL_MS = 5_000;
const PROBE_TIMEOUT_MS = 5_000;

const START_ON_RELAY: PathChoice = { path: 'relay', streak: 0 };

/**
 * Probe-and-pick with hysteresis. The other path takes over after it is clearly faster for
 * three probes in a row, or at once when the current path fails a probe the other one passes.
 */
export function choosePath(choice: PathChoice, probe: PathProbe): PathChoice {
  const other: PathKind = choice.path === 'relay' ? 'direct' : 'relay';
  const current = probe[choice.path];
  const alternative = probe[other];
  if (alternative === null) return { path: choice.path, streak: 0 };
  if (current === null) return { path: other, streak: 0 };
  const clearlyFaster = alternative <= current * FASTER_RATIO && current - alternative >= FASTER_MS;
  if (!clearlyFaster) return { path: choice.path, streak: 0 };
  return choice.streak + 1 >= PROBES_TO_SWITCH ? { path: other, streak: 0 } : { path: choice.path, streak: choice.streak + 1 };
}

/** An https agent whose connections go to `pane-direct connect`'s loopback port, keeping the computer's name and key pin. */
class LoopbackAgent extends https.Agent {
  constructor(private readonly port: () => number | null, options: https.AgentOptions) {
    super(options);
  }

  /**
   * `options` are the request's merged with the agent's, as for any https connection. Returns the
   * socket at once, as `net.createConnection` does; the agent waits for it to connect.
   */
  override createConnection(options: ClientRequestArgs & Pick<tls.ConnectionOptions, 'servername' | 'ca' | 'checkServerIdentity'>): Duplex {
    const port = this.port();
    const socket = tls.connect({
      host: '127.0.0.1',
      port: port ?? 0,
      servername: options.servername || (options.host ?? undefined),
      ALPNProtocols: ['http/1.1'],
      ca: options.ca,
      checkServerIdentity: options.checkServerIdentity,
    });
    if (port === null) process.nextTick(() => socket.destroy(new Error('The direct path is not open.')));
    return socket;
  }
}

export interface DirectPathOptions {
  /** The `pane-direct` binary. */
  bin: string;
  /** The computer's address, `https://<id>.<D>/`. */
  baseUrl: URL;
  /** The computer's key fingerprint, checked on both paths. */
  fingerprint: string;
  label: string;
  log?(line: string): void;
}

/**
 * The two ways a desktop reaches a linked computer: through the relay (its public name), or over
 * `pane-direct connect`'s QUIC path. Both end TLS at the computer with the same name and key
 * pin, so the server and its sign-in stay as they are. New connections take the path that
 * `choosePath` picks from probes every 5 s; open ones stay where they are until they close.
 */
export class DirectPath {
  private readonly relayAgent: https.Agent;
  private readonly directAgent: LoopbackAgent;
  private helper: PaneDirectProcess | null = null;
  private endpointKey: string | null = null;
  private port: number | null = null;
  private choice: PathChoice = START_ON_RELAY;
  private probeTimer: NodeJS.Timeout | null = null;
  private probing = false;

  constructor(private readonly options: DirectPathOptions) {
    const checkServerIdentity = pinnedServerIdentity(options.fingerprint, options.label);
    this.relayAgent = new https.Agent({ keepAlive: true, checkServerIdentity });
    this.directAgent = new LoopbackAgent(() => this.port, { keepAlive: true, checkServerIdentity });
  }

  /** The agent for a new connection to the computer. */
  agent(): https.Agent {
    return this.choice.path === 'direct' && this.port !== null ? this.directAgent : this.relayAgent;
  }

  /** Runs `pane-direct connect` for the computer's current endpoint; none stops it. */
  async update(endpoint: RelayDirectEndpoint | undefined): Promise<void> {
    const key = endpoint ? JSON.stringify(endpoint) : null;
    if (key === this.endpointKey && (this.helper || !endpoint)) return;
    await this.stopHelper();
    this.endpointKey = key;
    if (!endpoint) return;
    const args = ['connect', '--node-id', endpoint.nodeId];
    for (const addr of endpoint.addrs) args.push('--direct-addr', addr);
    for (const url of endpoint.relayUrls) args.push('--relay-url', url);
    const helper = new PaneDirectProcess({
      bin: this.options.bin,
      args,
      onEvent: (event) => {
        if (this.helper !== helper) return;
        if (event.t === 'ready' && event.port !== undefined) this.port = event.port;
        else if (event.t === 'exit') this.port = null;
        // The QUIC connection dropped: new connections go through the relay until probes say otherwise.
        if (event.t === 'error' || event.t === 'exit') this.choice = START_ON_RELAY;
      },
      log: this.options.log,
    });
    this.helper = helper;
    helper.start();
    this.probeTimer ??= setInterval(() => { void this.probe(); }, PROBE_INTERVAL_MS);
    this.probeTimer.unref();
  }

  /** Stops the helper and probes; new connections use the relay. */
  async close(): Promise<void> {
    await this.stopHelper();
    this.endpointKey = null;
    this.relayAgent.destroy();
    this.directAgent.destroy();
  }

  private async stopHelper(): Promise<void> {
    if (this.probeTimer) clearInterval(this.probeTimer);
    this.probeTimer = null;
    const helper = this.helper;
    this.helper = null;
    this.port = null;
    this.choice = START_ON_RELAY;
    await helper?.stop();
  }

  private async probe(): Promise<void> {
    if (this.probing || this.port === null) return;
    this.probing = true;
    try {
      const [relay, direct] = await Promise.all([this.roundTrip(this.relayAgent), this.roundTrip(this.directAgent)]);
      const before = this.choice.path;
      this.choice = choosePath(this.choice, { relay, direct });
      if (this.choice.path !== before) this.options.log?.(`[direct] ${this.options.label}: new connections use the ${this.choice.path} path (relay ${relay ?? 'failed'} ms, direct ${direct ?? 'failed'} ms)`);
    } finally {
      this.probing = false;
    }
  }

  /** A GET /health over one path, in milliseconds; null when it fails, answers 5xx or takes over 5 s. */
  private roundTrip(agent: https.Agent): Promise<number | null> {
    const started = performance.now();
    return new Promise((resolve) => {
      const request = https.get(new URL('health', this.options.baseUrl), { agent, timeout: PROBE_TIMEOUT_MS }, (response) => {
        response.resume();
        response.on('end', () => resolve((response.statusCode ?? 500) < 500 ? performance.now() - started : null));
      });
      request.on('timeout', () => request.destroy(new Error('probe timed out')));
      request.on('error', () => resolve(null));
    });
  }
}
