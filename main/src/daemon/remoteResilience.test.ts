import { describe, expect, it, type TestContext } from 'vitest';
import { createDefaultRemoteDaemonConfig } from '../../../shared/types/remoteDaemon';
import { RemoteDaemonClient, createFetchEventStreamTransport } from '../../../shared/remoteClient';
// SAFETY: test tooling in scripts/, typed with JSDoc.
import { start as startFlappingProxy } from '../../../scripts/flapping-link-proxy.mjs';
import type { JsonValue } from '../../../shared/validation/boundaryDecoder';
import { hashRemoteDaemonToken } from './auth';
import { PaneCommandRegistry } from './commandRegistry';
import { PaneRemoteHttpApiServer } from './httpApiServer';
import { RemotePaneClient } from './client/remotePaneClient';

// C1: every write sent through a link that keeps dropping lands on the host exactly once, in order.
// PANE_FLAP_SECONDS=180 runs the plan's full three minutes; CI runs a shorter stretch of the same schedule.
const RUN_MS = Number(process.env.PANE_FLAP_SECONDS ?? 40) * 1000;

type Cleanups = Array<() => Promise<void> | void>;

/** Collects one test's cleanups and runs them, newest first, when that test finishes. */
function cleanupsFor({ onTestFinished }: TestContext): Cleanups {
  const cleanups: Cleanups = [];
  onTestFinished(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  });
  return cleanups;
}

async function startHost(cleanups: Cleanups) {
  const applied = new Map<string, string>();
  const created: string[] = [];
  const registry = new PaneCommandRegistry();
  registry.register('terminal:input', async (panelId: string, data: string) => {
    applied.set(panelId, (applied.get(panelId) ?? '') + data);
    return null;
  });
  registry.register('panels:create', async (name: string) => {
    created.push(name);
    return { id: name };
  });
  const config = createDefaultRemoteDaemonConfig();
  config.host.config = { ...config.host.config, enabled: true, listenHost: '127.0.0.1', listenPort: 0 };
  config.host.clients = [{ id: 'phone', label: 'Phone', createdAt: new Date().toISOString(), tokenHash: hashRemoteDaemonToken('secret-token') }];
  const server = new PaneRemoteHttpApiServer(registry, { getConfig: () => ({ remoteDaemon: config }) }, { heartbeatIntervalMs: 1_000 });
  await server.start();
  cleanups.push(() => server.stop());
  const address = server.getAddress();
  if (!address) throw new Error('host is not listening');
  return { address, applied, created };
}

interface WritingClient {
  invoke(channel: string, args: JsonValue[]): Promise<JsonValue | undefined>;
  /** Every status the client passed through. */
  statuses: Set<string>;
  connected(): boolean;
}

/** Sends a steady stream of keys to two terminals plus pane creates through the proxy, and checks what landed. */
async function runThroughFlappingLink(cleanups: Cleanups, connect: (baseUrl: string) => Promise<WritingClient>): Promise<void> {
  const host = await startHost(cleanups);
  const phases: string[] = [];
  // The bug report's shape, compressed: up 3-8 s, down 1-12 s, drops past 5 s reset open connections.
  const proxy = await startFlappingProxy({
    targetHost: host.address.host, targetPort: host.address.port,
    up: [3_000, 8_000], down: [1_000, 12_000], longDropMs: 5_000, seed: 1169,
    onPhase: (event: { phase: string; held?: string }) => phases.push(event.held ? `${event.phase}:${event.held}` : event.phase),
  });
  cleanups.push(() => proxy.close());
  const client = await connect(`http://127.0.0.1:${proxy.port}`);
  await until(() => client.connected());

  const sent = new Map<string, string>();
  const creates: string[] = [];
  const writes: Array<Promise<JsonValue | undefined>> = [];
  const started = Date.now();
  for (let tick = 0; Date.now() - started < RUN_MS; tick += 1) {
    for (const panelId of ['panel-a', 'panel-b']) {
      const data = `${panelId.at(-1)}${tick};`;
      sent.set(panelId, (sent.get(panelId) ?? '') + data);
      writes.push(client.invoke('terminal:input', [panelId, data]));
    }
    if (tick % 20 === 0) {
      const name = `pane-${tick}`;
      creates.push(name);
      writes.push(client.invoke('panels:create', [name]));
    }
    await sleep(100);
  }

  const results = await Promise.allSettled(writes);
  expect(results.filter(result => result.status === 'rejected')).toEqual([]);
  expect(host.applied).toEqual(sent);
  // Writes outside a terminal carry no order between them, only exactly-once.
  expect([...host.created].sort()).toEqual([...creates].sort());
  expect(client.statuses.has('error')).toBe(false);
  // The run must actually have dropped the link, both briefly and for long enough to reset it.
  expect(phases).toEqual(expect.arrayContaining(['down', 'refusing:resumed', 'refusing:reset']));
  expect(client.statuses.has('reconnecting')).toBe(true);
}

// The two clients soak through separate hosts and proxies, so they run at the same time.
describe.concurrent('writes through a flapping link reach the host exactly once, in order per terminal, and the client never gives up', () => {
  it('from the phone, PWA and glasses client', async (context) => {
    const cleanups = cleanupsFor(context);
    await runThroughFlappingLink(cleanups, async (baseUrl) => {
      const client = new RemoteDaemonClient({
        profile: { id: 'flap', label: 'Host', baseUrl, token: 'secret-token', transport: 'http+sse' },
        transport: createFetchEventStreamTransport((url, init) => globalThis.fetch(url, init)),
        runtimeId: () => 'flap-runtime',
        clientLabel: 'Flap test',
        staleStreamTimeoutMs: 3_000,
      });
      cleanups.push(() => client.disconnect());
      const statuses = new Set<string>();
      client.onStatus(state => statuses.add(state.status));
      await client.connect();
      return { invoke: (channel, args) => client.invoke<JsonValue>(channel, args), statuses, connected: () => client.getState().status === 'connected' };
    });
  }, RUN_MS + 180_000);

  it('from a second desktop', async (context) => {
    const cleanups = cleanupsFor(context);
    await runThroughFlappingLink(cleanups, async (baseUrl) => {
      const statuses = new Set<string>();
      let status = '';
      const client = new RemotePaneClient({ id: 'flap', label: 'Host', baseUrl, token: 'secret-token', transport: 'http+sse' }, {
        heartbeatStaleTimeoutMs: 3_000,
        onConnectionStateChange: (next) => { status = next; statuses.add(next); },
      });
      cleanups.push(() => client.disconnect());
      await client.connect();
      return { invoke: (channel, args) => client.invoke(channel, args), statuses, connected: () => status === 'connected' };
    });
  }, RUN_MS + 180_000);
});

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function until(condition: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('timed out waiting');
    await sleep(50);
  }
}
