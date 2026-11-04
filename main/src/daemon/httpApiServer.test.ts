import http from 'http';
import zlib from 'zlib';
import WebSocket from 'ws';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDefaultRemoteDaemonConfig, NATIVE_APP_WEBSOCKET_ORIGIN, type RemoteDaemonConfig, type RemoteInvokeRequest } from '../../../shared/types/remoteDaemon';
import { PaneCommandRegistry } from './commandRegistry';
import { hashRemoteDaemonToken } from './auth';
import { boundary, decodeBoundary, type JsonValue } from '../../../shared/validation/boundaryDecoder';

import { PaneRemoteHttpApiServer, type WorkspaceAccessPolicy } from './httpApiServer';
import { RecentWrites } from './recentWrites';
import { PaneError } from '../../../shared/paneError';

interface ConfigManagerStub {
  getConfig(): { deepgramApiKey?: string; remoteDaemon?: RemoteDaemonConfig };
}

interface TestEventStream {
  contentEncoding: string | undefined;
  close(): void;
  nextEvent(timeoutMs?: number): Promise<{ event: string | null; data: string[] }>;
}

interface RequestHeaders {
  [name: string]: string;
}

const activeServers: PaneRemoteHttpApiServer[] = [];
const activeRequests = new Set<http.ClientRequest>();

afterEach(async () => {
  for (const request of activeRequests) {
    request.destroy();
  }
  activeRequests.clear();

  for (const server of activeServers.splice(0)) {
    await server.stop();
  }
});

function createConfigManagerStub(config?: RemoteDaemonConfig): ConfigManagerStub {
  const remoteDaemon = config;

  return {
    getConfig() {
      return { remoteDaemon };
    },
  };
}

function createEnabledRemoteConfig(overrides?: Partial<RemoteDaemonConfig['host']['config']>): RemoteDaemonConfig {
  const config = createDefaultRemoteDaemonConfig();
  config.host.config = {
    ...config.host.config,
    enabled: true,
    listenHost: '127.0.0.1',
    listenPort: 0,
    ...overrides,
  };
  config.host.clients = [{
    id: 'client-1',
    label: 'Mac mini',
    createdAt: new Date('2026-05-14T00:00:00.000Z').toISOString(),
    tokenHash: hashRemoteDaemonToken('secret-token'),
  }];
  return config;
}

async function requestJson(
  server: PaneRemoteHttpApiServer,
  method: 'GET' | 'POST',
  path: string,
  body?: JsonValue,
  token?: string,
  extraHeaders?: Record<string, string>,
): Promise<{ statusCode: number; body: JsonValue }> {
  const address = server.getAddress();
  if (!address) {
    throw new Error('Remote HTTP API server is not listening');
  }

  return new Promise((resolve, reject) => {
    const requestHeaders: RequestHeaders = {};
    if (token) {
      requestHeaders.Authorization = `Bearer ${token}`;
    }
    if (body !== undefined) {
      requestHeaders['Content-Type'] = 'application/json';
    }
    Object.assign(requestHeaders, extraHeaders);
    const request = http.request({
      host: address.host,
      port: address.port,
      path,
      method,
      headers: requestHeaders,
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk) => {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      });
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve({
          statusCode: response.statusCode ?? 0,
          body: text.length > 0 ? decodeBoundary(JSON.parse(text), boundary.json) : null,
        });
      });
    });

    activeRequests.add(request);
    request.once('error', reject);
    if (body !== undefined) {
      request.write(JSON.stringify(body));
    }
    request.end();
  });
}

async function requestRaw(
  server: PaneRemoteHttpApiServer,
  method: 'GET' | 'POST' | 'OPTIONS',
  path: string,
  headers?: Record<string, string>,
): Promise<{ statusCode: number; headers: http.IncomingHttpHeaders; body: string }> {
  const address = server.getAddress();
  if (!address) {
    throw new Error('Remote HTTP API server is not listening');
  }

  return new Promise((resolve, reject) => {
    const request = http.request({
      host: address.host,
      port: address.port,
      path,
      method,
      headers,
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk) => {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      });
      response.on('end', () => {
        resolve({
          statusCode: response.statusCode ?? 0,
          headers: response.headers,
          body: Buffer.concat(chunks).toString('utf8'),
        });
      });
    });

    activeRequests.add(request);
    request.once('error', reject);
    request.end();
  });
}

async function openEventStream(
  server: PaneRemoteHttpApiServer,
  token?: string,
  headers?: Record<string, string>,
  path = '/events',
): Promise<TestEventStream> {
  const address = server.getAddress();
  if (!address) {
    throw new Error('Remote HTTP API server is not listening');
  }

  return new Promise((resolve, reject) => {
    const requestHeaders: RequestHeaders = { ...headers };
    if (token) {
      requestHeaders.Authorization = `Bearer ${token}`;
    }
    const request = http.request({
      host: address.host,
      port: address.port,
      path,
      method: 'GET',
      headers: requestHeaders,
    });

    activeRequests.add(request);
    request.once('error', reject);
    request.on('response', (response) => {
      const queuedEvents: Array<{ event: string | null; data: string[] }> = [];
      const waiters: Array<(event: { event: string | null; data: string[] }) => void> = [];
      let buffer = '';
      const contentEncoding = response.headers['content-encoding'];
      const body = contentEncoding === 'gzip' ? response.pipe(zlib.createGunzip()) : response;

      body.on('data', (chunk) => {
        buffer += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);

        let boundaryIndex = buffer.indexOf('\n\n');
        while (boundaryIndex !== -1) {
          const rawEvent = buffer.slice(0, boundaryIndex);
          buffer = buffer.slice(boundaryIndex + 2);

          const parsedEvent = parseSseEvent(rawEvent);
          if (parsedEvent) {
            const waiter = waiters.shift();
            if (waiter) {
              waiter(parsedEvent);
            } else {
              queuedEvents.push(parsedEvent);
            }
          }

          boundaryIndex = buffer.indexOf('\n\n');
        }
      });

      resolve({
        contentEncoding,
        close() {
          request.destroy();
        },
        nextEvent(timeoutMs = 1000) {
          if (queuedEvents.length > 0) {
            const queuedEvent = queuedEvents.shift();
            if (queuedEvent) {
              return Promise.resolve(queuedEvent);
            }
          }

          return new Promise((eventResolve, eventReject) => {
            const timeout = setTimeout(() => {
              eventReject(new Error('Timed out waiting for SSE event'));
            }, timeoutMs);

            waiters.push((event) => {
              clearTimeout(timeout);
              eventResolve(event);
            });
          });
        },
      });
    });

    request.end();
  });
}

