// A TCP proxy that drops the link on a schedule shaped like a flapping
// cellular/Tailscale path, for testing remote Pane clients against a dev host.
//
//   node scripts/flapping-link-proxy.mjs --target 127.0.0.1:PORT [--listen 0] [--host 0.0.0.0]
//     [--seed N] [--scale 0.1] [--up 20-60] [--down 5-80] [--long-drop 15] [--refuse 1]
//
// Phases cycle UP -> DOWN -> REFUSING -> UP. Times on the command line are in
// seconds; --scale multiplies every duration (0.1 runs ten times faster).
//
// UP: bytes pass both ways untouched (HTTP, SSE, WebSocket upgrades).
// DOWN: a black hole. Open connections stay open and bytes in both directions
//   are held in memory, never delivered. New connections are accepted but not
//   connected to the target; their bytes are held too. Clients see a hang.
// End of DOWN: a drop shorter than the long-drop threshold (default 15 s)
//   resumes every held connection and delivers its held bytes in order. A
//   longer drop resets them (RST), as if the old path is gone.
// REFUSING (default 1 s after every DOWN): new connections are reset as soon
//   as they are accepted; resumed connections flow.
import { EventEmitter } from 'node:events';
import net from 'node:net';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

/** @typedef {'up' | 'down' | 'refusing'} Phase */
/**
 * @typedef {object} PhaseEvent
 * @property {Phase} phase
 * @property {number} at Date.now() when the phase began
 * @property {number} [durationMs] planned wall-clock length; absent when it lasts until forced
 * @property {number} [dropMs] on 'refusing': how long the DOWN lasted
 * @property {'resumed' | 'reset'} [held] on 'refusing': what happened to held connections
 * @property {number} [connections] on 'refusing': how many connections were held
 */
/**
 * @typedef {object} ProxyOptions
 * @property {string} targetHost
 * @property {number} targetPort
 * @property {number} [listenPort] 0 (default) picks a free port
 * @property {string} [listenHost] default 127.0.0.1; 0.0.0.0 lets phones on the LAN or tailnet reach it
 * @property {[number, number]} [up] UP length range in ms, default [20000, 60000]
 * @property {[number, number]} [down] DOWN length range in ms, default [5000, 80000]
 * @property {Array<[number, number]>} [phases] explicit [upMs, downMs] pairs, cycled; overrides up/down
 * @property {number} [seed] seeds the random schedule so runs repeat
 * @property {number} [scale] multiplies every duration, default 1
 * @property {number} [longDropMs] drops at least this long reset held connections, default 15000
 * @property {number} [refuseMs] REFUSING window after each DOWN, default 1000
 * @property {boolean} [manual] no timer: stay UP until forceDown/forceUp drive the phases
 * @property {(event: PhaseEvent) => void} [onPhase]
 */
/**
 * @typedef {object} FlappingProxy
 * @property {number} port
 * @property {number} seed
 * @property {() => Promise<void>} close
 * @property {() => Phase} phase
 * @property {(ms?: number) => void} forceDown go DOWN now; back UP after ms of wall-clock time, or at forceUp
 * @property {(options?: { resume?: boolean }) => void} forceUp end DOWN now; resume overrides the long-drop rule
 * @property {EventEmitter} events emits 'phase' (PhaseEvent)
 */

const END = Symbol('end');
const CLOSE = Symbol('close');

/** @param {number} seed */
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * @param {ProxyOptions} options
 * @returns {Promise<FlappingProxy>}
 */
