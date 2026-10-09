import fs from 'fs';
import net from 'net';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import type { PaneDaemonFrame } from '../../../shared/types/daemon';
import { PaneCommandRegistry } from './commandRegistry';
import { encodePaneDaemonFrame, PaneDaemonFrameDecoder } from './socketFraming';
import { PaneDaemonServer } from './server';
import { PaneError } from '../../../shared/paneError';

interface TestClient {
  socket: net.Socket;
  nextFrame(timeoutMs?: number): Promise<PaneDaemonFrame>;
}

const activeServers: PaneDaemonServer[] = [];
const activeSockets: net.Socket[] = [];
const activeTempDirs: string[] = [];

afterEach(async () => {
  for (const socket of activeSockets.splice(0)) {
    if (!socket.destroyed) {
      socket.destroy();
    }
  }

  for (const server of activeServers.splice(0)) {
    await server.stop();
  }

  for (const tempDir of activeTempDirs.splice(0)) {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

function createTempAppDirectory(): string {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pane-daemon-server-'));
  activeTempDirs.push(tempDir);
  return tempDir;
}

async function connectClient(server: PaneDaemonServer): Promise<TestClient> {
  const endpoint = server.getEndpoint();
  const expectedSubscriberCount = getSubscriberCount(server) + 1;
  const socket = await new Promise<net.Socket>((resolve, reject) => {
    const client = net.createConnection(endpoint.path, () => resolve(client));
    client.once('error', reject);
  });

  activeSockets.push(socket);
  await waitForSubscriberCount(server, expectedSubscriberCount);

  const decoder = new PaneDaemonFrameDecoder();
  const queuedFrames: PaneDaemonFrame[] = [];
  const waiters: Array<(frame: PaneDaemonFrame) => void> = [];

  socket.on('data', (chunk) => {
    const frames = decoder.push(chunk);
    for (const frame of frames) {
      const waiter = waiters.shift();
      if (waiter) {
        waiter(frame);
      } else {
        queuedFrames.push(frame);
      }
    }
  });

  return {
    socket,
    nextFrame(timeoutMs = 5000) {
      if (queuedFrames.length > 0) {
        const queuedFrame = queuedFrames.shift();
        if (queuedFrame) {
          return Promise.resolve(queuedFrame);
        }
      }

      return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(new Error('Timed out waiting for Pane daemon frame'));
        }, timeoutMs);

        waiters.push((frame) => {
          clearTimeout(timeout);
          resolve(frame);
        });
      });
    },
  };
}

function getSubscriberCount(server: PaneDaemonServer): number {
  return server.getSubscriberCount();
}

async function waitForSubscriberCount(server: PaneDaemonServer, expectedCount: number): Promise<void> {
  const deadline = Date.now() + 1000;
  while (getSubscriberCount(server) < expectedCount) {
    if (Date.now() > deadline) {
      throw new Error(`Timed out waiting for ${expectedCount} Pane daemon subscriber(s)`);
    }
    await new Promise((resolve) => setImmediate(resolve));
  }
}

