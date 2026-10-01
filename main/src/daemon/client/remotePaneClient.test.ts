import http, { type IncomingMessage, type ServerResponse } from 'http';
import { EventEmitter } from 'events';
import { hostname as getOsHostname } from 'os';
import type { LookupFunction } from 'net';
import { afterEach, describe, expect, it } from 'vitest';
import { createDefaultRemoteDaemonConfig, type RemoteDaemonConfig } from '../../../../shared/types/remoteDaemon';
import type { PaneEventSink } from '../../core/eventSink';
import { RemotePaneClient, RemotePaneClientController } from './remotePaneClient';
import { boundary, decodeBoundary, type JsonValue } from '../../../../shared/validation/boundaryDecoder';

interface TestRemoteServer {
  baseUrl: string;
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

afterEach(async () => {
  while (activeServers.length > 0) {
    await activeServers.pop()?.close();
  }
});

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

  it('falls back to a stored Tailscale IP when macOS cannot resolve a ts.net host', async () => {
    const server = await createTestRemoteServer();
    activeServers.push(server);
    const serverUrl = new URL(server.baseUrl);
    const tailscaleHost = 'pane-unresolvable-for-test.invalid.ts.net';
    // Fail the lookup here instead of asking real DNS: a slow NXDOMAIN outlasted the test timeout.
    const unresolvableLookup: LookupFunction = (hostname, _options, callback) => {
      const error: NodeJS.ErrnoException = Object.assign(new Error(`getaddrinfo ENOTFOUND ${hostname}`), {
        code: 'ENOTFOUND',
        hostname,
      });
      process.nextTick(() => callback(error, '', 0));
    };

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
    }, { lookup: unresolvableLookup });

    await expect(client.invoke('sessions:get-all', ['session-1'])).resolves.toEqual({
      channel: 'sessions:get-all',
      args: ['session-1'],
    });