function parseSseEvent(rawEvent: string): { event: string | null; data: string[] } | null {
  const lines = rawEvent.split('\n');
  let event: string | null = null;
  const data: string[] = [];

  for (const line of lines) {
    if (line.startsWith('event: ')) {
      event = line.slice('event: '.length);
      continue;
    }

    if (line.startsWith('data: ')) {
      data.push(line.slice('data: '.length));
    }
  }

  if (!event && data.length === 0) {
    return null;
  }

  return { event, data };
}

async function waitFor(predicate: () => boolean, timeoutMs = 1500): Promise<void> {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error('Timed out waiting for condition');
    }

    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe('PaneRemoteHttpApiServer', () => {
  it.each(['mobile:push-status', 'mobile:push-register', 'mobile:push-controls', 'mobile:push-revoke', 'credentials:shared:get', 'credentials:shared:apply'])(
    'uses the authenticated client for %s even when extra arguments forge an identity', async channel => {
      const registry = new PaneCommandRegistry();
      const handler = vi.fn(async () => ({ ok: true }));
      registry.register(channel, handler);
      const server = new PaneRemoteHttpApiServer(registry, createConfigManagerStub(createEnabledRemoteConfig()));
      activeServers.push(server);
      await server.start();
      const input = { platform: 'ios', installationId: 'install-1' };
      await expect(requestJson(server, 'POST', '/invoke', {
        channel, args: [input, { clientId: 'victim-client' }],
      }, 'secret-token')).resolves.toMatchObject({ statusCode: 200, body: { ok: true } });
      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler).toHaveBeenCalledWith(input, { clientId: 'client-1' });
    },
  );

  it('names the device that sent a Notify answer from its own stream, never from the arguments', async () => {
    const registry = new PaneCommandRegistry();
    const handler = vi.fn(async () => null);
    registry.register('notify:remote-command', handler);
    const server = new PaneRemoteHttpApiServer(registry, createConfigManagerStub(createEnabledRemoteConfig()));
    activeServers.push(server);
    await server.start();
    const answer = { type: 'answer', id: 'question-1', answer: { approved: true } };

    await requestJson(server, 'POST', '/invoke', { channel: 'notify:remote-command', args: [answer, { device: 'Someone else' }] }, 'secret-token');
    expect(handler).toHaveBeenLastCalledWith(answer, { device: 'Mac mini' });

    const stream = await openEventStream(server, 'secret-token', {
      'X-Pane-Remote-Runtime-Id': 'phone-runtime',
      'X-Pane-Client-Device-Label': encodeURIComponent('Parsa’s iPhone'),
    });
    await stream.nextEvent();
    await requestJson(server, 'POST', '/invoke', { channel: 'notify:remote-command', args: [answer] }, 'secret-token', { 'X-Pane-Remote-Runtime-Id': 'phone-runtime' });
    expect(handler).toHaveBeenLastCalledWith(answer, { device: 'Parsa’s iPhone' });

    // An alert button pressed with the app closed: no stream, the name rides on the request.
    await requestJson(server, 'POST', '/invoke', { channel: 'notify:remote-command', args: [answer] }, 'secret-token', {
      'X-Pane-Remote-Runtime-Id': 'other-phone', 'X-Pane-Client-Device-Label': encodeURIComponent('Parsa’s iPad'),
    });
    expect(handler).toHaveBeenLastCalledWith(answer, { device: 'Parsa’s iPad' });
  });

  it('answers a Notify refusal as a definite 409, so a client reports it as not sent', async () => {
    const registry = new PaneCommandRegistry();
    registry.register('notify:remote-command', async () => {
      throw new PaneError('ERR_NOTIFY_INVALID', "That answer doesn't fit this options question. Nothing was sent.", "Answer with one of the question's choices.");
    });
    const server = new PaneRemoteHttpApiServer(registry, createConfigManagerStub(createEnabledRemoteConfig()));
    activeServers.push(server);
    await server.start();

    await expect(requestJson(server, 'POST', '/invoke', {
      channel: 'notify:remote-command', args: [{ type: 'answer', id: 'question-1', answer: { choice: 'MongoDB' } }],
    }, 'secret-token')).resolves.toMatchObject({
      statusCode: 409,
      body: { ok: false, error: { code: 'ERR_NOTIFY_INVALID', next: "Answer with one of the question's choices." } },
    });
  });

  it.each(['credentials:shared:get', 'credentials:shared:apply'])(
    'refuses %s when the host does not require pairing, so no unpaired caller reads keys', async channel => {
      const registry = new PaneCommandRegistry();
      const handler = vi.fn(async () => ({}));
      registry.register(channel, handler);
      const server = new PaneRemoteHttpApiServer(registry, createConfigManagerStub(createEnabledRemoteConfig({ pairingRequired: false })));
      activeServers.push(server);
      await server.start();

      await expect(requestJson(server, 'POST', '/invoke', { channel, args: [{}] })).resolves.toMatchObject({ statusCode: 403, body: { ok: false } });
      expect(handler).not.toHaveBeenCalled();
    },
  );

  it('invokes daemon-owned commands over authenticated HTTP', async () => {
    const registry = new PaneCommandRegistry();
    registry.register('sessions:get-all', async () => [{ id: 'session-1' }]);

    const server = new PaneRemoteHttpApiServer(registry, createConfigManagerStub(createEnabledRemoteConfig()));
    activeServers.push(server);
    await server.start();

    await expect(requestJson(server, 'POST', '/invoke', {
      channel: 'sessions:get-all',
      args: [],
    }, 'secret-token')).resolves.toEqual({
      statusCode: 200,
      body: {
        ok: true,
        result: [{ id: 'session-1' }],
      },
    });
  });

  it('accepts browser invoke auth metadata from a simple request body', async () => {
    const registry = new PaneCommandRegistry();
    registry.register('sessions:get-all', async () => [{ id: 'session-1' }]);

    const server = new PaneRemoteHttpApiServer(registry, createConfigManagerStub(createEnabledRemoteConfig()));
    activeServers.push(server);
    await server.start();

    await expect(requestJson(server, 'POST', '/invoke', {
      channel: 'sessions:get-all',
      args: [],
      token: 'secret-token',
      runtimeId: 'browser-runtime-1',
      clientLabel: 'Pane PWA on iPhone',
    }, undefined, {
      'Content-Type': 'text/plain;charset=UTF-8',
    })).resolves.toEqual({
      statusCode: 200,
      body: {
        ok: true,
        result: [{ id: 'session-1' }],
      },
    });
  });

  it('scopes terminal visibility invokes to the authenticated remote runtime', async () => {
    const registry = new PaneCommandRegistry();
    const handler = vi.fn(async () => ({ ok: true }));
    registry.register('terminal:setVisibility', handler);

    const server = new PaneRemoteHttpApiServer(registry, createConfigManagerStub(createEnabledRemoteConfig()));
    activeServers.push(server);
    await server.start();

    await expect(requestJson(server, 'POST', '/invoke', {
      channel: 'terminal:setVisibility',
      args: ['panel-1', true, 'renderer-viewer-1'],
    }, 'secret-token', {
      'X-Pane-Remote-Runtime-Id': 'runtime-1',
    })).resolves.toMatchObject({
      statusCode: 200,
      body: { ok: true },
    });

    expect(handler).toHaveBeenCalledWith(
      'panel-1',
      true,
      'remote:client-1:runtime-1:viewer:renderer-viewer-1',
    );
  });

  it('scopes terminal acknowledgements to the authenticated remote runtime', async () => {
    const registry = new PaneCommandRegistry();
    const handler = vi.fn(async () => ({ ok: true }));
    registry.register('terminal:ack', handler);

    const server = new PaneRemoteHttpApiServer(registry, createConfigManagerStub(createEnabledRemoteConfig()));
    activeServers.push(server);
    await server.start();

    await expect(requestJson(server, 'POST', '/invoke', {
      channel: 'terminal:ack',
      args: ['panel-1', 42, 'renderer-viewer-1'],
    }, 'secret-token', {
      'X-Pane-Remote-Runtime-Id': 'runtime-1',
    })).resolves.toMatchObject({
      statusCode: 200,
      body: { ok: true },
    });

    expect(handler).toHaveBeenCalledWith(
      'panel-1',
      42,
      'remote:client-1:runtime-1:viewer:renderer-viewer-1',
    );
  });

  it('scopes browser terminal visibility invokes to the body runtime id', async () => {
    const registry = new PaneCommandRegistry();
    const handler = vi.fn(async () => ({ ok: true }));
    registry.register('terminal:setVisibility', handler);

    const server = new PaneRemoteHttpApiServer(registry, createConfigManagerStub(createEnabledRemoteConfig()));
    activeServers.push(server);
    await server.start();

    await expect(requestJson(server, 'POST', '/invoke', {
      channel: 'terminal:setVisibility',
      args: ['panel-1', true, 'renderer-viewer-1'],
      token: 'secret-token',
      runtimeId: 'browser-runtime-1',
    }, undefined, {
      'Content-Type': 'text/plain;charset=UTF-8',
    })).resolves.toMatchObject({
      statusCode: 200,
      body: { ok: true },
    });

    expect(handler).toHaveBeenCalledWith(
      'panel-1',
      true,
      'remote:client-1:browser-runtime-1:viewer:renderer-viewer-1',
    );
  });

  it('rejects invoke requests without bearer auth', async () => {
    const registry = new PaneCommandRegistry();
    registry.register('sessions:get-all', async () => []);

    const server = new PaneRemoteHttpApiServer(registry, createConfigManagerStub(createEnabledRemoteConfig()));
    activeServers.push(server);
    await server.start();

    await expect(requestJson(server, 'POST', '/invoke', {
      channel: 'sessions:get-all',
      args: [],
    })).resolves.toEqual({
      statusCode: 401,
      body: {
        ok: false,
        statusCode: 401,
        error: {
          message: 'Remote daemon bearer token is required',
          code: 'ERR_REMOTE_DAEMON_AUTH_REQUIRED',
        },
      },
    });
  });

  it('allows unauthenticated remote requests when pairing is disabled', async () => {
    const registry = new PaneCommandRegistry();
    registry.register('sessions:get-all', async () => [{ id: 'session-1' }]);

    const server = new PaneRemoteHttpApiServer(
      registry,
      createConfigManagerStub(createEnabledRemoteConfig({ pairingRequired: false })),
    );
    activeServers.push(server);
    await server.start();

    await expect(requestJson(server, 'POST', '/invoke', {
      channel: 'sessions:get-all',
      args: [],
    })).resolves.toEqual({
      statusCode: 200,
      body: {
        ok: true,
        result: [{ id: 'session-1' }],
      },
    });

    const stream = await openEventStream(server);
    const readyEvent = await stream.nextEvent();
    expect(readyEvent.event).toBe('ready');

    stream.close();
  });

  it('exposes an unauthenticated health endpoint for hosted readiness checks', async () => {
    const registry = new PaneCommandRegistry();
    const server = new PaneRemoteHttpApiServer(registry, createConfigManagerStub(createEnabledRemoteConfig()));
    activeServers.push(server);
    await server.start();

    await expect(requestJson(server, 'GET', '/health')).resolves.toEqual({
      statusCode: 200,
      body: {
        ok: true,
        status: 'ready',
        transport: 'http+sse',
      },
    });
  });

  it('supports browser CORS preflights for PWA remote clients', async () => {
    const registry = new PaneCommandRegistry();
    const server = new PaneRemoteHttpApiServer(registry, createConfigManagerStub(createEnabledRemoteConfig()));
    activeServers.push(server);
    await server.start();

    await expect(requestRaw(server, 'OPTIONS', '/invoke', {
      Origin: 'http://localhost:5757',
      'Access-Control-Request-Method': 'POST',
      'Access-Control-Request-Headers': 'authorization,content-type,x-pane-remote-runtime-id,x-pane-remote-client-label',
    })).resolves.toMatchObject({
      statusCode: 204,
      headers: {
        'access-control-allow-origin': '*',
        'access-control-allow-methods': 'GET, POST, OPTIONS',
        'access-control-allow-headers': expect.stringContaining('Authorization'),
      },
      body: '',
    });

    await expect(requestRaw(server, 'GET', '/health', {
      Origin: 'http://localhost:5757',
    })).resolves.toMatchObject({
      statusCode: 200,
      headers: {
        'access-control-allow-origin': '*',
      },
    });
  });

  it('rejects oversized invoke request bodies with a client error', async () => {
    const registry = new PaneCommandRegistry();
    registry.register('sessions:get-all', async () => []);

    const server = new PaneRemoteHttpApiServer(registry, createConfigManagerStub(createEnabledRemoteConfig()));
    activeServers.push(server);
    await server.start();

    const oversizedArgs = ['x'.repeat(1024 * 1024)];
    await expect(requestJson(server, 'POST', '/invoke', {
      channel: 'sessions:get-all',
      args: oversizedArgs,
      token: 'secret-token',
    })).resolves.toEqual({
      statusCode: 413,
      body: {
        ok: false,
        error: {
          message: 'Remote daemon request body exceeds the 1 MB limit',
          code: 'ERR_REMOTE_DAEMON_REQUEST_TOO_LARGE',
        },
      },
    });
  });

  it('allows larger invoke bodies after header authentication', async () => {
    const registry = new PaneCommandRegistry();
    registry.register('sessions:get-all', async (value) => decodeBoundary(value, boundary.string).length);

    const server = new PaneRemoteHttpApiServer(registry, createConfigManagerStub(createEnabledRemoteConfig()));
    activeServers.push(server);
    await server.start();

    const largeArg = 'x'.repeat(1024 * 1024);
    await expect(requestJson(server, 'POST', '/invoke', {
      channel: 'sessions:get-all',
      args: [largeArg],
    }, 'secret-token')).resolves.toEqual({
      statusCode: 200,
      body: {
        ok: true,
        result: largeArg.length,
      },
    });
  });

  it('streams a ready event and daemon-owned runtime events over SSE', async () => {
    const registry = new PaneCommandRegistry();
    const server = new PaneRemoteHttpApiServer(registry, createConfigManagerStub(createEnabledRemoteConfig()));
    activeServers.push(server);
    await server.start();

    const stream = await openEventStream(server, 'secret-token', {
      'X-Pane-Client-Device-Label': 'Parsas MacBook Air',
    });
    const readyEvent = await stream.nextEvent();
    expect(readyEvent.event).toBe('ready');
    expect(JSON.parse(readyEvent.data.join('\n'))).toMatchObject({
      replay: 'none',
      resync: 'refetch-state-after-reconnect',
    });

    const heartbeatEvent = await stream.nextEvent();
    expect(heartbeatEvent.event).toBe('heartbeat');
    expect(JSON.parse(heartbeatEvent.data.join('\n'))).toEqual({
      timestamp: expect.any(String),
    });
    expect(server.getConnectedClients()).toMatchObject([{
      clientId: 'client-1',
      label: 'Mac mini',
      deviceLabel: 'Parsas MacBook Air',
      remoteAddress: expect.any(String),
      connectedAt: expect.any(String),
      lastSeenAt: expect.any(String),
    }]);

    server.getEventSink().send('session:created', {
      id: 'session-1',
      omitted: undefined,
      timestamp: new Date('2026-08-17T00:00:00.000Z'),
    });

    const daemonEvent = await stream.nextEvent();
    expect(daemonEvent.event).toBe('daemon-event');
    expect(JSON.parse(daemonEvent.data.join('\n'))).toEqual({
      channel: 'session:created',
      args: [{
        id: 'session-1',
        timestamp: '2026-08-17T00:00:00.000Z',
      }],
      timestamp: expect.any(String),
    });

    stream.close();
    await waitFor(() => server.getConnectedClients().length === 0);
  });

  it('gzips the event stream for clients that accept it and still delivers each event immediately', async () => {
    const server = new PaneRemoteHttpApiServer(new PaneCommandRegistry(), createConfigManagerStub(createEnabledRemoteConfig()));
    activeServers.push(server);
    await server.start();

    const plainStream = await openEventStream(server, 'secret-token');
    expect(plainStream.contentEncoding).toBeUndefined();
    plainStream.close();

    const stream = await openEventStream(server, 'secret-token', { 'Accept-Encoding': 'gzip, deflate, br' });
    expect(stream.contentEncoding).toBe('gzip');
    expect((await stream.nextEvent()).event).toBe('ready');
    expect((await stream.nextEvent()).event).toBe('heartbeat');

    server.getEventSink().send('terminal:output', { sessionId: 'session-1', panelId: 'panel-1', output: 'hello\r\n' });
    const daemonEvent = await stream.nextEvent();
    expect(JSON.parse(daemonEvent.data.join('\n'))).toMatchObject({
      channel: 'terminal:output',
      args: [{ sessionId: 'session-1', panelId: 'panel-1', output: 'hello\r\n' }],
    });
    stream.close();
  });

  it('gzips large invoke results only for clients that accept gzip', async () => {
    const registry = new PaneCommandRegistry();
    const sessions = Array.from({ length: 50 }, (_, index) => ({ id: `session-${index}`, name: `Pane ${index}` }));
    registry.register('sessions:get-all', async () => sessions);
    const server = new PaneRemoteHttpApiServer(registry, createConfigManagerStub(createEnabledRemoteConfig()));
    activeServers.push(server);
    await server.start();
    const address = server.getAddress();
    if (!address) throw new Error('Remote HTTP API server is not listening');

    const invoke = (headers: Record<string, string>) => new Promise<http.IncomingMessage & { raw: Buffer }>((resolve, reject) => {
      const request = http.request({
        host: address.host,
        port: address.port,
        path: '/invoke',
        method: 'POST',
        headers: { Authorization: 'Bearer secret-token', 'Content-Type': 'application/json', ...headers },
      }, (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('end', () => resolve(Object.assign(response, { raw: Buffer.concat(chunks) })));
      });
      activeRequests.add(request);
      request.once('error', reject);
      request.end(JSON.stringify({ channel: 'sessions:get-all', args: [] }));
    });

    const plain = await invoke({});
    expect(plain.headers['content-encoding']).toBeUndefined();
    expect(JSON.parse(plain.raw.toString('utf8'))).toEqual({ ok: true, result: sessions });

    const compressed = await invoke({ 'Accept-Encoding': 'gzip, deflate, br' });
    expect(compressed.headers['content-encoding']).toBe('gzip');
    expect(compressed.raw.length).toBeLessThan(plain.raw.length);
    expect(JSON.parse(zlib.gunzipSync(compressed.raw).toString('utf8'))).toEqual({ ok: true, result: sessions });
  });

  it('accepts browser SSE auth metadata from query params', async () => {
    const registry = new PaneCommandRegistry();
    const server = new PaneRemoteHttpApiServer(registry, createConfigManagerStub(createEnabledRemoteConfig()));
    activeServers.push(server);
    await server.start();

    const stream = await openEventStream(
      server,
      undefined,
      undefined,
      '/events?access_token=secret-token&runtime_id=browser-runtime-1&client_label=Pane%20PWA%20on%20iPhone',
    );
    const readyEvent = await stream.nextEvent();
    expect(readyEvent.event).toBe('ready');

    const heartbeatEvent = await stream.nextEvent();
    expect(heartbeatEvent.event).toBe('heartbeat');
    expect(server.getConnectedClients()).toMatchObject([{
      clientId: 'client-1',
      label: 'Mac mini',
      remoteAddress: expect.any(String),
      connectedAt: expect.any(String),
      lastSeenAt: expect.any(String),
    }]);

    stream.close();
    await waitFor(() => server.getConnectedClients().length === 0);
  });

  it('checks browser SSE auth without registering a connected client', async () => {
    const registry = new PaneCommandRegistry();
    const server = new PaneRemoteHttpApiServer(registry, createConfigManagerStub(createEnabledRemoteConfig()));
    activeServers.push(server);
    await server.start();

    await expect(requestRaw(
      server,
      'GET',
      '/events?access_token=secret-token&runtime_id=browser-runtime-1&client_label=Pane%20PWA%20on%20iPhone&auth_check=1',
    )).resolves.toMatchObject({
      statusCode: 204,
      body: '',
    });
    expect(server.getConnectedClients()).toEqual([]);
  });

  it('filters non-daemon events from the remote SSE stream', async () => {
    const registry = new PaneCommandRegistry();
    const server = new PaneRemoteHttpApiServer(registry, createConfigManagerStub(createEnabledRemoteConfig()));
    activeServers.push(server);
    await server.start();

    const stream = await openEventStream(server, 'secret-token');
    await stream.nextEvent();
    await stream.nextEvent();

    server.getEventSink().send('version:update-available', { version: '1.2.3' });
    await expect(stream.nextEvent(100)).rejects.toThrow('Timed out waiting for SSE event');

    stream.close();
  });

  it('drops existing SSE subscribers when the paired client token rotates', async () => {
    const registry = new PaneCommandRegistry();
    const remoteConfig = createEnabledRemoteConfig();
    const server = new PaneRemoteHttpApiServer(registry, createConfigManagerStub(remoteConfig));
    activeServers.push(server);
    await server.start();

    const stream = await openEventStream(server, 'secret-token');
    await stream.nextEvent();
    await stream.nextEvent();

    remoteConfig.host.clients = [{
      ...remoteConfig.host.clients[0],
      tokenHash: hashRemoteDaemonToken('rotated-token'),
    }];

    server.getEventSink().send('session:created', { id: 'session-1' });
    await expect(stream.nextEvent(100)).rejects.toThrow('Timed out waiting for SSE event');

    stream.close();
  });

  it('refuses direct loopback HTTP when config disables insecure loopback mode', async () => {
    const registry = new PaneCommandRegistry();
    const server = new PaneRemoteHttpApiServer(
      registry,
      createConfigManagerStub(createEnabledRemoteConfig({ allowInsecureHttpOnLoopback: false })),
    );

    await expect(server.start()).rejects.toThrow('Remote daemon HTTP API loopback transport is disabled by config');
  });

  it('refuses direct HTTP on non-loopback listen hosts', async () => {
    const registry = new PaneCommandRegistry();
    const server = new PaneRemoteHttpApiServer(
      registry,
      createConfigManagerStub(createEnabledRemoteConfig({ listenHost: '0.0.0.0' })),
    );

    await expect(server.start()).rejects.toThrow(
      'Remote daemon direct HTTP only supports loopback listen hosts; keep listenHost on 127.0.0.1, ::1, or localhost and expose it through an SSH tunnel, Tailscale/VPN, or a reverse proxy.',
    );
  });
});

