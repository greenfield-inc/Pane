import http, { type IncomingMessage, type ServerResponse } from 'http';
import https from 'https';
import tls from 'tls';
import path from 'path';
import { readFileSync } from 'fs';
import { createHash, X509Certificate } from 'crypto';
import { EventEmitter } from 'events';
import net, { type LookupFunction } from 'net';
import { hostname as getOsHostname } from 'os';
import { afterEach, describe, expect, it } from 'vitest';
import { createDefaultRemoteDaemonConfig, type RemoteDaemonConfig, type RemotePaneConnectionState } from '../../../../shared/types/remoteDaemon';
import { primaryProfile } from '../../../../shared/types/remoteComputers';
import type { PaneEventSink } from '../../core/eventSink';
import { RemotePaneClient, RemotePaneClientController } from './remotePaneClient';
import { boundary, decodeBoundary, decodeOptionalBoundary, type JsonValue } from '../../../../shared/validation/boundaryDecoder';
import type { ListeningPortsSnapshot } from '../../../../shared/types/listeningPorts';
import { hashRemoteDaemonToken } from '../auth';
import { PaneCommandRegistry } from '../commandRegistry';
import { PaneRemoteHttpApiServer } from '../httpApiServer';

interface TestRemoteServer {
  baseUrl: string;
  /** Answer this channel the way a host without the command does. */
  refuseChannel(channel: string): void;
  /** Cut off the next `count` invoke responses mid-body; all of them by default. */
  truncateInvoke(count?: number): void;
  /** Answer the next `count` invokes as a proxy with no route to the host does: a 404 page, not Pane's answer. */
  proxyMissInvoke(count: number): void;
  /** Answer each invoke after `ms`. */
  delayInvoke(ms: number): void;
  /** Say in the ready event that this host runs a write once per request id, as P1 hosts do. */
  deduplicateRequestIds(): void;
  /** Every invoke received, in order, with its request id. */
  getInvokes(): Array<{ channel: string; args: JsonValue[]; requestId?: string }>;
  /** The invokes the host ran: a repeated request id runs once. */
  getApplied(): Array<{ channel: string; args: JsonValue[] }>;
  /** Send a heartbeat on the event stream every `ms`; 0 stops them. */
  setHeartbeatInterval(ms: number): void;
  close(): Promise<void>;
  closeEventStream(): void;
  emitDaemonEvent(payload: JsonValue): void;
  getLastInvokeAuth(): string | undefined;
  getLastInvokeBody(): string | undefined;
  getLastInvokeHost(): string | undefined;
  getLastInvokePath(): string | undefined;
  getLastEventsPath(): string | undefined;
  getLastEventsClientDeviceLabel(): string | undefined;
  getEventRequestCount(): number;
  getInvokeCount(): number;
  setEmitReadyEvent(emitReadyEvent: boolean): void;
  setEventsReady(ready: boolean): void;
}

interface RemoteConfigSnapshot {
  remoteDaemon: RemoteDaemonConfig;
}

interface ConfigManagerStub extends EventEmitter {
  getConfig(): RemoteConfigSnapshot;
  setRemoteConfig(remoteDaemon: RemoteDaemonConfig): void;
}

const activeServers: TestRemoteServer[] = [];
const activeControllers: RemotePaneClientController[] = [];

afterEach(async () => {
  // Disconnect before closing the servers: a client still connected reconnects as its server closes.
  for (const controller of activeControllers.splice(0)) await controller.switchToLocalMode();
  while (activeServers.length > 0) {
    await activeServers.pop()?.close();
  }
});

/** A controller that the next afterEach disconnects. */
function createController(): RemotePaneClientController {
  const controller = new RemotePaneClientController();
  activeControllers.push(controller);
  return controller;
}

/** A resolver that knows no names, as macOS is for a ts.net host before Tailscale answers. */
const resolvesNothing: LookupFunction = (hostname, _options, callback) => {
  const error: NodeJS.ErrnoException = Object.assign(new Error(`getaddrinfo ENOTFOUND ${hostname}`), { code: 'ENOTFOUND' });
  queueMicrotask(() => callback(error, '', 0));
};