export async function start(options) {
  const { targetHost, targetPort, listenPort = 0, listenHost = '127.0.0.1', up = [20_000, 60_000], down = [5_000, 80_000], phases, manual = false } = options;
  const scale = options.scale ?? 1;
  const seed = options.seed ?? Math.floor(Math.random() * 2 ** 32);
  const longDropMs = (options.longDropMs ?? 15_000) * scale;
  const refuseMs = (options.refuseMs ?? 1_000) * scale;
  const random = mulberry32(seed);
  const between = (/** @type {[number, number]} */ [min, max]) => (min + random() * (max - min)) * scale;
  let cycle = 0;
  const nextPair = () => (phases ? phases[cycle++ % phases.length].map((ms) => ms * scale) : [between(up), between(down)]);

  const events = new EventEmitter();
  if (options.onPhase) events.on('phase', options.onPhase);
  /** @type {Phase} */
  let phase = 'up';
  let downSince = 0;
  /** @type {NodeJS.Timeout | undefined} */
  let timer;
  /** @type {Set<Link>} */
  const links = new Set();

  /**
   * @typedef {object} Link
   * @property {net.Socket} client
   * @property {net.Socket | null} target
   * @property {boolean} held
   * @property {Array<['toTarget' | 'toClient', Buffer | symbol]>} queue
   */

  /** @param {Link} link */
  const connectTarget = (link) => {
    const target = net.connect({ host: targetHost, port: targetPort, allowHalfOpen: true });
    link.target = target;
    target.on('data', (chunk) => relay(link, 'toClient', chunk));
    target.on('end', () => relay(link, 'toClient', END));
    target.on('close', () => relay(link, 'toClient', CLOSE));
    target.on('error', () => {});
  };

  /** @param {Link} link @param {'toTarget' | 'toClient'} direction @param {Buffer | symbol} item */
  const relay = (link, direction, item) => {
    if (!links.has(link)) return;
    if (link.held) return void link.queue.push([direction, item]);
    if (item === CLOSE) {
      links.delete(link);
      link.client.destroy();
      link.target?.destroy();
      return;
    }
    const to = direction === 'toTarget' ? link.target : link.client;
    if (item === END) to?.end();
    else to?.write(/** @type {Buffer} */ (item));
  };

  /** @param {Link} link */
  const release = (link) => {
    link.held = false;
    if (!link.target) connectTarget(link);
    for (const [direction, item] of link.queue.splice(0)) relay(link, direction, item);
  };

  const server = net.createServer({ allowHalfOpen: true }, (client) => {
    if (phase === 'refusing') return void client.resetAndDestroy();
    /** @type {Link} */
    const link = { client, target: null, held: phase === 'down', queue: [] };
    links.add(link);
    client.on('data', (chunk) => relay(link, 'toTarget', chunk));
    client.on('end', () => relay(link, 'toTarget', END));
    client.on('close', () => relay(link, 'toTarget', CLOSE));
    client.on('error', () => {});
    if (!link.held) connectTarget(link);
  });

  /** @param {Omit<PhaseEvent, 'at'>} event */
  const enter = (event) => {
    phase = event.phase;
    events.emit('phase', { ...event, at: Date.now() });
  };

  // Each UP and the DOWN after it come from one pair of the schedule.
  const beginUp = () => {
    if (manual) return enter({ phase: 'up' });
    const [upMs, downMs] = nextPair();
    enter({ phase: 'up', durationMs: upMs });
    timer = setTimeout(() => goDown(downMs), upMs);
  };

  /** @param {number} [ms] */
  const goDown = (ms) => {
    clearTimeout(timer);
    downSince = Date.now();
    for (const link of links) link.held = true;
    enter({ phase: 'down', durationMs: ms });
    if (ms !== undefined) timer = setTimeout(goUp, ms);
  };

  /** @param {{ resume?: boolean }} [opts] */
  const goUp = (opts = {}) => {
    if (phase !== 'down') return;
    clearTimeout(timer);
    const dropMs = Date.now() - downSince;
    const resume = opts.resume ?? dropMs < longDropMs;
    const held = [...links];
    for (const link of held) {
      if (resume) {
        release(link);
      } else {
        links.delete(link);
        link.client.resetAndDestroy();
        link.target?.resetAndDestroy();
      }
    }
    enter({ phase: 'refusing', durationMs: refuseMs, dropMs, held: resume ? 'resumed' : 'reset', connections: held.length });
    timer = setTimeout(beginUp, refuseMs);
  };

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(listenPort, listenHost, () => resolve(undefined));
  });
  const port = /** @type {net.AddressInfo} */ (server.address()).port;

  // The opening UP is announced on the next turn, after start() resolves.
  timer = setTimeout(beginUp);

  return {
    port,
    seed,
    events,
    phase: () => phase,
    forceDown: (ms) => goDown(ms),
    forceUp: (opts) => goUp(opts),
    close: () => {
      clearTimeout(timer);
      for (const link of links) {
        link.client.destroy();
        link.target?.destroy();
      }
      links.clear();
      return new Promise((resolve) => server.close(() => resolve()));
    },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { values } = parseArgs({
    options: {
      target: { type: 'string' },
      listen: { type: 'string', default: '0' },
      host: { type: 'string', default: '127.0.0.1' },
      seed: { type: 'string' },
      scale: { type: 'string', default: '1' },
      up: { type: 'string', default: '20-60' },
      down: { type: 'string', default: '5-80' },
      'long-drop': { type: 'string', default: '15' },
      refuse: { type: 'string', default: '1' },
    },
  });
  const match = /^(.+):(\d+)$/.exec(values.target ?? '');
  if (!match) {
    console.error('Usage: node scripts/flapping-link-proxy.mjs --target HOST:PORT [--listen 0] [--seed N] [--scale 0.1]');
    process.exit(2);
  }
  const range = (/** @type {string} */ text) => /** @type {[number, number]} */ (text.split('-').map((s) => Number(s) * 1000));
  const proxy = await start({
    targetHost: match[1],
    targetPort: Number(match[2]),
    listenPort: Number(values.listen),
    listenHost: values.host,
    seed: values.seed === undefined ? undefined : Number(values.seed),
    scale: Number(values.scale),
    up: range(values.up),
    down: range(values.down),
    longDropMs: Number(values['long-drop']) * 1000,
    refuseMs: Number(values.refuse) * 1000,
    onPhase: (e) => {
      const detail = e.phase === 'refusing' ? ` after ${(e.dropMs / 1000).toFixed(1)}s drop, ${e.connections} held connection(s) ${e.held}` : '';
      const length = e.durationMs === undefined ? '' : ` for ${(e.durationMs / 1000).toFixed(1)}s`;
      console.log(`${new Date(e.at).toISOString()} ${e.phase.toUpperCase()}${length}${detail}`);
    },
  });
  console.log(`listening on ${values.host}:${proxy.port} -> ${values.target} (seed ${proxy.seed})`);
  const stop = () => void proxy.close().then(() => process.exit(0));
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}