describe('writes carrying a request id', () => {
  async function startWithWrite(handler: () => Promise<JsonValue>) {
    const registry = new PaneCommandRegistry();
    const run = vi.fn(handler);
    registry.register('terminal:input', run);
    const server = new PaneRemoteHttpApiServer(registry, createConfigManagerStub(createEnabledRemoteConfig()));
    activeServers.push(server);
    await server.start();
    const send = (requestId?: string, token = 'secret-token') => {
      const body: RemoteInvokeRequest = { channel: 'terminal:input', args: ['panel-1', 'ls\r'] };
      if (requestId) body.requestId = requestId;
      return requestJson(server, 'POST', '/invoke', body, token);
    };
    return { server, run, send };
  }

  it('says so in the ready event', async () => {
    const { server } = await startWithWrite(async () => null);
    const ready = await (await openEventStream(server, 'secret-token')).nextEvent();
    expect(JSON.parse(ready.data.join('\n'))).toMatchObject({ deduplicatesRequestIds: true });
  });

  it('runs a repeated id once and answers the repeat with the first answer', async () => {
    let calls = 0;
    const { run, send } = await startWithWrite(async () => ({ call: ++calls }));
    await expect(send('phone:1')).resolves.toEqual({ statusCode: 200, body: { ok: true, result: { call: 1 } } });
    await expect(send('phone:1')).resolves.toEqual({ statusCode: 200, body: { ok: true, result: { call: 1 } } });
    await expect(send('phone:2')).resolves.toEqual({ statusCode: 200, body: { ok: true, result: { call: 2 } } });
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('makes a repeat that arrives while the first still runs wait for its answer', async () => {
    let finish!: () => void;
    const { run, send } = await startWithWrite(() => new Promise((resolve) => { finish = () => resolve('done'); }));
    const received = vi.spyOn(RecentWrites.prototype, 'answer');
    let settled = 0;
    const first = send('phone:1').finally(() => { settled += 1; });
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1));
    const repeat = send('phone:1').finally(() => { settled += 1; });
    // The host has the repeat in hand while the first is still running.
    await vi.waitFor(() => expect(received).toHaveBeenCalledTimes(2));
    expect(settled).toBe(0);
    expect(run).toHaveBeenCalledTimes(1);
    finish();
    await expect(Promise.all([first, repeat])).resolves.toEqual([
      { statusCode: 200, body: { ok: true, result: 'done' } },
      { statusCode: 200, body: { ok: true, result: 'done' } },
    ]);
    expect(run).toHaveBeenCalledTimes(1);
    received.mockRestore();
  });

  it('refuses a new write before running it while the client\'s memory of answers is full', async () => {
    const { run, send } = await startWithWrite(async () => 'ran');
    const full = vi.spyOn(RecentWrites.prototype, 'answer').mockReturnValue('full');
    await expect(send('phone:1')).resolves.toMatchObject({ statusCode: 503, body: { ok: false, error: { code: 'ERR_REMOTE_WRITES_BUSY' } } });
    expect(run).not.toHaveBeenCalled();
    full.mockRestore();
  });

  it('replays an error answer as the same error', async () => {
    const { run, send } = await startWithWrite(async () => { throw new Error('No terminal panel-1'); });
    const first = await send('phone:1');
    expect(first).toMatchObject({ statusCode: 500, body: { ok: false, error: { message: 'No terminal panel-1' } } });
    await expect(send('phone:1')).resolves.toEqual(first);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('runs every write that carries no id, as before', async () => {
    const { run, send } = await startWithWrite(async () => null);
    await send();
    await send();
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('does not remember a request refused for its credentials', async () => {
    const { run, send } = await startWithWrite(async () => 'ran');
    await expect(send('phone:1', 'wrong-token')).resolves.toMatchObject({ statusCode: 403, body: { ok: false } });
    await expect(send('phone:1')).resolves.toEqual({ statusCode: 200, body: { ok: true, result: 'ran' } });
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('runs an id again once ten minutes have passed since its answer', async () => {
    const { run, send } = await startWithWrite(async () => null);
    const start = Date.now();
    const now = vi.spyOn(Date, 'now').mockReturnValue(start);
    await send('phone:1');
    now.mockReturnValue(start + 9 * 60_000);
    await send('phone:1');
    expect(run).toHaveBeenCalledTimes(1);
    now.mockReturnValue(start + 10 * 60_000 + 1);
    await send('phone:1');
    expect(run).toHaveBeenCalledTimes(2);
    now.mockRestore();
  });

  it('keeps each client\'s ids apart', async () => {
    const config = createEnabledRemoteConfig();
    config.host.clients.push({ ...config.host.clients[0]!, id: 'client-2', tokenHash: hashRemoteDaemonToken('other-token') });
    const registry = new PaneCommandRegistry();
    const run = vi.fn(async () => null);
    registry.register('terminal:input', run);
    const server = new PaneRemoteHttpApiServer(registry, createConfigManagerStub(config));
    activeServers.push(server);
    await server.start();
    for (const token of ['secret-token', 'other-token']) {
      await requestJson(server, 'POST', '/invoke', { channel: 'terminal:input', args: ['panel-1', 'x'], requestId: 'same-id' }, token);
    }
    expect(run).toHaveBeenCalledTimes(2);
  });
});

describe('workspace identity mode', () => {
  const owner = 'owner@example.com';
  const teammate = 'teammate@example.com';

  function ownerOnly(overrides: Partial<WorkspaceAccessPolicy> = {}): WorkspaceAccessPolicy {
    return {
      ownerLogin: owner,
      visibility: 'owner',
      tailnetLogins: new Set([owner, teammate]),
      verifySecret: null,
      ...overrides,
    };
  }

  async function startWorkspaceServer(access: () => WorkspaceAccessPolicy | null) {
    const registry = new PaneCommandRegistry();
    registry.register('runpane:machine:info', () => ({ hostname: 'devbox' }));
    registry.register('runpane:workspaces:machines', () => ({ machines: ['private-laptop'] }));
    const server = new PaneRemoteHttpApiServer(registry, createConfigManagerStub(), {
      workspace: { listenPort: 0, pathSecret: 'serve-secret', access },
    });
    activeServers.push(server);
    await server.start();
    return server;
  }
  async function startOwnerServer(ownerLogin: string | null) {
    return startWorkspaceServer(() => (ownerLogin ? ownerOnly({ ownerLogin }) : null));
  }
  const invoke = { channel: 'runpane:machine:info', args: [] };
  // Tailscale Serve forwards /invoke to the target path, /serve-secret/invoke.
  const invokePath = '/serve-secret/invoke';
  const as = (login: string, password?: string) => {
    const headers: RequestHeaders = { 'Tailscale-User-Login': login };
    if (password !== undefined) headers.Authorization = `Bearer ${password}`;
    return headers;
  };
  const passwordIs = (expected: string) => (secret: string) => (secret === expected ? 'valid' as const : 'invalid' as const);

  it('under "Only me", refuses a different Tailscale login on the same tailnet', async () => {
    const server = await startWorkspaceServer(() => ownerOnly());
    const response = await requestJson(server, 'POST', invokePath, invoke, undefined, as(teammate));
    expect(response.statusCode).toBe(403);
    expect(JSON.stringify(response.body)).toContain('ERR_WORKSPACE_IDENTITY_REFUSED');
  });

  it('under "Everyone on this tailnet", lets a different login on the tailnet in', async () => {
    const server = await startWorkspaceServer(() => ownerOnly({ visibility: 'tailnet' }));
    const response = await requestJson(server, 'POST', invokePath, invoke, undefined, as(teammate));
    expect(response).toEqual({ statusCode: 200, body: { ok: true, result: { hostname: 'devbox' } } });
  });

  it('exposes discovery only to the signed owner even when teammates can connect', async () => {
    const server = await startWorkspaceServer(() => ownerOnly({ visibility: 'tailnet' }));
    const discovery = { channel: 'runpane:workspaces:machines', args: [] };
    const refused = await requestJson(server, 'POST', invokePath, discovery, undefined, as(teammate));
    expect(refused.statusCode).toBe(403);
    expect(refused.body).toMatchObject({ error: { code: 'ERR_WORKSPACE_DISCOVERY_OWNER_REQUIRED' } });
    const allowed = await requestJson(server, 'POST', invokePath, discovery, undefined, as(owner.toUpperCase()));
    expect(allowed).toEqual({ statusCode: 200, body: { ok: true, result: { machines: ['private-laptop'] } } });
  });

  it('under "Everyone on this tailnet", still refuses a login from outside the tailnet, such as a user a device was shared with', async () => {
    const server = await startWorkspaceServer(() => ownerOnly({ visibility: 'tailnet' }));
    const response = await requestJson(server, 'POST', invokePath, invoke, undefined, as('stranger@other.example'));
    expect(response.statusCode).toBe(403);
    expect(JSON.stringify(response.body)).toContain('ERR_WORKSPACE_IDENTITY_REFUSED');
  });

  it('with password protection on, makes every allowed client present the password, the owner included', async () => {
    const server = await startWorkspaceServer(() => ownerOnly({ visibility: 'tailnet', verifySecret: passwordIs('correct horse') }));
    for (const login of [owner, teammate]) {
      const missing = await requestJson(server, 'POST', invokePath, invoke, undefined, as(login));
      expect(missing.statusCode).toBe(401);
      expect(JSON.stringify(missing.body)).toContain('ERR_WORKSPACE_PASSWORD_REQUIRED');

      const wrong = await requestJson(server, 'POST', invokePath, invoke, undefined, as(login, 'guess'));
      expect(wrong.statusCode).toBe(401);
      expect(JSON.stringify(wrong.body)).toContain('ERR_WORKSPACE_PASSWORD_INVALID');

      const right = await requestJson(server, 'POST', invokePath, invoke, undefined, as(login, 'correct horse'));
      expect(right.statusCode).toBe(200);
    }
  });

  it('answers 429 once the password check is throttled for a login', async () => {
    const server = await startWorkspaceServer(() => ownerOnly({ verifySecret: () => 'throttled' }));
    const response = await requestJson(server, 'POST', invokePath, invoke, undefined, as(owner, 'any guess'));
    expect(response.statusCode).toBe(429);
    expect(JSON.stringify(response.body)).toContain('ERR_WORKSPACE_PASSWORD_THROTTLED');
  });

  it('checks visibility before the password, so a refused login learns nothing about it', async () => {
    const server = await startWorkspaceServer(() => ownerOnly({ verifySecret: passwordIs('correct horse') }));
    const response = await requestJson(server, 'POST', invokePath, invoke, undefined, as(teammate, 'correct horse'));
    expect(response.statusCode).toBe(403);
    expect(JSON.stringify(response.body)).toContain('ERR_WORKSPACE_IDENTITY_REFUSED');
  });

  it('gates the event stream the same way', async () => {
    const server = await startWorkspaceServer(() => ownerOnly({ verifySecret: passwordIs('correct horse') }));
    const refused = await requestRaw(server, 'GET', '/serve-secret/events', as(teammate));
    expect(refused.statusCode).toBe(403);
    const noPassword = await requestRaw(server, 'GET', '/serve-secret/events', as(owner));
    expect(noPassword.statusCode).toBe(401);
    const stream = await openEventStream(server, 'correct horse', as(owner), '/serve-secret/events');
    await expect(stream.nextEvent()).resolves.toMatchObject({ event: 'ready' });
    stream.close();
  });

  it('drops a connected client when the access it came in with no longer holds', async () => {
    let policy = ownerOnly({ visibility: 'tailnet' });
    const server = await startWorkspaceServer(() => policy);
    const stream = await openEventStream(server, undefined, as(teammate), '/serve-secret/events');
    await stream.nextEvent();
    await stream.nextEvent();

    policy = ownerOnly({ visibility: 'owner' });
    server.getEventSink().send('session:created', { id: 'session-1' });
    await expect(stream.nextEvent(100)).rejects.toThrow('Timed out waiting for SSE event');
    stream.close();
  });

  it.each([
    ['visibility narrows to "Only me"', ownerOnly({ visibility: 'owner' }), {}],
    ['password protection turns on', ownerOnly({ visibility: 'tailnet', verifySecret: passwordIs('correct horse') }), {}],
    [
      'the password changes',
      ownerOnly({ visibility: 'tailnet', verifySecret: passwordIs('new password') }),
      { previous: ownerOnly({ visibility: 'tailnet', verifySecret: passwordIs('old password') }), password: 'old password' },
    ],
  ])('refuses an invoke whose body finishes uploading after %s', async (_change, revoked, { previous, password }: { previous?: WorkspaceAccessPolicy; password?: string }) => {
    let policy = previous ?? ownerOnly({ visibility: 'tailnet' });
    let checks = 0;
    const server = await startWorkspaceServer(() => {
      checks += 1;
      return policy;
    });
    const address = server.getAddress();
    if (!address) throw new Error('Remote HTTP API server is not listening');

    const response = new Promise<{ statusCode: number; body: string }>((resolve, reject) => {
      const request = http.request({
        host: address.host,
        port: address.port,
        path: invokePath,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...as(teammate, password) },
      }, (res) => {
        let body = '';
        res.on('data', (chunk) => { body += chunk; });
        res.on('end', () => resolve({ statusCode: res.statusCode ?? 0, body }));
      });
      activeRequests.add(request);
      request.on('error', reject);
      const body = JSON.stringify(invoke);
      request.write(body.slice(0, 10));
      void vi.waitFor(() => expect(checks).toBeGreaterThan(0)).then(() => {
        policy = revoked;
        request.end(body.slice(10));
      });
    });

    const result = await response;
    expect(result.statusCode).toBeGreaterThanOrEqual(400);
    expect(result.body).not.toContain('devbox');
  });

  it('drops a connected client when password protection is turned on', async () => {
    let policy = ownerOnly();
    const server = await startWorkspaceServer(() => policy);
    const stream = await openEventStream(server, undefined, as(owner), '/serve-secret/events');
    await stream.nextEvent();
    await stream.nextEvent();

    policy = ownerOnly({ verifySecret: passwordIs('correct horse') });
    server.getEventSink().send('session:created', { id: 'session-1' });
    await expect(stream.nextEvent(100)).rejects.toThrow('Timed out waiting for SSE event');
    stream.close();
  });

  it('serves the owner\'s own Tailscale login without a pairing token', async () => {
    const server = await startOwnerServer('owner@example.com');
    const response = await requestJson(server, 'POST', invokePath, invoke, undefined, {
      'Tailscale-User-Login': 'owner@example.com',
    });
    expect(response).toEqual({ statusCode: 200, body: { ok: true, result: { hostname: 'devbox' } } });
  });

  it('refuses another Tailscale user and requests without an identity, such as tagged devices', async () => {
    const server = await startOwnerServer('owner@example.com');
    const otherUser = await requestJson(server, 'POST', invokePath, invoke, undefined, {
      'Tailscale-User-Login': 'teammate@example.com',
    });
    expect(otherUser.statusCode).toBe(403);
    expect(JSON.stringify(otherUser.body)).toContain('ERR_WORKSPACE_IDENTITY_REFUSED');

    const tagged = await requestJson(server, 'POST', invokePath, invoke);
    expect(tagged.statusCode).toBe(403);
    expect(JSON.stringify(tagged.body)).toContain('ERR_WORKSPACE_IDENTITY_REQUIRED');
  });

  it.each(['credentials:shared:get', 'credentials:shared:apply'])(
    'shares keys over %s with the owner only, even when teammates can connect', async (channel) => {
      const registry = new PaneCommandRegistry();
      const handler = vi.fn(async () => ({}));
      registry.register(channel, handler);
      const server = new PaneRemoteHttpApiServer(registry, createConfigManagerStub(), {
        workspace: { listenPort: 0, pathSecret: 'serve-secret', access: () => ownerOnly({ visibility: 'tailnet' }) },
      });
      activeServers.push(server);
      await server.start();
      const request = { channel, args: [{}, { clientId: 'forged' }] };

      const refused = await requestJson(server, 'POST', invokePath, request, undefined, as(teammate));
      expect(refused.statusCode).toBe(403);
      expect(refused.body).toMatchObject({ error: { code: 'ERR_SHARED_CREDENTIALS_OWNER_REQUIRED' } });
      expect(handler).not.toHaveBeenCalled();

      const allowed = await requestJson(server, 'POST', invokePath, request, undefined, as(owner.toUpperCase()));
      expect(allowed).toEqual({ statusCode: 200, body: { ok: true, result: {} } });
      expect(handler).toHaveBeenCalledWith({}, { clientId: `tailnet:${owner}` });
    },
  );

  it.each(['mobile:push-status', 'mobile:push-register', 'mobile:push-controls', 'mobile:push-revoke'])(
    'registers the owner\'s phone for push over %s without a pairing code, and refuses teammates', async (channel) => {
      const registry = new PaneCommandRegistry();
      const handler = vi.fn(async () => ({}));
      registry.register(channel, handler);
      const server = new PaneRemoteHttpApiServer(registry, createConfigManagerStub(), {
        workspace: { listenPort: 0, pathSecret: 'serve-secret', access: () => ownerOnly({ visibility: 'tailnet' }) },
      });
      activeServers.push(server);
      await server.start();
      const input = { platform: 'ios', installationId: 'install-1' };
      const request = { channel, args: [input, { clientId: 'forged' }] };

      const refused = await requestJson(server, 'POST', invokePath, request, undefined, as(teammate));
      expect(refused.statusCode).toBe(403);
      expect(refused.body).toMatchObject({ error: { code: 'ERR_MOBILE_PUSH_OWNER_REQUIRED' } });
      expect(handler).not.toHaveBeenCalled();

      const allowed = await requestJson(server, 'POST', invokePath, request, undefined, as(owner.toUpperCase()));
      expect(allowed).toEqual({ statusCode: 200, body: { ok: true, result: {} } });
      expect(handler).toHaveBeenCalledWith(input, { clientId: `tailnet:${owner}` });
    },
  );

  it.each(['notes:list', 'notes:mutate'])(
    'keeps notes over %s with the owner, even when teammates can connect', async (channel) => {
      const registry = new PaneCommandRegistry();
      const handler = vi.fn(async () => []);
      registry.register(channel, handler);
      const server = new PaneRemoteHttpApiServer(registry, createConfigManagerStub(), {
        workspace: { listenPort: 0, pathSecret: 'serve-secret', access: () => ownerOnly({ visibility: 'tailnet' }) },
      });
      activeServers.push(server);
      await server.start();
      const request = { channel, args: ['pane-1', { kind: 'global', id: 'user' }] };

      const refused = await requestJson(server, 'POST', invokePath, request, undefined, as(teammate));
      expect(refused.body).toEqual({ ok: false, error: {
        code: 'ERR_NOTES_OWNER_REQUIRED',
        message: 'Only this computer\'s owner can read or change its notes, so nothing was read or changed.',
        next: 'Sign in to Tailscale as this computer\'s owner, or keep your notes on your own computer.',
      } });
      expect(handler).not.toHaveBeenCalled();

      const allowed = await requestJson(server, 'POST', invokePath, request, undefined, as(owner));
      expect(allowed).toEqual({ statusCode: 200, body: { ok: true, result: [] } });
      expect(handler).toHaveBeenCalledWith('pane-1', { kind: 'global', id: 'user' });
    },
  );

  it('admits the voice stream upgrade, checking the same identity', async () => {
    vi.stubEnv('DEEPGRAM_API_KEY', '');
    const server = await startOwnerServer(owner);
    const address = server.getAddress();
    if (!address) throw new Error('Remote HTTP API server is not listening');
    const upgradeStatus = (headers: RequestHeaders) => new Promise<number>((resolve, reject) => {
      const socket = new WebSocket(`ws://127.0.0.1:${address.port}/serve-secret/voice/deepgram-stream`, { headers });
      socket.once('unexpected-response', (_request, response) => {
        resolve(response.statusCode ?? 0);
        socket.terminate();
      });
      socket.once('open', () => {
        socket.terminate();
        reject(new Error('voice stream opened without a Deepgram key'));
      });
      socket.once('error', reject);
    });
    // React Native always sends an Origin on a WebSocket; the app names itself with one no browser can send.
    const fromApp = { Origin: NATIVE_APP_WEBSOCKET_ORIGIN };
    expect(await upgradeStatus({ ...as(teammate), ...fromApp })).toBe(403);
    expect(await upgradeStatus({ ...as(owner), Origin: 'https://attacker.example' })).toBe(403);
    // Past the workspace and identity checks, the host reports the missing key rather than dropping the socket.
    expect(await upgradeStatus({ ...as(owner), ...fromApp })).toBe(503);
    vi.unstubAllEnvs();
  });

  it('refuses everyone while the owner is unknown', async () => {
    const server = await startOwnerServer(null);
    const response = await requestJson(server, 'POST', invokePath, invoke, undefined, {
      'Tailscale-User-Login': 'owner@example.com',
    });
    expect(response.statusCode).toBe(403);
  });

  it('answers only requests that came through Tailscale Serve with the per-launch path', async () => {
    const server = await startOwnerServer('owner@example.com');
    const direct = await requestJson(server, 'POST', '/invoke', invoke, undefined, {
      'Tailscale-User-Login': 'owner@example.com',
    });
    expect(direct.statusCode).toBe(404);
  });

  it('refuses browsers, so a web page cannot drive the owner\'s machines', async () => {
    const server = await startOwnerServer('owner@example.com');
    const fromPage = await requestJson(server, 'POST', invokePath, invoke, undefined, {
      'Tailscale-User-Login': 'owner@example.com',
      Origin: 'https://attacker.example',
    });
    expect(fromPage.statusCode).toBe(403);
    expect(JSON.stringify(fromPage.body)).toContain('ERR_WORKSPACE_BROWSER_REFUSED');
  });

  it('keeps machine commands off the pairing-token transport', async () => {
    const registry = new PaneCommandRegistry();
    registry.register('runpane:machine:info', () => ({ hostname: 'devbox' }));
    registry.register('runpane:workspaces:machines', () => ({ machines: ['private-laptop'] }));
    const server = new PaneRemoteHttpApiServer(registry, createConfigManagerStub(createEnabledRemoteConfig()));
    activeServers.push(server);
    await server.start();
    const response = await requestJson(server, 'POST', '/invoke', invoke, 'secret-token');
    expect(response.statusCode).toBe(403);
    const discovery = await requestJson(server, 'POST', '/invoke', { channel: 'runpane:workspaces:machines', args: [] }, 'secret-token', as(owner));
    expect(discovery.statusCode).toBe(403);
    expect(discovery.body).toMatchObject({ error: { code: 'ERR_WORKSPACE_DISCOVERY_OWNER_REQUIRED' } });
  });
});