describe('RemotePaneClient', () => {
  it('sends authenticated invoke requests to the remote daemon', async () => {
    const server = await createTestRemoteServer();
    activeServers.push(server);

    const client = new RemotePaneClient({
      id: 'profile-1',
      label: 'Mac mini',
      baseUrl: server.baseUrl,
      token: 'secret-token',
      transport: 'http+sse',
    });

    await expect(client.invoke('sessions:get-all', ['session-1'])).resolves.toEqual({
      channel: 'sessions:get-all',
      args: ['session-1'],
    });

    expect(server.getLastInvokeAuth()).toBe('Bearer secret-token');
    expect(server.getLastInvokeBody()).toBe(JSON.stringify({
      channel: 'sessions:get-all',
      args: ['session-1'],
    }));
  });

  it('fails only a truncated mutation while the stream is up, and never replays it', async () => {
    const server = await createTestRemoteServer();
    activeServers.push(server);
    const states: string[] = [];
    const client = new RemotePaneClient({ id: 'truncated', label: 'host', baseUrl: server.baseUrl, token: '', transport: 'http+sse' }, {
      onConnectionStateChange: status => states.push(status),
    });
    await client.connect();
    server.truncateInvoke();
    await expect(client.invoke('panels:input', ['panel', 'hello'])).rejects.toThrow('Delivery unknown');
    expect(server.getInvokeCount()).toBe(1);
    expect(states.at(-1)).toBe('connected');
    expect(server.getEventRequestCount()).toBe(1);
    await client.disconnect();
  });

  it('keeps the stream up through a slow request while heartbeats arrive, and drops it when they stop', async () => {
    // Scaled from the plan: heartbeats every 5 s, silence limit 20 s, request limit 15 s, host answers after 20 s.
    const server = await createTestRemoteServer();
    activeServers.push(server);
    const states: string[] = [];
    const client = new RemotePaneClient({ id: 'slow', label: 'host', baseUrl: server.baseUrl, token: '', transport: 'http+sse' }, {
      heartbeatStaleTimeoutMs: 200,
      requestTimeoutMs: 150,
      onConnectionStateChange: status => states.push(status),
    });
    server.setHeartbeatInterval(50);
    await client.connect();
    server.delayInvoke(200);

    await expect(client.invoke('terminal:setVisibility', ['panel', true, 'viewer'])).rejects.toMatchObject({ code: 'ERR_REMOTE_TRANSPORT' });
    await sleep(300);
    expect(states.at(-1)).toBe('connected');
    expect(server.getEventRequestCount()).toBe(1);

    server.setHeartbeatInterval(0);
    await waitFor(() => states.at(-1) === 'reconnecting');
    await client.disconnect();
  });

  it('reconnects after three failed requests in a row', async () => {
    const server = await createTestRemoteServer();
    activeServers.push(server);
    const states: string[] = [];
    const client = new RemotePaneClient({ id: 'three', label: 'host', baseUrl: server.baseUrl, token: '', transport: 'http+sse' }, {
      onConnectionStateChange: status => states.push(status),
    });
    await client.connect();
    server.truncateInvoke();
    const setVisibility = () => client.invoke('terminal:setVisibility', ['panel', true, 'viewer']);
    await expect(setVisibility()).rejects.toThrow('Remote connection interrupted');
    await expect(setVisibility()).rejects.toThrow('Remote connection interrupted');
    expect(states.at(-1)).toBe('connected');
    await expect(setVisibility()).rejects.toThrow('Pane is reconnecting');
    expect(states.at(-1)).toBe('reconnecting');
    await client.disconnect();
  });

  it('retries a cut-off read after 250 and 750 ms without reconnecting', async () => {
    const server = await createTestRemoteServer();
    activeServers.push(server);
    const states: string[] = [];
    const client = new RemotePaneClient({ id: 'retry', label: 'host', baseUrl: server.baseUrl, token: '', transport: 'http+sse' }, {
      onConnectionStateChange: status => states.push(status),
    });
    await client.connect();
    server.truncateInvoke(2);
    const started = Date.now();

    await expect(client.invoke('sessions:get-all', [])).resolves.toMatchObject({ channel: 'sessions:get-all' });
    // 250 + 750 ms, less up to 20 % jitter and clock granularity.
    expect(Date.now() - started).toBeGreaterThanOrEqual(790);
    expect(server.getInvokeCount()).toBe(3);
    expect(states.at(-1)).toBe('connected');
    expect(server.getEventRequestCount()).toBe(1);
    await client.disconnect();
  });

  it('finishes a restoration slower than the handshake limit instead of reconnecting', async () => {
    // Scaled from the plan: handshake limit 10 s, restoration limit 30 s, restoration takes 15 s.
    const server = await createTestRemoteServer();
    activeServers.push(server);
    const states: string[] = [];
    const client = new RemotePaneClient({ id: 'slow-restore', label: 'host', baseUrl: server.baseUrl, token: '', transport: 'http+sse' }, {
      initialHandshakeTimeoutMs: 100,
      restoreTimeoutMs: 300,
      onConnectionStateChange: status => states.push(status),
      onResyncRequired: () => sleep(150),
    });
    await client.connect();
    expect(states).toEqual(['connecting', 'restoring', 'connected']);
    expect(server.getEventRequestCount()).toBe(1);
    await client.disconnect();
  });

  it('reports truncated viewer bookkeeping as an interruption, not unknown delivery', async () => {
    const server = await createTestRemoteServer();
    activeServers.push(server);
    const client = new RemotePaneClient({ id: 'bookkeeping', label: 'host', baseUrl: server.baseUrl, token: '', transport: 'http+sse' });
    await client.connect();
    server.truncateInvoke();
    await expect(client.invoke('terminal:setVisibility', ['panel', true, 'viewer'])).rejects.toThrow(/^Remote connection interrupted:/);
    await client.disconnect();
  });

  it('waits for restoration before connected and ignores restoration after disconnect', async () => {
    const server = await createTestRemoteServer();
    activeServers.push(server);
    const states: string[] = [];
    let finish!: () => void;
    const restored = new Promise<void>(resolve => { finish = resolve; });
    const client = new RemotePaneClient({ id: 'restore', label: 'host', baseUrl: server.baseUrl, token: '', transport: 'http+sse' }, {
      onConnectionStateChange: status => states.push(status),
      onResyncRequired: () => restored,
    });
    const connecting = client.connect();
    await waitFor(() => states.includes('restoring'));
    expect(states).not.toContain('connected');
    await client.disconnect();
    finish();
    await connecting;
    expect(states).not.toContain('connected');
  });

  it('falls back to a stored Tailscale IP when macOS cannot resolve a ts.net host', async () => {
    const server = await createTestRemoteServer();
    activeServers.push(server);
    const serverUrl = new URL(server.baseUrl);
    const tailscaleHost = 'pane-unresolvable-for-test.invalid.ts.net';

    const client = new RemotePaneClient({
      id: 'profile-tailscale-fallback',
      label: 'WSL',
      baseUrl: `http://${tailscaleHost}:${serverUrl.port}`,
      token: 'secret-token',
      transport: 'http+sse',
      tunnel: {
        kind: 'tailscale',
        selected: true,
        tailscaleIp: '127.0.0.1',
      },
    }, { dnsLookup: resolvesNothing });

    await expect(client.invoke('sessions:get-all', ['session-1'])).resolves.toEqual({
      channel: 'sessions:get-all',
      args: ['session-1'],
    });

    expect(server.getLastInvokeAuth()).toBe('Bearer secret-token');
    expect(server.getLastInvokeHost()).toBe(`${tailscaleHost}:${serverUrl.port}`);
    await client.disconnect();
  });

  it('forwards remote daemon SSE events through the provided renderer sink', async () => {
    const server = await createTestRemoteServer();
    activeServers.push(server);
    const receivedEvents: Array<{ channel: string; args: unknown[] }> = [];

    const eventSink: PaneEventSink = {
      send(channel, ...args) {
        receivedEvents.push({ channel, args });
      },
    };

    const client = new RemotePaneClient({
      id: 'profile-2',
      label: 'Workstation',
      baseUrl: server.baseUrl,
      token: 'secret-token',
      transport: 'http+sse',
    }, { eventSink });

    await client.connect();
    server.emitDaemonEvent({
      channel: 'session:created',
      args: [{ id: 'session-1' }],
      timestamp: new Date().toISOString(),
    });

    await waitFor(() => receivedEvents.length === 1);
    expect(receivedEvents).toEqual([{
      channel: 'session:created',
      args: [{ id: 'session-1' }],
    }]);
    expect(server.getLastEventsClientDeviceLabel()).toBe(getOsHostname().slice(0, 80));

    await client.disconnect();
  });

  it('supports IPv6 loopback connection profiles', async () => {
    const server = await createTestRemoteServer('::1');
    activeServers.push(server);

    const client = new RemotePaneClient({
      id: 'profile-ipv6',
      label: 'IPv6 host',
      baseUrl: server.baseUrl,
      token: 'secret-token',
      transport: 'http+sse',
    });

    await expect(client.invoke('sessions:get-all', ['session-1'])).resolves.toEqual({
      channel: 'sessions:get-all',
      args: ['session-1'],
    });

    expect(server.getLastInvokeAuth()).toBe('Bearer secret-token');
  });

  it('preserves reverse-proxy base path prefixes for invoke and event routes', async () => {
    const server = await createTestRemoteServer('127.0.0.1', '/pane');
    activeServers.push(server);
    const receivedEvents: Array<{ channel: string; args: unknown[] }> = [];

    const client = new RemotePaneClient({
      id: 'profile-subpath',
      label: 'Reverse proxy',
      baseUrl: server.baseUrl,
      token: 'secret-token',
      transport: 'http+sse',
    }, {
      eventSink: {
        send(channel, ...args) {
          receivedEvents.push({ channel, args });
        },
      },
    });

    await client.connect();
    await expect(client.invoke('sessions:get-all', ['session-1'])).resolves.toEqual({
      channel: 'sessions:get-all',
      args: ['session-1'],
    });

    server.emitDaemonEvent({
      channel: 'session:updated',
      args: [{ id: 'session-1', status: 'running' }],
      timestamp: new Date().toISOString(),
    });

    await waitFor(() => receivedEvents.length === 1);
    expect(server.getLastInvokePath()).toBe('/pane/invoke');
    expect(server.getLastEventsPath()).toBe('/pane/events');
    expect(receivedEvents).toEqual([{
      channel: 'session:updated',
      args: [{ id: 'session-1', status: 'running' }],
    }]);

    await client.disconnect();
  });

  it('times out event streams that never emit the initial ready event', async () => {
    const server = await createTestRemoteServer();
    activeServers.push(server);
    server.setEmitReadyEvent(false);
    const connectionStates: string[] = [];

    const client = new RemotePaneClient({
      id: 'profile-timeout',
      label: 'Buffered proxy',
      baseUrl: server.baseUrl,
      token: 'secret-token',
      transport: 'http+sse',
    }, {
      initialHandshakeTimeoutMs: 25,
      onConnectionStateChange(status) {
        connectionStates.push(status);
      },
    });

    await expect(client.connect({ retryOnInitialFailure: false })).rejects.toThrow(
      'Timed out waiting for remote daemon ready event after 25ms',
    );
    expect(connectionStates).toContain('connecting');
    expect(connectionStates).toContain('error');

    await client.disconnect();
  });

  it('retries stale remote event streams until the outage deadline', async () => {
    const server = await createTestRemoteServer();
    activeServers.push(server);
    const connectionStates: Array<{ status: string; errorMessage: string | null | undefined }> = [];

    const client = new RemotePaneClient({
      id: 'profile-reconnect-threshold',
      label: 'Remote host',
      baseUrl: server.baseUrl,
      token: 'secret-token',
      transport: 'http+sse',
    }, {
      heartbeatStaleTimeoutMs: 20,
      reconnectMaxDelayMs: 20,
      reconnectDurationMs: 400,
      onConnectionStateChange(status, errorMessage) {
        connectionStates.push({ status, errorMessage });
      },
    });

    await client.connect({ retryOnInitialFailure: false });
    const outageStarted = Date.now();
    server.setEventsReady(false);

    await waitFor(() => connectionStates.some((state) => state.status === 'error'), 3_000);

    // The client gives up at the outage deadline, not before, and keeps retrying until then.
    // Timer resolution varies by OS (about 16 ms on Windows), so the attempt count is only a floor.
    expect(Date.now() - outageStarted).toBeGreaterThanOrEqual(390);
    const firstErrorIndex = connectionStates.findIndex((state) => state.status === 'error');
    expect(connectionStates.slice(0, firstErrorIndex).filter((state) => state.status === 'reconnecting').length)
      .toBeGreaterThanOrEqual(3);
    expect(connectionStates[firstErrorIndex].errorMessage).toContain('Could not reconnect');

    await client.disconnect();
  });

  it('never gives up on a computer reached through a relay, and reconnects when it answers again', async () => {
    const server = await createTestRemoteServer();
    activeServers.push(server);
    const connectionStates: string[] = [];

    const client = new RemotePaneClient({
      id: 'profile-relay-outage',
      label: 'Studio Mac',
      baseUrl: server.baseUrl,
      token: 'secret-token',
      transport: 'http+sse',
      relay: { computerId: 'studio', fingerprint: 'unused-over-http' },
    }, {
      heartbeatStaleTimeoutMs: 20,
      reconnectMaxDelayMs: 20,
      reconnectDurationMs: 100,
      onConnectionStateChange(status) {
        connectionStates.push(status);
      },
    });

    await client.connect({ retryOnInitialFailure: false });
    server.setEventsReady(false);

    // Well past the outage budget a tailnet profile gives up at, it is still retrying.
    await sleep(400);
    expect(connectionStates).not.toContain('error');
    const attempts = server.getEventRequestCount();
    await sleep(100);
    expect(server.getEventRequestCount()).toBeGreaterThan(attempts);

    server.setEventsReady(true);
    await waitFor(() => connectionStates.at(-1) === 'connected');

    await client.disconnect();
  });

  it('stays quiet while suspended for system sleep and reconnects on resume', async () => {
    const server = await createTestRemoteServer();
    activeServers.push(server);
    const connectionStates: string[] = [];

    const client = new RemotePaneClient({
      id: 'profile-sleep',
      label: 'Remote host',
      baseUrl: server.baseUrl,
      token: 'secret-token',
      transport: 'http+sse',
    }, {
      heartbeatStaleTimeoutMs: 20,
      reconnectMaxDelayMs: 20,
      onConnectionStateChange(status) {
        connectionStates.push(status);
      },
    });

    await client.connect({ retryOnInitialFailure: false });
    client.suspend();
    const statesAtSuspend = connectionStates.length;

    // Several heartbeat and backoff windows pass while the machine sleeps.
    await sleep(150);
    expect(server.getEventRequestCount()).toBe(1);
    expect(connectionStates.slice(statesAtSuspend)).toEqual([]);

    client.resume();
    await waitFor(() => server.getEventRequestCount() === 2);
    await waitFor(() => connectionStates.at(-1) === 'connected');

    await client.disconnect();
  });

  it('ignores the suspended stream closing after an immediate resume', async () => {
    const server = await createTestRemoteServer();
    activeServers.push(server);
    const connectionStates: string[] = [];

    const client = new RemotePaneClient({
      id: 'profile-fast-wake',
      label: 'Remote host',
      baseUrl: server.baseUrl,
      token: 'secret-token',
      transport: 'http+sse',
    }, {
      reconnectMaxDelayMs: 20,
      onConnectionStateChange(status) {
        connectionStates.push(status);
      },
    });

    await client.connect({ retryOnInitialFailure: false });
    // Wake arrives before the old stream's close callbacks run.
    client.suspend();
    client.resume();

    await waitFor(() => connectionStates.at(-1) === 'connected' && server.getEventRequestCount() === 2);
    await sleep(150);
    expect(server.getEventRequestCount()).toBe(2);
    expect(connectionStates.at(-1)).toBe('connected');

    await client.disconnect();
  });
});

describe('RemotePaneClient routes (D-51)', () => {
  const routeProfile = (baseUrl: string) => ({ id: 'mac', label: 'Mac', baseUrl, token: 'link-token', transport: 'http+sse' as const });

  it('moves to the next route when the one in use goes silent, without an error, and back once it answers', async () => {
    const near = await createTestRemoteServer();
    const far = await createTestRemoteServer();
    activeServers.push(near, far);
    near.setHeartbeatInterval(20);
    far.setHeartbeatInterval(20);
    const statuses: string[] = [];
    let resyncs = 0;
    const client = new RemotePaneClient(routeProfile(near.baseUrl), {
      // Each route change refetches host state, terminals included, as a reconnect does.
      onResyncRequired: () => { resyncs += 1; },
      routes: [
        { routeId: 'tailscale:near', kind: 'tailscale', profile: routeProfile(near.baseUrl) },
        { routeId: 'relay:far', kind: 'relay', profile: routeProfile(far.baseUrl) },
      ],
      // Scaled: the 8 s silence limit and the 60 s recheck.
      failoverStaleTimeoutMs: 100,
      heartbeatStaleTimeoutMs: 5_000,
      routeRecheckMs: 100,
      onConnectionStateChange: (status) => statuses.push(status),
    });
    await client.connect();
    expect(client.routeId).toBe('tailscale:near');

    // Tailscale blocked: the stream goes quiet and the address stops serving.
    near.setHeartbeatInterval(0);
    near.setEventsReady(false);
    await waitFor(() => client.routeId === 'relay:far' && statuses.at(-1) === 'connected', 2_000);
    expect(statuses).not.toContain('error');
    expect(client.profile.baseUrl).toBe(far.baseUrl);
    expect(resyncs).toBe(2);

    near.setEventsReady(true);
    near.setHeartbeatInterval(20);
    await waitFor(() => client.routeId === 'tailscale:near' && statuses.at(-1) === 'connected', 2_000);
    expect(resyncs).toBe(3);
    await client.disconnect();
  });

  it('stays connected for the full heartbeat limit when no other route answers', async () => {
    const near = await createTestRemoteServer();
    const far = await createTestRemoteServer();
    activeServers.push(near);
    near.setHeartbeatInterval(20);
    const statuses: Array<{ status: string; at: number }> = [];
    const client = new RemotePaneClient(routeProfile(near.baseUrl), {
      routes: [
        { routeId: 'lan:near', kind: 'lan', profile: routeProfile(near.baseUrl) },
        { routeId: 'relay:far', kind: 'relay', profile: routeProfile(far.baseUrl) },
      ],
      // Scaled: the 8 s silence limit and today's 20 s heartbeat limit.
      failoverStaleTimeoutMs: 100,
      heartbeatStaleTimeoutMs: 800,
      onConnectionStateChange: (status) => statuses.push({ status, at: Date.now() }),
    });
    await client.connect();
    await far.close();

    near.setHeartbeatInterval(0);
    const silentAt = Date.now();
    await waitFor(() => statuses.some(({ status }) => status === 'reconnecting'), 3_000);
    const droppedAfter = statuses.find(({ status }) => status === 'reconnecting')!.at - silentAt;
    expect(droppedAfter).toBeGreaterThanOrEqual(700);
    await client.disconnect();
  });

  it('connects on the next route when the nearest does not answer', async () => {
    const near = await createTestRemoteServer();
    const far = await createTestRemoteServer();
    activeServers.push(near, far);
    near.setEventsReady(false);
    const client = new RemotePaneClient(routeProfile(near.baseUrl), {
      routes: [
        { routeId: 'lan:near', kind: 'lan', profile: routeProfile(near.baseUrl) },
        { routeId: 'relay:far', kind: 'relay', profile: routeProfile(far.baseUrl) },
      ],
    });
    await client.connect({ retryOnInitialFailure: false });
    expect(client.routeId).toBe('relay:far');
    await client.disconnect();
  });
});