describe('PaneDaemonServer', () => {
  it('serves registered daemon commands over the local endpoint', async () => {
    const registry = new PaneCommandRegistry();
    registry.register('sessions:get-all', async () => [{
      id: 'session-1',
      omitted: undefined,
      timestamp: new Date('2026-08-17T00:00:00.000Z'),
    }]);

    const server = new PaneDaemonServer(registry, createTempAppDirectory());
    activeServers.push(server);
    await server.start();

    const client = await connectClient(server);
    client.socket.write(encodePaneDaemonFrame({
      type: 'request',
      id: 1,
      channel: 'sessions:get-all',
      args: [],
    }));

    await expect(client.nextFrame()).resolves.toEqual({
      type: 'response',
      id: 1,
      ok: true,
      result: [{
        id: 'session-1',
        timestamp: '2026-08-17T00:00:00.000Z',
      }],
    });
  });

  it('returns structured errors for unknown daemon channels', async () => {
    const registry = new PaneCommandRegistry();
    const server = new PaneDaemonServer(registry, createTempAppDirectory());
    activeServers.push(server);
    await server.start();

    const client = await connectClient(server);
    client.socket.write(encodePaneDaemonFrame({
      type: 'request',
      id: 2,
      channel: 'sessions:missing',
      args: [],
    }));

    await expect(client.nextFrame()).resolves.toEqual({
      type: 'response',
      id: 2,
      ok: false,
      error: {
        message: 'No Pane daemon command registered for channel "sessions:missing". This Pane does not have that command, usually because it is older than the runpane CLI or app that asked. Nothing was changed.',
        code: 'ERR_UNKNOWN_CHANNEL',
        next: 'Update Pane with `runpane update`, then restart it.',
      },
    });
  });

  it('keeps the code and next step a handler reports', async () => {
    const registry = new PaneCommandRegistry();
    registry.register('sessions:get-all', () => {
      throw new PaneError('ERR_PANE_NOT_FOUND', 'Pane abc is not on this machine. Nothing was changed.', 'List Panes with `runpane panes list`.');
    });
    const server = new PaneDaemonServer(registry, createTempAppDirectory());
    activeServers.push(server);
    await server.start();

    const client = await connectClient(server);
    client.socket.write(encodePaneDaemonFrame({ type: 'request', id: 3, channel: 'sessions:get-all', args: [] }));

    await expect(client.nextFrame()).resolves.toEqual({
      type: 'response',
      id: 3,
      ok: false,
      error: {
        code: 'ERR_PANE_NOT_FOUND',
        message: 'Pane abc is not on this machine. Nothing was changed.',
        next: 'List Panes with `runpane panes list`.',
      },
    });
  });

  it('broadcasts daemon-owned events and filters Electron-only events', async () => {
    const registry = new PaneCommandRegistry();
    const server = new PaneDaemonServer(registry, createTempAppDirectory());
    activeServers.push(server);
    await server.start();

    const client = await connectClient(server);
    server.getEventSink().send('session:created', { id: 'session-1' });

    await expect(client.nextFrame()).resolves.toEqual({
      type: 'event',
      channel: 'session:created',
      args: [{ id: 'session-1' }],
    });

    server.getEventSink().send('version:update-available', { version: '1.2.3' });
    await expect(client.nextFrame(100)).rejects.toThrow('Timed out waiting for Pane daemon frame');
  });

  it('mutes event frames per client without affecting other clients', async () => {
    const registry = new PaneCommandRegistry();
    const server = new PaneDaemonServer(registry, createTempAppDirectory());
    activeServers.push(server);
    await server.start();
    const muted = await connectClient(server);
    const live = await connectClient(server);

    muted.socket.write(encodePaneDaemonFrame({
      type: 'request', id: 10, channel: 'daemon:events', args: [{ include: [] }],
    }));
    await expect(muted.nextFrame()).resolves.toMatchObject({
      type: 'response', id: 10, ok: true, result: { muted: true, include: [] },
    });

    server.getEventSink().send('terminal:output', { data: 'noise' });
    await expect(live.nextFrame()).resolves.toMatchObject({ type: 'event', channel: 'terminal:output' });
    await expect(muted.nextFrame(100)).rejects.toThrow('Timed out waiting for Pane daemon frame');
  });

  it('filters event frames by channel prefix', async () => {
    const registry = new PaneCommandRegistry();
    const server = new PaneDaemonServer(registry, createTempAppDirectory());
    activeServers.push(server);
    await server.start();
    const client = await connectClient(server);
    client.socket.write(encodePaneDaemonFrame({
      type: 'request', id: 11, channel: 'daemon:events', args: [{ include: ['panel:'] }],
    }));
    await client.nextFrame();

    server.getEventSink().send('terminal:output', { data: 'ignored' });
    server.getEventSink().send('panel:agentStatus', { state: 'working' });
    await expect(client.nextFrame()).resolves.toMatchObject({ type: 'event', channel: 'panel:agentStatus' });
  });

  it('forwards logs panel runtime events to daemon clients', async () => {
    const registry = new PaneCommandRegistry();
    const server = new PaneDaemonServer(registry, createTempAppDirectory());
    activeServers.push(server);
    await server.start();

    const client = await connectClient(server);
    server.getEventSink().send('logs:output', {
      panelId: 'panel-1',
      content: 'ready\n',
      type: 'stdout',
    });

    await expect(client.nextFrame()).resolves.toEqual({
      type: 'event',
      channel: 'logs:output',
      args: [{
        panelId: 'panel-1',
        content: 'ready\n',
        type: 'stdout',
      }],
    });

    server.getEventSink().send('process:ended', {
      panelId: 'panel-1',
      exitCode: 0,
    });

    await expect(client.nextFrame()).resolves.toEqual({
      type: 'event',
      channel: 'process:ended',
      args: [{
        panelId: 'panel-1',
        exitCode: 0,
      }],
    });
  });

  it('forwards permission lifecycle events to daemon clients', async () => {
    const registry = new PaneCommandRegistry();
    const server = new PaneDaemonServer(registry, createTempAppDirectory());
    activeServers.push(server);
    await server.start();

    const client = await connectClient(server);
    server.getEventSink().send('permission:request', {
      id: 'permission-1',
      sessionId: 'session-1',
      toolName: 'Bash',
      input: { command: 'pwd' },
      timestamp: 1,
    });

    await expect(client.nextFrame()).resolves.toEqual({
      type: 'event',
      channel: 'permission:request',
      args: [{
        id: 'permission-1',
        sessionId: 'session-1',
        toolName: 'Bash',
        input: { command: 'pwd' },
        timestamp: 1,
      }],
    });

    server.getEventSink().send('permission:resolved', {
      request: {
        id: 'permission-1',
        sessionId: 'session-1',
        toolName: 'Bash',
        input: { command: 'pwd' },
        timestamp: 1,
      },
      response: {
        behavior: 'allow',
        message: 'approved',
      },
    });

    await expect(client.nextFrame()).resolves.toEqual({
      type: 'event',
      channel: 'permission:resolved',
      args: [{
        request: {
          id: 'permission-1',
          sessionId: 'session-1',
          toolName: 'Bash',
          input: { command: 'pwd' },
          timestamp: 1,
        },
        response: {
          behavior: 'allow',
          message: 'approved',
        },
      }],
    });
  });

  it('forwards script state events to daemon clients', async () => {
    const registry = new PaneCommandRegistry();
    const server = new PaneDaemonServer(registry, createTempAppDirectory());
    activeServers.push(server);
    await server.start();

    const client = await connectClient(server);
    server.getEventSink().send('script-closing', 'session-1');

    await expect(client.nextFrame()).resolves.toEqual({
      type: 'event',
      channel: 'script-closing',
      args: ['session-1'],
    });

    server.getEventSink().send('project-script-closing', { projectId: 12 });
    await expect(client.nextFrame()).resolves.toEqual({
      type: 'event',
      channel: 'project-script-closing',
      args: [{ projectId: 12 }],
    });

    server.getEventSink().send('script-session-changed', 'session-2');
    await expect(client.nextFrame()).resolves.toEqual({
      type: 'event',
      channel: 'script-session-changed',
      args: ['session-2'],
    });

    server.getEventSink().send('project-script-changed', { projectId: null });
    await expect(client.nextFrame()).resolves.toEqual({
      type: 'event',
      channel: 'project-script-changed',
      args: [{ projectId: null }],
    });
  });

  it('keeps backpressured daemon event subscribers connected until queued frames drain', async () => {
    if (process.platform === 'win32') {
      return;
    }

    const registry = new PaneCommandRegistry();
    let stalledServerSocket: net.Socket | undefined;
    let stalledWriteCount = 0;
    let shouldBackpressure = true;
    const server = new PaneDaemonServer(
      registry,
      createTempAppDirectory(),
      'linux',
      (clientId, socket, encodedFrame) => {
        const accepted = socket.write(encodedFrame);
        if (clientId !== '1') {
          return accepted;
        }
        stalledServerSocket = socket;
        stalledWriteCount += 1;
        if (shouldBackpressure) {
          shouldBackpressure = false;
          return false;
        }
        return accepted;
      },
    );
    activeServers.push(server);
    await server.start();

    const stalledClient = await connectClient(server);
    const healthyClient = await connectClient(server);
    server.getEventSink().send('terminal:output', {
      panelId: 'panel-1',
      data: 'hello\n',
    });

    await expect(stalledClient.nextFrame()).resolves.toEqual({
      type: 'event',
      channel: 'terminal:output',
      args: [{
        panelId: 'panel-1',
        data: 'hello\n',
      }],
    });
    await expect(healthyClient.nextFrame()).resolves.toEqual({
      type: 'event',
      channel: 'terminal:output',
      args: [{
        panelId: 'panel-1',
        data: 'hello\n',
      }],
    });

    server.getEventSink().send('terminal:output', {
      panelId: 'panel-1',
      data: 'world\n',
    });

    await expect(healthyClient.nextFrame()).resolves.toEqual({
      type: 'event',
      channel: 'terminal:output',
      args: [{
        panelId: 'panel-1',
        data: 'world\n',
      }],
    });

    expect(stalledWriteCount).toBe(1);
    if (!stalledServerSocket) {
      throw new Error('Expected the stalled daemon client socket to be captured');
    }
    stalledServerSocket.emit('drain');
    await expect(stalledClient.nextFrame()).resolves.toEqual({
      type: 'event',
      channel: 'terminal:output',
      args: [{
        panelId: 'panel-1',
        data: 'world\n',
      }],
    });

    expect(stalledWriteCount).toBe(2);
    expect(server.hasSubscribers()).toBe(true);
  });

  it('creates the Unix socket directory and socket file with user-only permissions', async () => {
    if (process.platform === 'win32') {
      return;
    }

    const registry = new PaneCommandRegistry();
    const server = new PaneDaemonServer(registry, createTempAppDirectory(), 'linux');
    activeServers.push(server);
    await server.start();

    const socketPath = server.getEndpoint().path;
    const socketDirectory = path.dirname(socketPath);
    expect(fs.statSync(socketDirectory).mode & 0o777).toBe(0o700);
    expect(fs.statSync(socketPath).mode & 0o777).toBe(0o600);
  });

  it('cleans up the Unix socket file when stopped', async () => {
    if (process.platform === 'win32') {
      return;
    }

    const registry = new PaneCommandRegistry();
    const server = new PaneDaemonServer(registry, createTempAppDirectory(), 'linux');
    await server.start();

    const socketPath = server.getEndpoint().path;
    expect(fs.existsSync(socketPath)).toBe(true);

    await server.stop();

    expect(fs.existsSync(socketPath)).toBe(false);
  });

  it('rejects replacing an active Unix socket listener at the same path', async () => {
    if (process.platform === 'win32') {
      return;
    }

    const appDirectory = createTempAppDirectory();
    const firstServer = new PaneDaemonServer(new PaneCommandRegistry(), appDirectory, 'linux');
    activeServers.push(firstServer);
    await firstServer.start();

    const secondServer = new PaneDaemonServer(new PaneCommandRegistry(), appDirectory, 'linux');
    await expect(secondServer.start()).rejects.toThrow(
      `Pane daemon server is already listening on ${firstServer.getEndpoint().path}`,
    );

    const client = await connectClient(firstServer);
    client.socket.write(encodePaneDaemonFrame({
      type: 'request',
      id: 9,
      channel: 'sessions:get-all',
      args: [],
    }));

    await expect(client.nextFrame()).resolves.toMatchObject({
      type: 'response',
      id: 9,
      ok: false,
      error: { code: 'ERR_UNKNOWN_CHANNEL' },
    });
  });

  it('replaces stale non-socket files at the Unix socket path', async () => {
    if (process.platform === 'win32') {
      return;
    }

    const appDirectory = createTempAppDirectory();
    const probeServer = new PaneDaemonServer(new PaneCommandRegistry(), appDirectory, 'linux');
    const socketPath = probeServer.getEndpoint().path;
    fs.mkdirSync(path.dirname(socketPath), { recursive: true });
    fs.writeFileSync(socketPath, 'stale');

    const server = new PaneDaemonServer(new PaneCommandRegistry(), appDirectory, 'linux');
    activeServers.push(server);
    await expect(server.start()).resolves.toBeUndefined();
    expect(fs.existsSync(socketPath)).toBe(true);
  });

  it('starts successfully for deeply nested app directories on Unix', async () => {
    if (process.platform === 'win32') {
      return;
    }

    const appDirectory = path.posix.join('/tmp', 'pane-root', 'nested'.repeat(40), '.pane');
    const server = new PaneDaemonServer(new PaneCommandRegistry(), appDirectory, 'linux');
    activeServers.push(server);

    await expect(server.start()).resolves.toBeUndefined();
    expect(Buffer.byteLength(server.getEndpoint().path)).toBeLessThan(100);
    expect(fs.existsSync(server.getEndpoint().path)).toBe(true);
  });
});