    expect(server.getLastInvokeAuth()).toBe('Bearer secret-token');
    expect(server.getLastInvokeHost()).toBe(`${tailscaleHost}:${serverUrl.port}`);
  });

  it('refuses to send the token over plain HTTP outside the tailnet, before connecting', async () => {
    const server = await createTestRemoteServer();
    activeServers.push(server);
    const port = new URL(server.baseUrl).port;
    const profile = { id: 'p', label: 'Cloud', token: 'secret-token', transport: 'http+sse' as const };
    // A hijacked resolver answers the MagicDNS name with a public address.
    const publicLookup: LookupFunction = (_hostname, _options, callback) => {
      process.nextTick(() => callback(null, [{ address: '93.184.216.34', family: 4 }]));
    };
    const onTailnet = () => ({ tailscale0: [{ address: '100.101.102.103', netmask: '255.192.0.0', family: 'IPv4' as const, mac: '00:00:00:00:00:00', internal: false, cidr: '100.101.102.103/10' }] });
    const hijacked = new RemotePaneClient({ ...profile, baseUrl: `http://rp-a.tail.ts.net:${port}` }, { lookup: publicLookup, networkInterfaces: onTailnet });
    await expect(hijacked.invoke('sessions:get-all', [])).rejects.toMatchObject({ code: 'ERR_PLAIN_HTTP_OFF_TAILNET' });

    // Tailscale off: a carrier-grade NAT address on the LTE interface is not the tailnet.
    const offTailnet = () => ({ wwan0: [{ address: '100.72.9.14', netmask: '255.192.0.0', family: 'IPv4' as const, mac: '00:00:00:00:00:00', internal: false, cidr: '100.72.9.14/10' }] });
    const cgnat = new RemotePaneClient({ ...profile, baseUrl: `http://100.90.1.2:${port}` }, { networkInterfaces: offTailnet });
    await expect(cgnat.invoke('sessions:get-all', [])).rejects.toMatchObject({ code: 'ERR_PLAIN_HTTP_OFF_TAILNET' });

    expect(server.getLastInvokeAuth()).toBeUndefined();
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

  it('retries stale remote event streams five times before surfacing a hard error', async () => {
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
      reconnectInitialDelayMs: 5,
      reconnectMaxDelayMs: 20,
      reconnectErrorThreshold: 5,
      onConnectionStateChange(status, errorMessage) {
        connectionStates.push({ status, errorMessage });
      },
    });

    await client.connect({ retryOnInitialFailure: false });
    server.setEventsReady(false);

    await waitFor(() => connectionStates.some((state) => state.status === 'error'), 1_500);

    const firstErrorIndex = connectionStates.findIndex((state) => state.status === 'error');
    expect(firstErrorIndex).toBeGreaterThan(-1);
    expect(server.getEventRequestCount()).toBe(6);
    expect(connectionStates.slice(0, firstErrorIndex).filter((state) => state.status === 'reconnecting').length)
      .toBeGreaterThanOrEqual(5);
    expect(connectionStates[firstErrorIndex].errorMessage).toBe('Remote daemon not ready yet');

    await client.disconnect();
  });

  // The desktop names `runpane cloud wake` while a cloud host is retrying after a failure; a retry
  // attempt must not clear the reason, or the hint only shows between attempts.
  it('keeps the failure reason on every retry attempt', async () => {
    const server = await createTestRemoteServer();
    activeServers.push(server);
    server.setEventsReady(false);
    const connectionStates: Array<{ status: string; errorMessage: string | null | undefined }> = [];

    const client = new RemotePaneClient({
      id: 'profile-retry-reason',
      label: 'Remote host',
      baseUrl: server.baseUrl,
      token: 'secret-token',
      transport: 'http+sse',
    }, {
      reconnectInitialDelayMs: 5,
      reconnectMaxDelayMs: 20,
      reconnectErrorThreshold: 3,
      onConnectionStateChange(status, errorMessage) {
        connectionStates.push({ status, errorMessage });
      },
    });

    await expect(client.connect({ retryOnInitialFailure: true })).rejects.toThrow();
    await waitFor(() => connectionStates.some((state) => state.status === 'error'), 1_500);

    const retries = connectionStates.filter((state) => state.status === 'reconnecting');
    expect(retries.length).toBeGreaterThanOrEqual(3);
    expect(retries.every((state) => state.errorMessage === 'Remote daemon not ready yet')).toBe(true);
    expect(connectionStates[0]).toEqual({ status: 'connecting', errorMessage: null });

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
      reconnectInitialDelayMs: 5,
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
      reconnectInitialDelayMs: 5,
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

describe('RemotePaneClientController', () => {
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

    const controller = new RemotePaneClientController();
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

    const controller = new RemotePaneClientController();
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

    const controller = new RemotePaneClientController();
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

    const controller = new RemotePaneClientController();
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

  it('restores the saved local state when a manual activation fails', async () => {
    const server = await createTestRemoteServer();
    activeServers.push(server);
    server.setEventsReady(false);

    const configManager = createConfigManagerStub(createDefaultRemoteDaemonConfig());
    const controller = new RemotePaneClientController();
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
  const normalizedBasePath = normalizeTestBasePath(basePath);
  const invokePath = `${normalizedBasePath}/invoke`;
  const eventsPath = `${normalizedBasePath}/events`;

  const server = http.createServer(async (request: IncomingMessage, response: ServerResponse) => {
    if (request.url === invokePath) {
      lastInvokeAuth = request.headers.authorization;
      lastInvokeBody = await readRequestBody(request);
      lastInvokeHost = request.headers.host;
      lastInvokePath = request.url;
      const parsed = decodeBoundary(JSON.parse(lastInvokeBody), boundary.object({
        channel: boundary.string,
        args: boundary.array(boundary.json),
      }));
      response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
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
        response.write(`data: ${JSON.stringify({ replay: 'none', resync: 'refetch-state-after-reconnect', timestamp: new Date().toISOString() })}\n\n`);
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
      if (streamResponse && !streamResponse.writableEnded) {
        streamResponse.end();
      }

      await new Promise<void>((resolve) => {
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