describe('RemotePaneClient writes through a drop', () => {
  const profileFor = (server: TestRemoteServer, id: string) => ({ id, label: 'host', baseUrl: server.baseUrl, token: 'secret-token', transport: 'http+sse' as const });

  async function connectController(server: TestRemoteServer): Promise<RemotePaneClientController> {
    const remoteConfig = createDefaultRemoteDaemonConfig();
    remoteConfig.client = { profiles: [profileFor(server, 'profile-writes')], activeProfileId: 'profile-writes', mode: 'remote' };
    const controller = createController();
    controller.initialize({ configManager: createConfigManagerStub(remoteConfig), rendererEventSink: { send() {} } });
    await waitFor(() => controller.getConnectionState().status === 'connected');
    // The host has answered the controller's ports read, so a cut-off answer can only be the test's write.
    await waitFor(() => server.getApplied().some(invoke => invoke.channel === 'ports:list'));
    return controller;
  }

  /** The controller also reads the host's ports; these tests watch only the writes. */
  const sessionCreates = (invokes: Array<{ channel: string }>) => invokes.filter(invoke => invoke.channel === 'sessions:create');

  async function dropConnection(server: TestRemoteServer, controller: RemotePaneClientController): Promise<void> {
    server.setEventsReady(false);
    server.closeEventStream();
    await waitFor(() => controller.getConnectionState().status === 'reconnecting');
  }

  it('resends a write whose answer was lost with the same request id, and the host runs it once', async () => {
    const server = await createTestRemoteServer();
    activeServers.push(server);
    server.deduplicateRequestIds();
    const client = new RemotePaneClient(profileFor(server, 'resend'));
    await client.connect();
    server.truncateInvoke(1);

    await expect(client.invoke('sessions:create', [{ prompt: 'hi' }]))
      .resolves.toEqual({ channel: 'sessions:create', args: [{ prompt: 'hi' }] });
    const [first, second, ...rest] = server.getInvokes();
    expect(rest).toEqual([]);
    expect(first.requestId).toEqual(expect.any(String));
    expect(second.requestId).toBe(first.requestId);
    expect(server.getApplied()).toEqual([{ channel: 'sessions:create', args: [{ prompt: 'hi' }] }]);
    expect(server.getEventRequestCount()).toBe(1);
    await client.disconnect();
  });

  it('resends a write that a proxy without a route to the host answered, and the host runs it once', async () => {
    const server = await createTestRemoteServer();
    activeServers.push(server);
    server.deduplicateRequestIds();
    const client = new RemotePaneClient(profileFor(server, 'proxy-miss'));
    await client.connect();
    server.proxyMissInvoke(1);

    await expect(client.invoke('devices:input', ['panel', { kind: 'touch', phase: 'end', x: 0.5, y: 0.5 }]))
      .resolves.toEqual({ channel: 'devices:input', args: ['panel', { kind: 'touch', phase: 'end', x: 0.5, y: 0.5 }] });
    expect(server.getApplied()).toEqual([{ channel: 'devices:input', args: ['panel', { kind: 'touch', phase: 'end', x: 0.5, y: 0.5 }] }]);
    await client.disconnect();
  });

  it('says delivery is unknown once a write goes unconfirmed for the whole resend budget, without reconnecting', async () => {
    // Scaled from the plan: a five-minute budget becomes 600 ms.
    const server = await createTestRemoteServer();
    activeServers.push(server);
    server.deduplicateRequestIds();
    const client = new RemotePaneClient(profileFor(server, 'unconfirmed'), { reconnectDurationMs: 600, reconnectMaxDelayMs: 50 });
    await client.connect();
    server.truncateInvoke();
    const started = Date.now();

    await expect(client.invoke('sessions:create', [])).rejects.toMatchObject({
      code: 'ERR_REMOTE_DELIVERY_UNKNOWN',
      message: 'Delivery unknown: Pane resent the action to host for five minutes without a confirmation. It may have completed.',
      next: 'Check host before trying again.',
    });
    // Gives up when the next wait (at most 50 ms) would pass the budget.
    expect(Date.now() - started).toBeGreaterThanOrEqual(540);
    const ids = server.getInvokes().map(invoke => invoke.requestId);
    expect(ids.length).toBeGreaterThan(3);
    expect(new Set(ids).size).toBe(1);
    expect(server.getEventRequestCount()).toBe(1);
    await client.disconnect();
  });

  it('sends a write issued while reconnecting once the host is back', async () => {
    const server = await createTestRemoteServer();
    activeServers.push(server);
    server.deduplicateRequestIds();
    const controller = await connectController(server);
    await dropConnection(server, controller);

    const write = controller.invoke('sessions:create', [{ prompt: 'later' }], async () => undefined);
    await sleep(300);
    expect(sessionCreates(server.getInvokes())).toEqual([]);
    server.setEventsReady(true);

    await expect(write).resolves.toEqual({ channel: 'sessions:create', args: [{ prompt: 'later' }] });
    expect(sessionCreates(server.getApplied())).toHaveLength(1);
    await controller.switchToLocalMode();
  });

  it('keeps today\'s behavior against a host without the capability: no request id, no resend, no waiting', async () => {
    const server = await createTestRemoteServer();
    activeServers.push(server);
    const controller = await connectController(server);
    server.truncateInvoke(1);
    await expect(controller.invoke('sessions:create', [], async () => undefined)).rejects.toThrow(/^Delivery unknown:/);
    expect(sessionCreates(server.getInvokes())).toEqual([{ channel: 'sessions:create', args: [] }]);

    await dropConnection(server, controller);
    await expect(controller.invoke('sessions:create', [], async () => undefined)).rejects.toMatchObject({ code: 'ERR_REMOTE_OFFLINE' });
    expect(sessionCreates(server.getInvokes())).toHaveLength(1);
    await controller.switchToLocalMode();
  });

  it('delivers terminal input in flight across a reconnect once and in order', async () => {
    const server = await createTestRemoteServer();
    activeServers.push(server);
    server.deduplicateRequestIds();
    const client = new RemotePaneClient(profileFor(server, 'input'));
    await client.connect();
    server.delayInvoke(100);
    server.truncateInvoke(1);

    const typed = Promise.all(['a', 'b', 'c'].map(key => client.invoke('terminal:input', ['panel-1', key])));
    await waitFor(() => server.getInvokes().length === 1);
    server.closeEventStream();

    await expect(typed).resolves.toHaveLength(3);
    expect(server.getApplied().map(invoke => invoke.args)).toEqual([['panel-1', 'a'], ['panel-1', 'bc']]);
    const ids = server.getInvokes().map(invoke => invoke.requestId);
    expect(ids).toHaveLength(3);
    expect(ids[1]).toBe(ids[0]);
    expect(ids[2]).not.toBe(ids[0]);
    expect(server.getEventRequestCount()).toBe(2);
    await client.disconnect();
  });
});

describe('RemotePaneClientController', () => {
  it('watches a host its token is read-only for, whatever the host says, and asks it none of its own bookkeeping', async () => {
    const server = await createTestRemoteServer();
    activeServers.push(server);
    const config = createDefaultRemoteDaemonConfig();
    config.client = { mode: 'remote', activeProfileId: 'tyler', profiles: [
      { id: 'tyler', label: 'Tyler', baseUrl: server.baseUrl, token: 'pane_read_tyler', transport: 'http+sse' },
    ] };
    const controller = createController();
    const seen: Array<'read' | undefined> = [];
    controller.on('state-changed', (state: RemotePaneConnectionState) => { if (state.mode === 'remote') seen.push(state.access); });
    controller.initialize({ configManager: createConfigManagerStub(config), rendererEventSink: { send() {} } });
    await waitFor(() => controller.getConnectionState().status === 'connected');

    await expect(controller.invoke('permission:getPending', [], async () => null)).resolves.toEqual({ success: true, data: [] });
    expect(server.getInvokes().map((call) => call.channel)).not.toContain('permission:getPending');
    server.closeEventStream();
    await waitFor(() => server.getEventRequestCount() === 2 && controller.getConnectionState().status === 'connected');
    expect(new Set(seen)).toEqual(new Set(['read']));

    await controller.switchToLocalMode();
    expect(controller.getConnectionState().access).toBeUndefined();
  });

  it('requires every current renderer to acknowledge restoration before green', async () => {
    const server = await createTestRemoteServer();
    activeServers.push(server);
    const config = createDefaultRemoteDaemonConfig();
    config.client = { mode: 'remote', activeProfileId: 'ack', profiles: [
      { id: 'ack', label: 'host', baseUrl: server.baseUrl, token: 'test-token', transport: 'http+sse' },
    ] };
    const controller = createController();
    let restoreId = 0;
    controller.initialize({
      configManager: createConfigManagerStub(config),
      rendererIds: () => [10, 11],
      rendererEventSink: { send(channel, payload) {
        if (channel === 'remote-daemon:resync-required') {
          restoreId = decodeBoundary(payload, boundary.object({ restoreId: boundary.number })).restoreId;
        }
      } },
    });
    await waitFor(() => restoreId > 0);
    expect(controller.getConnectionState().status).toBe('restoring');
    controller.acknowledgeRestore(10, restoreId);
    controller.acknowledgeRestore(99, restoreId);
    controller.acknowledgeRestore(11, restoreId - 1);
    expect(controller.getConnectionState().status).toBe('restoring');
    controller.acknowledgeRestore(11, restoreId);
    await waitFor(() => controller.getConnectionState().status === 'connected');
    await controller.switchToLocalMode();
  });

  it('sends a pending restoration again to a renderer that starts listening late', async () => {
    const server = await createTestRemoteServer();
    activeServers.push(server);
    const config = createDefaultRemoteDaemonConfig();
    config.client = { mode: 'remote', activeProfileId: 'late', profiles: [
      { id: 'late', label: 'host', baseUrl: server.baseUrl, token: 'test-token', transport: 'http+sse' },
    ] };
    const controller = createController();
    const restoreIds: number[] = [];
    controller.initialize({
      configManager: createConfigManagerStub(config),
      rendererIds: () => [10],
      rendererEventSink: { send(channel, payload) {
        if (channel === 'remote-daemon:resync-required') {
          restoreIds.push(decodeBoundary(payload, boundary.object({ restoreId: boundary.number })).restoreId);
        }
      } },
    });
    await waitFor(() => restoreIds.length === 1);

    // The window's page was still loading when the request went out.
    controller.rendererReady(10);
    expect(restoreIds).toEqual([restoreIds[0], restoreIds[0]]);
    controller.acknowledgeRestore(10, restoreIds[0]);
    await waitFor(() => controller.getConnectionState().status === 'connected');
    await controller.switchToLocalMode();
  });

  it('syncs into remote mode and suppresses local daemon renderer events', async () => {
    const server = await createTestRemoteServer();
    activeServers.push(server);

    const remoteConfig = createDefaultRemoteDaemonConfig();
    remoteConfig.client = {
      profiles: [{
        id: 'profile-1',
        label: 'Remote host',
        baseUrl: server.baseUrl,
        token: 'secret-token',
        transport: 'http+sse',
      }],
      activeProfileId: 'profile-1',
      mode: 'remote',
    };
    const configManager = createConfigManagerStub(remoteConfig);

    const controller = createController();
    controller.initialize({
      configManager,
      rendererEventSink: { send() {} },
    });

    await waitFor(() => controller.getConnectionState().status === 'connected');
    expect(controller.getConnectionState()).toMatchObject({
      mode: 'remote',
      status: 'connected',
      activeProfileId: 'profile-1',
    });
    expect(controller.shouldForwardLocalRendererEvent('session:created')).toBe(false);
    expect(controller.shouldForwardLocalRendererEvent('window:focus-changed')).toBe(true);
  });

  it('connects a codeless profile at its address on the current tailnet, relying on Tailscale identity alone', async () => {
    const server = await createTestRemoteServer();
    activeServers.push(server);

    const remoteConfig = createDefaultRemoteDaemonConfig();
    remoteConfig.client = {
      profiles: [{
        id: 'tailnet-my-mac',
        label: 'my-mac',
        // A stale saved address; nothing listens here any more.
        baseUrl: 'https://my-mac.old-tailnet.ts.net:8443',
        token: '',
        transport: 'http+sse',
        tailnetMachine: 'my-mac',
        tailnetDomain: 'tail1234.ts.net',
      }],
      activeProfileId: 'tailnet-my-mac',
      mode: 'remote',
    };
    const resolved: string[] = [];
    const controller = createController();
    controller.initialize({
      configManager: createConfigManagerStub(remoteConfig),
      rendererEventSink: { send() {} },
      resolveTailnetMachineUrl: async (machine) => {
        resolved.push(`${machine.name}@${machine.domain}`);
        return server.baseUrl;
      },
    });

    await waitFor(() => controller.getConnectionState().status === 'connected');
    expect(resolved).toEqual(['my-mac@tail1234.ts.net']);
    expect(controller.getConnectionState()).toMatchObject({ activeProfileId: 'tailnet-my-mac', activeBaseUrl: server.baseUrl });
    await controller.invoke('sessions:get-all', [], async () => undefined);
    expect(server.getLastInvokeAuth()).toBeUndefined();
    await controller.switchToLocalMode();
  });

  it('opens on This computer after a fresh boot, keeping the saved host to switch to', async () => {
    const remoteConfig = createDefaultRemoteDaemonConfig();
    remoteConfig.client = {
      profiles: [{
        id: 'tailnet-my-mac',
        label: 'my-mac',
        baseUrl: 'https://my-mac.tail1234.ts.net:8443',
        token: '',
        transport: 'http+sse',
        tailnetMachine: 'my-mac',
        tailnetDomain: 'tail1234.ts.net',
      }],
      activeProfileId: 'tailnet-my-mac',
      mode: 'remote',
    };
    const configManager = createConfigManagerStub(remoteConfig);
    const resolved: string[] = [];
    const controller = createController();
    controller.initialize({
      configManager,
      rendererEventSink: { send() {} },
      freshBoot: true,
      resolveTailnetMachineUrl: async (machine) => {
        resolved.push(machine.name);
        throw new Error('Tailscale is signed out. Open Tailscale and sign in.');
      },
    });

    await waitFor(() => configManager.getConfig().remoteDaemon.client.mode === 'local');
    await sleep(50);
    expect(configManager.getConfig().remoteDaemon.client).toMatchObject({ mode: 'local', activeProfileId: null });
    expect(configManager.getConfig().remoteDaemon.client.profiles.map((profile) => profile.id)).toEqual(['tailnet-my-mac']);
    expect(controller.getConnectionState()).toMatchObject({ mode: 'local', lastError: null });
    expect(resolved).toEqual([]);
  });

  it('names the saved host and fails calls quietly when Tailscale has not found it yet', async () => {
    const remoteConfig = createDefaultRemoteDaemonConfig();
    remoteConfig.client = {
      profiles: [{
        id: 'tailnet-my-mac',
        label: 'my-mac',
        baseUrl: 'https://my-mac.tail1234.ts.net:8443',
        token: '',
        transport: 'http+sse',
        tailnetMachine: 'my-mac',
        tailnetDomain: 'tail1234.ts.net',
      }],
      activeProfileId: 'tailnet-my-mac',
      mode: 'remote',
    };
    const controller = createController();
    controller.initialize({
      configManager: createConfigManagerStub(remoteConfig),
      rendererEventSink: { send() {} },
      resolveTailnetMachineUrl: async () => {
        throw new Error('Tailscale is signed out. Open Tailscale and sign in.');
      },
    });

    await waitFor(() => controller.getConnectionState().status === 'error');
    expect(controller.getConnectionState()).toMatchObject({
      mode: 'remote',
      activeProfileId: 'tailnet-my-mac',
      activeProfileLabel: 'my-mac',
      lastError: 'Tailscale is signed out. Open Tailscale and sign in.',
    });
    // The renderer stays quiet on "Remote connection interrupted:" failures; the banner explains them.
    await expect(controller.invoke('sessions:get-all', [], async () => undefined))
      .rejects.toMatchObject({ code: 'ERR_REMOTE_OFFLINE', message: expect.stringMatching(/^Remote connection interrupted:/) });
  });

  it('says which host to update when the host does not have a command', async () => {
    const server = await createTestRemoteServer();
    activeServers.push(server);
    server.refuseChannel('orchestration-sessions:reorder');
    const remoteConfig = createDefaultRemoteDaemonConfig();
    remoteConfig.client = {
      profiles: [{ id: 'profile-mini', label: 'Mac Mini', baseUrl: server.baseUrl, token: 'secret-token', transport: 'http+sse' }],
      activeProfileId: 'profile-mini',
      mode: 'remote',
    };
    const controller = createController();
    controller.initialize({ configManager: createConfigManagerStub(remoteConfig), rendererEventSink: { send() {} } });
    await waitFor(() => controller.getConnectionState().status === 'connected');

    const refusal = controller.invoke('orchestration-sessions:reorder', [{ sessionIds: [] }], async () => undefined);

    await expect(refusal).rejects.toMatchObject({
      code: 'ERR_HOST_OUTDATED',
      message: expect.stringContaining('Mac Mini runs an older Pane'),
      next: 'Update Pane on Mac Mini (run `runpane update` there), then try again.',
    });
    await controller.switchToLocalMode();
  });

  it('keeps retrying after an initial remote connection failure', async () => {
    const server = await createTestRemoteServer();
    activeServers.push(server);
    server.setEventsReady(false);

    const remoteConfig = createDefaultRemoteDaemonConfig();
    remoteConfig.client = {
      profiles: [{
        id: 'profile-retry',
        label: 'Remote host',
        baseUrl: server.baseUrl,
        token: 'secret-token',
        transport: 'http+sse',
      }],
      activeProfileId: 'profile-retry',
      mode: 'remote',
    };
    const configManager = createConfigManagerStub(remoteConfig);

    const controller = createController();
    controller.initialize({
      configManager,
      rendererEventSink: { send() {} },
    });

    await waitFor(() => {
      const state = controller.getConnectionState();
      return state.status === 'error' || state.status === 'reconnecting';
    });

    server.setEventsReady(true);

    await waitFor(() => controller.getConnectionState().status === 'connected', 3_000);
    expect(controller.getConnectionState()).toMatchObject({
      mode: 'remote',
      status: 'connected',
      activeProfileId: 'profile-retry',
    });
  });

  it('requests a renderer state resync after reconnecting the remote event stream', async () => {
    const server = await createTestRemoteServer();
    activeServers.push(server);

    const rendererEvents: Array<{ channel: string; args: unknown[] }> = [];
    const remoteConfig = createDefaultRemoteDaemonConfig();
    remoteConfig.client = {
      profiles: [{
        id: 'profile-resync',
        label: 'Remote host',
        baseUrl: server.baseUrl,
        token: 'secret-token',
        transport: 'http+sse',
      }],
      activeProfileId: 'profile-resync',
      mode: 'remote',
    };
    const configManager = createConfigManagerStub(remoteConfig);

    const controller = createController();
    controller.initialize({
      configManager,
      rendererEventSink: {
        send(channel, ...args) {
          rendererEvents.push({ channel, args });
        },
      },
    });

    await waitFor(() => controller.getConnectionState().status === 'connected');
    await waitFor(() => {
      return rendererEvents.filter((event) => event.channel === 'remote-daemon:resync-required').length === 1;
    });
    server.closeEventStream();

    await waitFor(() => {
      return rendererEvents.filter((event) => event.channel === 'remote-daemon:resync-required').length === 2;
    }, 3_000);

    expect(rendererEvents.filter((event) => event.channel === 'remote-daemon:resync-required')).toHaveLength(2);
    expect(controller.getConnectionState()).toMatchObject({
      mode: 'remote',
      status: 'connected',
      activeProfileId: 'profile-resync',
    });
  });

  it('requests a renderer state resync on the first successful remote event stream connection', async () => {
    const server = await createTestRemoteServer();
    activeServers.push(server);

    const rendererEvents: Array<{ channel: string; args: unknown[] }> = [];
    const remoteConfig = createDefaultRemoteDaemonConfig();
    remoteConfig.client = {
      profiles: [{
        id: 'profile-initial-resync',
        label: 'Remote host',
        baseUrl: server.baseUrl,
        token: 'secret-token',
        transport: 'http+sse',
      }],
      activeProfileId: 'profile-initial-resync',
      mode: 'remote',
    };
    const configManager = createConfigManagerStub(remoteConfig);

    const controller = createController();
    controller.initialize({
      configManager,
      rendererEventSink: {
        send(channel, ...args) {
          rendererEvents.push({ channel, args });
        },
      },
    });

    await waitFor(() => {
      return rendererEvents.filter((event) => event.channel === 'remote-daemon:resync-required').length === 1;
    });

    expect(controller.getConnectionState()).toMatchObject({
      mode: 'remote',
      status: 'connected',
      activeProfileId: 'profile-initial-resync',
    });
  });

  it('closes a failed checklist for the host once its connection recovers on its own', async () => {
    const server = await createTestRemoteServer();
    activeServers.push(server);
    const profile = { id: 'recovers', label: 'host', baseUrl: server.baseUrl, token: 'test-token', transport: 'http+sse' as const };
    const config = createDefaultRemoteDaemonConfig();
    config.client = { mode: 'remote', activeProfileId: profile.id, profiles: [profile] };
    const controller = createController();
    controller.initialize({ configManager: createConfigManagerStub(config), rendererEventSink: { send() {} } });
    await waitFor(() => controller.getConnectionState().status === 'connected');

    // Retry now while the host is not answering: the checklist fails.
    server.setEventsReady(false);
    await expect(controller.activateProfile(profile, { recheck: true })).rejects.toThrow();
    expect(controller.getConnectionState().check?.outcome).toBe('failed');

    server.setEventsReady(true);
    controller.suspend();
    controller.resume();
    await waitFor(() => controller.getConnectionState().status === 'connected' && !controller.getConnectionState().check);
    await controller.switchToLocalMode();
  });

  it('switches over the next route when the first is Tailscale and Tailscale is signed out here', async () => {
    const server = await createTestRemoteServer();
    activeServers.push(server);
    const remoteConfig = createDefaultRemoteDaemonConfig();
    remoteConfig.client.computers = [{
      id: 'studio-mac',
      label: 'studio-mac',
      routes: [
        { id: 'tailscale:https://studio-mac.tail1234.ts.net:8443', kind: 'tailscale', source: 'found', baseUrl: 'https://studio-mac.tail1234.ts.net:8443', token: 'link-token', tailnetMachine: 'studio-mac', tailnetDomain: 'tail1234.ts.net' },
        { id: `public:${server.baseUrl}`, kind: 'public', source: 'link', baseUrl: server.baseUrl, token: 'link-token' },
      ],
    }];
    const controller = createController();
    const checklistRoutes: string[] = [];
    controller.initialize({
      configManager: createConfigManagerStub(remoteConfig),
      rendererEventSink: { send() {
        const route = controller.getConnectionState().check?.route;
        if (route && checklistRoutes.at(-1) !== route) checklistRoutes.push(route);
      } },
      resolveTailnetMachineUrl: async () => { throw new Error('Tailscale is signed out. Open Tailscale and sign in.'); },
      checkDependencies: { lookupTailnetMachine: async () => ({ kind: 'tailscale-down', reason: 'Tailscale is signed out', fix: 'Open Tailscale and sign in.' }) },
    });

    await controller.activateProfile({
      id: 'studio-mac', label: 'studio-mac', baseUrl: 'https://studio-mac.tail1234.ts.net:8443', token: 'link-token', transport: 'http+sse', tailnetMachine: 'studio-mac', tailnetDomain: 'tail1234.ts.net',
    });

    await waitFor(() => controller.getConnectionState().status === 'connected');
    expect(controller.getConnectionState()).toMatchObject({ activeRouteId: `public:${server.baseUrl}` });
    // The checklist names each route it tries.
    expect(checklistRoutes).toEqual(['Tailscale', 'Public URL']);
  });

  it('switches over the next route when the computer\'s Same network address is on another network', async () => {
    const server = await createTestRemoteServer();
    activeServers.push(server);
    // 172.31.250.0/24 is on no interface of this computer, so the Same network route is skipped.
    const lan = { id: 'lan:https://l172-31-250-9.k7xq2m4n8p3r5t6v.runpane.net:42138', kind: 'lan' as const, source: 'found' as const, baseUrl: 'https://l172-31-250-9.k7xq2m4n8p3r5t6v.runpane.net:42138', token: 'link-token' };
    const remoteConfig = createDefaultRemoteDaemonConfig();
    const studio = { id: 'studio-mac', label: 'Studio Mac', routes: [lan, { id: `public:${server.baseUrl}`, kind: 'public' as const, source: 'link' as const, baseUrl: server.baseUrl, token: 'link-token' }] };
    remoteConfig.client.computers = [studio];
    const controller = createController();
    const checklistRoutes: string[] = [];
    controller.initialize({ configManager: createConfigManagerStub(remoteConfig), rendererEventSink: { send() {
      const route = controller.getConnectionState().check?.route;
      if (route && checklistRoutes.at(-1) !== route) checklistRoutes.push(route);
    } } });

    await controller.activateProfile(primaryProfile(studio));

    await waitFor(() => controller.getConnectionState().status === 'connected');
    expect(controller.getConnectionState()).toMatchObject({ activeRouteId: `public:${server.baseUrl}` });
    expect(checklistRoutes.at(-1)).toBe('Public URL');
    await controller.switchToLocalMode();
  });

  it('opens the SSH tunnel of a computer whose only route is SSH before switching to it', async () => {
    const server = await createTestRemoteServer();
    activeServers.push(server);
    const sshRoute = { id: 'ssh:http://127.0.0.1:1', kind: 'ssh' as const, source: 'ssh' as const, baseUrl: 'http://127.0.0.1:1', token: 'link-token', ssh: { host: 'build-box', remotePort: 42137 } };
    const remoteConfig = createDefaultRemoteDaemonConfig();
    remoteConfig.client.computers = [{ id: 'build-box', label: 'build-box', routes: [sshRoute] }];
    const opened: string[] = [];
    const controller = createController();
    controller.initialize({
      configManager: createConfigManagerStub(remoteConfig),
      rendererEventSink: { send() {} },
      // The tunnel comes up on a new local port after a restart; the saved one is dead.
      prepareSshRoute: async (route) => { opened.push(route.ssh?.host ?? ''); return server.baseUrl; },
    });

    await controller.activateProfile({ id: 'build-box', label: 'build-box', baseUrl: sshRoute.baseUrl, token: 'link-token', transport: 'http+sse' });

    await waitFor(() => controller.getConnectionState().status === 'connected');
    expect(opened).toContain('build-box');
    await controller.switchToLocalMode();
  });

  it('restores the saved local state when a manual activation fails', async () => {
    const server = await createTestRemoteServer();
    activeServers.push(server);
    server.setEventsReady(false);

    const configManager = createConfigManagerStub(createDefaultRemoteDaemonConfig());
    const controller = createController();
    controller.initialize({
      configManager,
      rendererEventSink: { send() {} },
    });

    await expect(controller.activateProfile({
      id: 'profile-manual-failure',
      label: 'Tunnel host',
      baseUrl: server.baseUrl,
      token: 'secret-token',
      transport: 'http+sse',
    })).rejects.toThrow('Remote daemon not ready yet');

    expect(controller.getConnectionState()).toMatchObject({
      mode: 'local',
      status: 'local',
      activeProfileId: null,
      activeProfileLabel: null,
      activeBaseUrl: null,
      lastError: null,
    });
    expect(controller.shouldForwardLocalRendererEvent('session:created')).toBe(true);

    server.setEventsReady(true);
    await sleep(1_250);

    expect(controller.getConnectionState()).toMatchObject({
      mode: 'local',
      status: 'local',
      activeProfileId: null,
      activeProfileLabel: null,
      activeBaseUrl: null,
      lastError: null,
    });
  });
});

describe('RemotePaneClientController switches fast (T-128)', () => {
  it('skips the connection checklist for a machine that answered in the last 30 s, and runs it for one that did not', async () => {
    const server = await createTestRemoteServer();
    activeServers.push(server);
    const config = createDefaultRemoteDaemonConfig();
    const studio = { id: 'studio-mac', label: 'Studio Mac', routes: [{ id: `public:${server.baseUrl}`, kind: 'public' as const, source: 'link' as const, baseUrl: server.baseUrl, token: 'test-token' }] };
    config.client.computers = [studio];
    const controller = createController();
    let checklistShown = false;
    controller.initialize({ configManager: createConfigManagerStub(config), rendererEventSink: { send() {
      if (controller.getConnectionState().check) checklistShown = true;
    } } });
    let fresh = true;
    const asked: Array<[string, number]> = [];
    controller.setRecentAnswers((computerId, ms) => {
      asked.push([computerId, ms]);
      return fresh ? { routeId: studio.routes[0].id, baseUrl: server.baseUrl } : null;
    });

    await controller.activateProfile(primaryProfile(studio));
    await waitFor(() => controller.getConnectionState().status === 'connected');
    expect(asked).toEqual([['studio-mac', 30_000]]);
    expect(checklistShown).toBe(false);

    await controller.switchToLocalMode();
    fresh = false;
    await controller.activateProfile(primaryProfile(studio));
    await waitFor(() => controller.getConnectionState().status === 'connected');
    expect(checklistShown).toBe(true);
    await controller.switchToLocalMode();
  });

  it('dials the address the machine\'s live connection uses, without a Tailscale lookup, and looks it up only when that dial fails', async () => {
    const server = await createTestRemoteServer();
    activeServers.push(server);
    const tailscale = { id: 'tailscale:https://studio-mac.tail1234.ts.net:8443', kind: 'tailscale' as const, source: 'found' as const, baseUrl: 'https://studio-mac.tail1234.ts.net:8443', token: 'test-token', tailnetMachine: 'studio-mac', tailnetDomain: 'tail1234.ts.net' };
    const studio = { id: 'studio-mac', label: 'studio-mac', routes: [tailscale] };
    const config = createDefaultRemoteDaemonConfig();
    config.client.computers = [studio];
    const controller = createController();
    let lookups = 0;
    let probes = 0;
    let checklistShown = false;
    controller.initialize({
      configManager: createConfigManagerStub(config),
      rendererEventSink: { send() {
        if (controller.getConnectionState().check) checklistShown = true;
      } },
      resolveTailnetMachineUrl: async () => { lookups += 1; return server.baseUrl; },
      checkDependencies: { lookupTailnetMachine: async () => { probes += 1; return { kind: 'not-found', reason: 'not in this test' }; } },
    });
    let liveUrl = server.baseUrl;
    controller.setRecentAnswers(() => ({ routeId: tailscale.id, baseUrl: liveUrl }));

    await controller.activateProfile(primaryProfile(studio));
    await waitFor(() => controller.getConnectionState().status === 'connected');
    expect(lookups).toBe(0);
    expect(controller.getConnectionState().activeBaseUrl).toBe(server.baseUrl);

    await controller.switchToLocalMode();
    // The live connection's address stopped answering between its heartbeat and the switch.
    liveUrl = 'http://127.0.0.1:1';
    await controller.activateProfile(primaryProfile(studio));
    await waitFor(() => controller.getConnectionState().status === 'connected');
    expect(lookups).toBe(1);
    // Review F-6: the first dial's failure isn't diagnosed while the retry dials; only the retry's
    // own failure would show the checklist.
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(probes).toBe(0);
    expect(checklistShown).toBe(false);
    await controller.switchToLocalMode();
  });

  // #1767 Bug 1 in the rig: a config write while the switch dialed (config still said this
  // computer) disconnected the switch's connection, and the one dialed after it told the
  // renderer the host had not changed, so the landing never armed.
  it('keeps the switch\'s own connection through a config write that lands while it dials', async () => {
    const server = await createTestRemoteServer();
    activeServers.push(server);
    const config = createDefaultRemoteDaemonConfig();
    const studio = { id: 'studio-mac', label: 'Studio Mac', routes: [{ id: `public:${server.baseUrl}`, kind: 'public' as const, source: 'link' as const, baseUrl: server.baseUrl, token: 'test-token' }] };
    config.client.computers = [studio];
    const configManager = createConfigManagerStub(config);
    const controller = createController();
    const restores: boolean[] = [];
    let wrote = false;
    controller.initialize({
      configManager,
      rendererIds: () => [10],
      rendererEventSink: { send(channel, payload) {
        if (!wrote && controller.getConnectionState().status === 'connecting') {
          wrote = true;
          // Something unrelated saves config while the switch dials; it still says this computer.
          queueMicrotask(() => configManager.setRemoteConfig(configManager.getConfig().remoteDaemon));
        }
        if (channel === 'remote-daemon:resync-required') {
          restores.push(decodeBoundary(payload, boundary.object({ hostChanged: boundary.boolean })).hostChanged);
        }
      } },
    });
    controller.setRecentAnswers(() => ({ routeId: studio.routes[0].id, baseUrl: server.baseUrl }));

    // As the switch's IPC handler does: hold syncs, switch, commit the host to config, resync.
    const release = controller.holdConfigSync();
    await controller.activateProfile(primaryProfile(studio));
    expect(wrote).toBe(true);
    // Another write after the switch connected, before the handler commits: still this computer.
    configManager.setRemoteConfig(configManager.getConfig().remoteDaemon);
    configManager.setRemoteConfig({ ...config, client: { ...config.client, mode: 'remote', activeProfileId: studio.id } });
    controller.commitActivation();
    release();

    await waitFor(() => restores.length > 0);
    expect(restores[0]).toBe(true);
    await controller.switchToLocalMode();
  });

  // T-132: a 1 s rest starts the switch to a machine heard from moments ago, which skips the
  // checklist; an arrow press while it dials must still leave the window where it is (D-6).
  it('a switch cancelled while it dials a machine heard from moments ago leaves the window on this computer', async () => {
    const server = await createTestRemoteServer();
    activeServers.push(server);
    const config = createDefaultRemoteDaemonConfig();
    const studio = { id: 'studio-mac', label: 'Studio Mac', routes: [{ id: `public:${server.baseUrl}`, kind: 'public' as const, source: 'link' as const, baseUrl: server.baseUrl, token: 'test-token' }] };
    config.client.computers = [studio];
    const controller = createController();
    let cancelled: boolean | undefined;
    controller.initialize({ configManager: createConfigManagerStub(config), rendererEventSink: { send() {
      if (cancelled === undefined && controller.getConnectionState().status === 'connecting') cancelled = controller.cancelActivation('studio-mac');
    } } });
    controller.setRecentAnswers(() => ({ routeId: studio.routes[0].id, baseUrl: server.baseUrl }));

    await expect(controller.activateProfile(primaryProfile(studio))).rejects.toMatchObject({ code: 'ERR_REMOTE_SWITCH_CANCELLED' });
    expect(cancelled).toBe(true);
    await waitFor(() => controller.getConnectionState().status === 'local');
    expect(controller.getConnectionState()).toMatchObject({ mode: 'local', activeProfileId: null, check: null });
    expect(controller.cancelActivation('studio-mac')).toBe(false);
  });

  // QA 1781 F-3: an arrow just after the switch starts. The cancel returns at once, so the dial it
  // abandons must never go on to connect and move the window afterwards.
  it('a switch cancelled at once from this computer never connects to the other machine afterwards', async () => {
    const server = await createTestRemoteServer();
    activeServers.push(server);
    const config = createDefaultRemoteDaemonConfig();
    const studio = { id: 'studio-mac', label: 'Studio Mac', routes: [{ id: `public:${server.baseUrl}`, kind: 'public' as const, source: 'link' as const, baseUrl: server.baseUrl, token: 'test-token' }] };
    config.client.computers = [studio];
    const controller = createController();
    const states: string[] = [];
    controller.initialize({ configManager: createConfigManagerStub(config), rendererEventSink: { send() {
      const state = controller.getConnectionState();
      states.push(`${state.mode}:${state.status}:${state.activeProfileId}`);
    } } });
    controller.setRecentAnswers(() => ({ routeId: studio.routes[0].id, baseUrl: server.baseUrl }));

    const switching = controller.activateProfile(primaryProfile(studio));
    expect(controller.cancelActivation('studio-mac')).toBe(true);
    await expect(switching).rejects.toMatchObject({ code: 'ERR_REMOTE_SWITCH_CANCELLED' });
    await sleep(300);
    expect(controller.getConnectionState()).toMatchObject({ mode: 'local', activeProfileId: null });
    expect(controller.getActiveRemoteClient()).toBeNull();
    expect(states.filter(state => state.startsWith('remote:'))).toEqual([]);
    expect(server.getEventRequestCount()).toBe(0);
  });

  it('a switch cancelled part-way leaves the window on its old machine, with no checklist left open', async () => {
    const server = await createTestRemoteServer();
    activeServers.push(server);
    const config = createDefaultRemoteDaemonConfig();
    const studio = { id: 'studio-mac', label: 'Studio Mac', routes: [{ id: `public:${server.baseUrl}`, kind: 'public' as const, source: 'link' as const, baseUrl: server.baseUrl, token: 'test-token' }] };
    config.client = { ...config.client, mode: 'remote', activeProfileId: 'studio-mac', computers: [studio] };
    const controller = createController();
    controller.initialize({
      configManager: createConfigManagerStub(config),
      rendererEventSink: { send() {} },
      // The other machine's Tailscale lookup never answers.
      checkDependencies: { lookupTailnetMachine: () => new Promise(() => undefined) },
    });
    await waitFor(() => controller.getConnectionState().status === 'connected');
    expect(controller.cancelActivation('build-box')).toBe(false);

    const switching = controller.activateProfile({
      id: 'build-box', label: 'build-box', baseUrl: 'https://build-box.tail1234.ts.net:8443', token: '', transport: 'http+sse', tailnetMachine: 'build-box', tailnetDomain: 'tail1234.ts.net',
    });
    await waitFor(() => controller.getConnectionState().check?.outcome === 'running');
    // Only a cancel for the machine being switched to stops it (review F-4).
    expect(controller.cancelActivation('studio-mac')).toBe(false);
    expect(controller.cancelActivation('build-box')).toBe(true);

    await expect(switching).rejects.toMatchObject({ code: 'ERR_REMOTE_SWITCH_CANCELLED' });
    expect(controller.getConnectionState()).toMatchObject({ status: 'connected', activeProfileId: 'studio-mac', check: null });
    await controller.switchToLocalMode();
  });
});

describe('RemotePaneClientController links to host ports', () => {
  const cleanups: Array<() => Promise<void> | void> = [];
  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  });

  /** A real host API that lists `ports` and can announce a new list, with a controller connected to it. */
  async function connectToHost(options: { listsPorts: boolean; ports: number[] }) {
    const registry = new PaneCommandRegistry();
    const snapshotOf = (ports: number[]): ListeningPortsSnapshot => ({
      host: 'studio',
      ports: ports.map(port => ({ port, pid: 1, process: 'node', group: 'other', kind: 'web' })),
    });
    if (options.listsPorts) registry.register('ports:list', () => snapshotOf(options.ports));
    const hostConfig = createDefaultRemoteDaemonConfig();
    hostConfig.host.config = { ...hostConfig.host.config, enabled: true, listenHost: '127.0.0.1', listenPort: 0 };
    hostConfig.host.clients = [{ id: 'laptop', label: 'Laptop', createdAt: new Date(0).toISOString(), tokenHash: hashRemoteDaemonToken('link-token') }];
    const host = new PaneRemoteHttpApiServer(registry, { getConfig: () => ({ remoteDaemon: hostConfig }) }, {
      isForwardedPort: () => true,
    });
    await host.start();
    cleanups.push(() => host.stop());

    const clientConfig = createDefaultRemoteDaemonConfig();
    clientConfig.client = {
      profiles: [{ id: 'studio', label: 'Studio', baseUrl: `http://127.0.0.1:${host.getAddress()!.port}`, token: 'link-token', transport: 'http+sse' }],
      activeProfileId: 'studio',
      mode: 'remote',
    };
    const controller = new RemotePaneClientController();
    const rendererEvents: string[] = [];
    controller.initialize({
      configManager: createConfigManagerStub(clientConfig),
      rendererEventSink: { send: channel => { rendererEvents.push(channel); } },
    });
    cleanups.push(() => controller.switchToLocalMode().then(() => undefined));
    await waitFor(() => controller.getConnectionState().status === 'connected', 3_000);
    return {
      controller,
      rendererEvents,
      announce: (ports: number[]) => host.getEventSink().send('ports:changed', snapshotOf(ports)),
    };
  }

  /** A port taken on this machine, so the tunnel has to move it, as on a desktop already running its own server. */
  async function takenPort(): Promise<number> {
    const server = http.createServer((_request, response) => response.end('this desktop'));
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()));
    cleanups.push(() => new Promise<void>(resolve => server.close(() => resolve())));
    // SAFETY: a server listening on a host and port reports an AddressInfo.
    return (server.address() as import('net').AddressInfo).port;
  }

  it('opens a tunnelled host port at its local number, and refuses it once the host stops listing it', async () => {
    const port = await takenPort();
    const { controller, rendererEvents, announce } = await connectToHost({ listsPorts: true, ports: [port] });
    await waitFor(() => rendererEvents.includes('ports:changed'), 3_000);

    const opened = controller.toLocalUrl(`http://localhost:${port}/app`);
    expect(opened).toMatch(/^http:\/\/localhost:\d+\/app$/);
    expect(opened).not.toBe(`http://localhost:${port}/app`);

    const changes = rendererEvents.length;
    announce([]);
    await waitFor(() => rendererEvents.length > changes, 3_000);
    // This desktop still serves that port number itself; the link must not reach it.
    expect(controller.toLocalUrl(`http://localhost:${port}/app`)).toBeNull();
    expect(controller.toLocalUrl('https://example.com/docs')).toBe('https://example.com/docs');
  });

  it('opens loopback links unchanged for a host too old to list ports', async () => {
    const port = await takenPort();
    const { controller } = await connectToHost({ listsPorts: false, ports: [] });
    await waitFor(() => controller.toLocalUrl(`http://localhost:${port}/`) !== null, 3_000);
    expect(controller.toLocalUrl(`http://localhost:${port}/`)).toBe(`http://localhost:${port}/`);
  });
});

async function createTestRemoteServer(host = '127.0.0.1', basePath = ''): Promise<TestRemoteServer> {
  let streamResponse: ServerResponse | null = null;
  let lastInvokeAuth: string | undefined;
  let lastInvokeBody: string | undefined;
  let lastInvokeHost: string | undefined;
  let lastInvokePath: string | undefined;
  let lastEventsPath: string | undefined;
  let lastEventsClientDeviceLabel: string | undefined;
  let eventRequestCount = 0;
  let eventsReady = true;
  let emitReadyEvent = true;
  const refusedChannels = new Set<string>();
  let truncateInvokes = 0;
  let proxyMisses = 0;
  let invokeDelayMs = 0;
  let invokeCount = 0;
  let deduplicates = false;
  const invokes: Array<{ channel: string; args: JsonValue[]; requestId?: string }> = [];
  const applied: Array<{ channel: string; args: JsonValue[] }> = [];
  const seenRequestIds = new Set<string>();
  let heartbeatTimer: NodeJS.Timeout | null = null;
  const normalizedBasePath = normalizeTestBasePath(basePath);
  const invokePath = `${normalizedBasePath}/invoke`;
  const eventsPath = `${normalizedBasePath}/events`;

  const server = http.createServer(async (request: IncomingMessage, response: ServerResponse) => {
    if (request.url === invokePath) {
      lastInvokeAuth = request.headers.authorization;
      invokeCount += 1;
      lastInvokeBody = await readRequestBody(request);
      if (invokeDelayMs) await sleep(invokeDelayMs);
      if (response.destroyed) return;
      lastInvokeHost = request.headers.host;
      lastInvokePath = request.url;
      const { requestId, ...parsed } = decodeBoundary(JSON.parse(lastInvokeBody), boundary.object({
        channel: boundary.string,
        args: boundary.array(boundary.json),
        requestId: boundary.optional(boundary.string),
      }));
      invokes.push(requestId ? { ...parsed, requestId } : parsed);
      if (!deduplicates || !requestId || !seenRequestIds.has(requestId)) applied.push(parsed);
      if (deduplicates && requestId) seenRequestIds.add(requestId);
      if (refusedChannels.has(parsed.channel)) {
        response.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
        response.end(JSON.stringify({
          ok: false,
          error: {
            code: 'ERR_UNKNOWN_CHANNEL',
            message: `No Pane daemon command registered for channel "${parsed.channel}". This Pane does not have that command, usually because it is older than the runpane CLI or app that asked. Nothing was changed.`,
            next: 'Update Pane with `runpane update`, then restart it.',
          },
        }));
        return;
      }
      if (proxyMisses > 0) {
        proxyMisses -= 1;
        response.writeHead(404, { 'Content-Type': 'text/html' });
        response.end('<html><body>404 page not found</body></html>');
        return;
      }
      response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      if (truncateInvokes > 0) { truncateInvokes -= 1; response.end('{"ok":'); return; }
      response.end(JSON.stringify({
        ok: true,
        result: parsed,
      }));
      return;
    }

    if (request.url === eventsPath) {
      eventRequestCount += 1;
      lastEventsPath = request.url;
      lastEventsClientDeviceLabel = getSingleHeaderValue(request.headers['x-pane-client-device-label']);
      if (!eventsReady) {
        response.writeHead(503, { 'Content-Type': 'application/json; charset=utf-8' });
        response.end(JSON.stringify({
          error: {
            message: 'Remote daemon not ready yet',
          },
        }));
        return;
      }

      response.writeHead(200, {
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'Content-Type': 'text/event-stream; charset=utf-8',
      });
      response.flushHeaders();
      streamResponse = response;
      if (emitReadyEvent) {
        response.write('event: ready\n');
        const ready = { replay: 'none', resync: 'refetch-state-after-reconnect', timestamp: new Date().toISOString() };
        response.write(`data: ${JSON.stringify({ ...ready, ...(deduplicates && { deduplicatesRequestIds: true }) })}\n\n`);
      }
      request.on('close', () => {
        if (streamResponse === response) {
          streamResponse = null;
        }
      });
      return;
    }

    response.writeHead(404);
    response.end();
  });

  await new Promise<void>((resolve, reject) => {
    server.listen(0, host, () => resolve());
    server.once('error', reject);
  });

  const address = server.address();
  if (!address || !(address instanceof Object)) {
    throw new Error('Test remote server failed to bind');
  }

  return {
    baseUrl: `http://${host.includes(':') ? `[${host}]` : host}:${address.port}${normalizedBasePath}`,
    truncateInvoke(count = Infinity) { truncateInvokes = count; },
    proxyMissInvoke(count) { proxyMisses = count; },
    delayInvoke(ms: number) { invokeDelayMs = ms; },
    deduplicateRequestIds() { deduplicates = true; },
    getInvokes() { return invokes; },
    getApplied() { return applied; },
    setHeartbeatInterval(ms: number) {
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      heartbeatTimer = ms ? setInterval(() => {
        streamResponse?.write(`event: heartbeat\ndata: ${JSON.stringify({ timestamp: new Date().toISOString() })}\n\n`);
      }, ms) : null;
    },
    getInvokeCount() {
      return invokeCount;
    },
    refuseChannel(channel: string) {
      refusedChannels.add(channel);
    },
    closeEventStream() {
      if (streamResponse && !streamResponse.destroyed) {
        streamResponse.destroy();
      }
    },
    emitDaemonEvent(payload: JsonValue) {
      if (!streamResponse) {
        throw new Error('Remote event stream is not connected');
      }

      streamResponse.write('event: daemon-event\n');
      streamResponse.write(`data: ${JSON.stringify(payload)}\n\n`);
    },
    getLastInvokeAuth() {
      return lastInvokeAuth;
    },
    getLastInvokeBody() {
      return lastInvokeBody;
    },
    getLastInvokeHost() {
      return lastInvokeHost;
    },
    getLastInvokePath() {
      return lastInvokePath;
    },
    getLastEventsPath() {
      return lastEventsPath;
    },
    getLastEventsClientDeviceLabel() {
      return lastEventsClientDeviceLabel;
    },
    getEventRequestCount() {
      return eventRequestCount;
    },
    setEmitReadyEvent(nextEmitReadyEvent: boolean) {
      emitReadyEvent = nextEmitReadyEvent;
    },
    setEventsReady(nextReady: boolean) {
      eventsReady = nextReady;
    },
    async close() {
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      if (streamResponse && !streamResponse.writableEnded) {
        streamResponse.end();
      }

      await new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      });
    },
  };
}

function normalizeTestBasePath(basePath: string): string {
  if (basePath.length === 0 || basePath === '/') {
    return '';
  }

  const withLeadingSlash = basePath.startsWith('/') ? basePath : `/${basePath}`;
  return withLeadingSlash.endsWith('/') ? withLeadingSlash.slice(0, -1) : withLeadingSlash;
}

function createConfigManagerStub(initialConfig: RemoteDaemonConfig): ConfigManagerStub {
  class Stub extends EventEmitter implements ConfigManagerStub {
    private remoteDaemon = initialConfig;

    getConfig(): RemoteConfigSnapshot {
      return { remoteDaemon: this.remoteDaemon };
    }

    setRemoteConfig(remoteDaemon: RemoteDaemonConfig): void {
      this.remoteDaemon = remoteDaemon;
      this.emit('config-updated', { remoteDaemon });
    }

    async updateConfigWith(update: (current: RemoteConfigSnapshot) => Partial<RemoteConfigSnapshot>): Promise<RemoteConfigSnapshot> {
      const { remoteDaemon } = update(this.getConfig());
      if (remoteDaemon) this.setRemoteConfig(remoteDaemon);
      return this.getConfig();
    }
  }

  return new Stub();
}

async function readRequestBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  return Buffer.concat(chunks).toString('utf8');
}

function getSingleHeaderValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

async function waitFor(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error('Timed out waiting for test condition');
    }

    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function sleep(timeoutMs: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, timeoutMs));
}

describe('RemotePaneClient latency', () => {
  it('measures the round trip to the host, and answers null when nothing is there', async () => {
    // A host that takes 40 ms to answer: one round trip, so not the sum of two.
    const server = http.createServer((_request, response) => { setTimeout(() => response.end('ok'), 40); });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    // SAFETY: a server listening on a host and port reports an AddressInfo.
    const address = server.address() as import('net').AddressInfo;
    const profile = { id: 'box', label: 'Box', token: 't', transport: 'http+sse' as const };
    try {
      const ms = await new RemotePaneClient({ ...profile, baseUrl: `http://127.0.0.1:${address.port}` }).measureLatency();
      expect(ms).toBeGreaterThanOrEqual(39);
      expect(ms).toBeLessThan(80);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    expect(await new RemotePaneClient({ ...profile, baseUrl: `http://127.0.0.1:${address.port}` }).measureLatency(1_000)).toBeNull();
  });

  it('times one round trip on a key-pinned route, over one TLS connection, and refuses any other key', async () => {
    const fixtures = path.join(__dirname, '../relay/__fixtures__');
    const cert = readFileSync(path.join(fixtures, 'computer.pem'), 'utf8');
    const server = https.createServer({ cert, key: readFileSync(path.join(fixtures, 'computer.key'), 'utf8') }, (_request, response) => response.end('ok'));
    let handshakes = 0;
    server.on('secureConnection', () => { handshakes += 1; });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    // SAFETY: a server listening on a host and port reports an AddressInfo.
    const { port } = server.address() as import('net').AddressInfo;
    const defaults = tls.getCACertificates('default');
    tls.setDefaultCACertificates([...defaults, readFileSync(path.join(fixtures, 'ca.pem'), 'utf8')]);
    const fingerprint = createHash('sha256').update(new X509Certificate(cert).publicKey.export({ format: 'der', type: 'spki' })).digest('base64url');
    // The certificate's name, reached at 127.0.0.1: name lookups fail, so the route's fixed address answers.
    const pinned = (pin: string) => new RemotePaneClient({
      id: 'box', label: 'Box', token: 't', transport: 'http+sse', baseUrl: `https://75rnqtlvttepjja3.relay.test:${port}`,
      relay: { computerId: '75rnqtlvttepjja3', fingerprint: pin },
      tunnel: { kind: 'tailscale', tailscaleIp: '127.0.0.1', selected: true },
    }, { dnsLookup: (_host, _options, callback) => callback(Object.assign(new Error('not found'), { code: 'ENOTFOUND' }), '', 4) });
    try {
      expect(await pinned(fingerprint).measureLatency()).toBeGreaterThanOrEqual(1);
      expect(handshakes).toBe(1);
      expect(await pinned('another-key').measureLatency()).toBeNull();
    } finally {
      tls.setDefaultCACertificates(defaults);
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('answers null when the host drops the connection partway through its answer', async () => {
    const server = http.createServer((_request, response) => {
      response.writeHead(200, { 'Content-Length': '100' });
      response.write('partial');
      setTimeout(() => response.socket?.destroy(), 20);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    // SAFETY: a server listening on a host and port reports an AddressInfo.
    const address = server.address() as import('net').AddressInfo;
    try {
      const client = new RemotePaneClient({ id: 'box', label: 'Box', token: 't', transport: 'http+sse', baseUrl: `http://127.0.0.1:${address.port}` });
      expect(await client.measureLatency(5_000)).toBeNull();
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

describe('RemotePaneClient reads compressed answers (T-127)', () => {
  const cleanups: Array<() => Promise<void> | void> = [];
  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  });

  /** A real host API answering `channel` with `answer`, reached through a relay that counts the bytes the host sends back. */
  async function hostBehindRelay(channel: string, answer: JsonValue) {
    const registry = new PaneCommandRegistry();
    registry.register(channel, () => answer);
    const hostConfig = createDefaultRemoteDaemonConfig();
    hostConfig.host.config = { ...hostConfig.host.config, enabled: true, listenHost: '127.0.0.1', listenPort: 0 };
    hostConfig.host.clients = [{ id: 'laptop', label: 'Laptop', createdAt: new Date(0).toISOString(), tokenHash: hashRemoteDaemonToken('link-token') }];
    const host = new PaneRemoteHttpApiServer(registry, { getConfig: () => ({ remoteDaemon: hostConfig }) });
    await host.start();
    cleanups.push(() => host.stop());
    const hostPort = host.getAddress()!.port;

    let bytesFromHost = 0;
    const sockets = new Set<import('net').Socket>();
    const relay = net.createServer((client) => {
      const upstream = net.connect(hostPort, '127.0.0.1');
      sockets.add(client).add(upstream);
      upstream.on('data', (chunk: Buffer) => { bytesFromHost += chunk.length; });
      client.pipe(upstream).pipe(client);
      client.on('error', () => upstream.destroy());
      upstream.on('error', () => client.destroy());
    });
    await new Promise<void>(resolve => relay.listen(0, '127.0.0.1', () => resolve()));
    cleanups.push(() => new Promise<void>((resolve) => {
      for (const socket of sockets) socket.destroy();
      relay.close(() => resolve());
    }));
    // SAFETY: a server listening on a host and port reports an AddressInfo.
    const relayPort = (relay.address() as import('net').AddressInfo).port;
    const client = new RemotePaneClient({ id: 'studio', label: 'Studio', baseUrl: `http://127.0.0.1:${relayPort}`, token: 'link-token', transport: 'http+sse' });
    cleanups.push(() => client.disconnect());
    return { client, bytesFromHost: () => bytesFromHost };
  }

  it('asks the host for gzip and reads the compressed answer, so a long list crosses the link small', async () => {
    const sessions = Array.from({ length: 200 }, (_, index) => ({ id: `session-${index}`, name: `Session ${index}`, goal: 'Ship the small list. '.repeat(20) }));
    const answer = { success: true, data: { sessions } };
    const { client, bytesFromHost } = await hostBehindRelay('orchestration-sessions:list', answer);

    const before = bytesFromHost();
    await expect(client.invoke('orchestration-sessions:list', [{ summary: true }])).resolves.toEqual(answer);

    const raw = Buffer.byteLength(JSON.stringify({ ok: true, result: answer }));
    expect(bytesFromHost() - before).toBeLessThan(raw / 10);
  });
});

// Review 1781 SF-1: from a window on another machine (D-20), the dial to the next one keeps the
// window's own connection until the new one is ready, so a cancel or a failed dial leaves it as it was.
describe('a switch from a window on another machine keeps that machine until the new one is ready (T-132)', () => {
  async function onStudio({ renderers = false }: { renderers?: boolean } = {}) {
    const studioServer = await createTestRemoteServer();
    const buildServer = await createTestRemoteServer();
    activeServers.push(studioServer, buildServer);
    const config = createDefaultRemoteDaemonConfig();
    const studio = { id: 'studio-mac', label: 'Studio Mac', routes: [{ id: `public:${studioServer.baseUrl}`, kind: 'public' as const, source: 'link' as const, baseUrl: studioServer.baseUrl, token: 'test-token' }] };
    const build = { id: 'build-box', label: 'Build Box', routes: [{ id: `public:${buildServer.baseUrl}`, kind: 'public' as const, source: 'link' as const, baseUrl: buildServer.baseUrl, token: 'test-token' }] };
    config.client = { ...config.client, mode: 'remote', activeProfileId: 'studio-mac', computers: [studio, build] };
    const controller = createController();
    const states: string[] = [];
    controller.initialize({ configManager: createConfigManagerStub(config), rendererIds: renderers ? () => [1] : undefined, rendererEventSink: { send(channel, payload) {
      const state = controller.getConnectionState();
      const label = `${state.status}:${state.activeProfileId}`;
      if (states.at(-1) !== label) states.push(label);
      // The window restores at once, as a renderer acknowledges a resync.
      const restore = decodeOptionalBoundary(payload, boundary.object({ restoreId: boundary.number }));
      if (renderers && channel === 'remote-daemon:resync-required' && restore) queueMicrotask(() => controller.acknowledgeRestore(1, restore.restoreId));
    } } });
    await waitFor(() => controller.getConnectionState().status === 'connected');
    states.length = 0;
    controller.setRecentAnswers(() => ({ routeId: build.routes[0].id, baseUrl: buildServer.baseUrl }));
    return { controller, states, studio, build, studioServer, buildServer };
  }

  it('an arrow while it dials stops the dial at once and never drops or redials the machine the window is on', async () => {
    const { controller, states, build, studioServer, buildServer } = await onStudio();
    // The other machine never says ready: the dial would hang.
    buildServer.setEmitReadyEvent(false);
    const studioDials = studioServer.getEventRequestCount();

    const switching = controller.activateProfile(primaryProfile(build));
    await waitFor(() => buildServer.getEventRequestCount() > 0);
    expect(controller.cancelActivation('build-box')).toBe(true);

    await expect(switching).rejects.toMatchObject({ code: 'ERR_REMOTE_SWITCH_CANCELLED' });
    await sleep(50);
    expect(states.filter(state => !state.endsWith(':studio-mac'))).toEqual([]);
    expect(controller.getConnectionState()).toMatchObject({ status: 'connected', activeProfileId: 'studio-mac' });
    expect(studioServer.getEventRequestCount()).toBe(studioDials);
    await controller.switchToLocalMode();
  });

  it('a dial that fails leaves the window on the machine it shows, still connected', async () => {
    const { controller, states, build, studioServer, buildServer } = await onStudio();
    buildServer.setEventsReady(false);
    const studioDials = studioServer.getEventRequestCount();
    await expect(controller.activateProfile(primaryProfile(build))).rejects.toBeDefined();
    await sleep(50);
    expect(controller.getConnectionState()).toMatchObject({ status: 'connected', activeProfileId: 'studio-mac' });
    expect(studioServer.getEventRequestCount()).toBe(studioDials);
    expect(states.filter(state => state.startsWith('connected:') && !state.endsWith(':studio-mac'))).toEqual([]);
    await controller.switchToLocalMode();
  });

  // Review 1781 R2-SF-1: latest wins (D-6). The state still says connected to studio while the
  // staged dial runs, so picking studio again must stop that dial, not return early.
  it('picking the machine the window is on while the dial runs stops the dial, and the window stays there', async () => {
    const { controller, states, build, studio, studioServer, buildServer } = await onStudio();
    buildServer.setEmitReadyEvent(false);
    const studioDials = studioServer.getEventRequestCount();
    const switching = controller.activateProfile(primaryProfile(build));
    await waitFor(() => buildServer.getEventRequestCount() > 0);

    await controller.activateProfile(primaryProfile(studio));
    await expect(switching).rejects.toMatchObject({ code: 'ERR_REMOTE_SWITCH_CANCELLED' });
    buildServer.setEmitReadyEvent(true);
    await sleep(100);
    expect(controller.getConnectionState()).toMatchObject({ status: 'connected', activeProfileId: 'studio-mac' });
    expect(controller.getActiveRemoteClient()?.profile.id).toBe('studio-mac');
    expect(states.filter(state => !state.endsWith(':studio-mac'))).toEqual([]);
    expect(studioServer.getEventRequestCount()).toBe(studioDials);
    await controller.switchToLocalMode();
  });

  // Review 1781 R2-SF-2: once the new machine has taken over, a cancel can't stop the switch
  // (it would redial the old machine). The old link's close is awaited after the takeover.
  it('a cancel after the new machine took over, while the old link still closes, is refused and the switch completes', async () => {
    const { controller, build, studioServer } = await onStudio();
    const old = controller.getActiveRemoteClient();
    if (!old) throw new Error('The window has no connection to studio.');
    const realDisconnect = old.disconnect.bind(old);
    old.disconnect = async () => { await realDisconnect(); await sleep(80); };
    const studioDials = studioServer.getEventRequestCount();
    const switching = controller.activateProfile(primaryProfile(build));
    await waitFor(() => controller.getActiveRemoteClient()?.profile.id === 'build-box');

    expect(controller.cancelActivation('build-box')).toBe(false);
    await expect(switching).resolves.toBeDefined();
    await sleep(150);
    expect(controller.getActiveRemoteClient()?.profile.id).toBe('build-box');
    expect(studioServer.getEventRequestCount()).toBe(studioDials);
    await controller.switchToLocalMode();
  });

  // QA 1781 F-3: an arrow just after the dial is ready, before the switch is committed (its config
  // written). The renderer still shows the old machine, so the cancel must still stop it.
  it('a cancel after the dial is ready but before the switch commits leaves the window on its machine, with no redial', async () => {
    const { controller, build, studioServer, buildServer } = await onStudio({ renderers: true });
    const studioDials = studioServer.getEventRequestCount();
    await controller.activateProfile(primaryProfile(build));
    // Ready, not yet committed: the window still shows studio.
    expect(controller.getActiveRemoteClient()?.profile.id).toBe('studio-mac');
    expect(controller.cancelActivation('build-box')).toBe(true);
    expect(controller.takeCancelBeforeCommit('build-box')).toBe(true);
    expect(controller.takeCancelBeforeCommit('build-box')).toBe(false);
    controller.commitActivation();
    await controller.syncToConfig();
    await sleep(100);
    expect(controller.getActiveRemoteClient()?.profile.id).toBe('studio-mac');
    expect(controller.getConnectionState()).toMatchObject({ status: 'connected', activeProfileId: 'studio-mac' });
    expect(studioServer.getEventRequestCount()).toBe(studioDials);
    expect(buildServer.getEventRequestCount()).toBeGreaterThan(0);
    await controller.switchToLocalMode();
  });

  it('a switch committed with no cancel moves the window then, and a cancel after that is refused', async () => {
    const { controller, build } = await onStudio({ renderers: true });
    await controller.activateProfile(primaryProfile(build));
    expect(controller.takeCancelBeforeCommit('build-box')).toBe(false);
    controller.commitActivation();
    expect(controller.getActiveRemoteClient()?.profile.id).toBe('build-box');
    expect(controller.cancelActivation('build-box')).toBe(false);
    await controller.switchToLocalMode();
  });

  it('a switch that completes moves the window to the new machine and closes the old connection', async () => {
    const { controller, states, build } = await onStudio();
    await controller.activateProfile(primaryProfile(build));
    controller.commitActivation();
    await waitFor(() => controller.getConnectionState().status === 'connected' && controller.getConnectionState().activeProfileId === 'build-box');
    expect(controller.getActiveRemoteClient()?.profile.id).toBe('build-box');
    expect(states.at(-1)).toBe('connected:build-box');
    await controller.switchToLocalMode();
  });
});
