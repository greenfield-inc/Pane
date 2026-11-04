import { spawn } from 'child_process';
import fs from 'fs';
import net from 'net';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { readHerdr } from './herdr';
import type { ReaderContext } from './types';

const NOW = Date.parse('2026-10-26T12:00:00Z');
const DAY = 24 * 60 * 60 * 1000;

const roots: string[] = [];
const servers: net.Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise(resolve => server.close(resolve))));
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function tempRoot(): string {
  // Short prefix: unix socket paths are limited to about 104 bytes on macOS.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'h-'));
  roots.push(root);
  return root;
}

function context(overrides: Partial<ReaderContext>): ReaderContext {
  return {
    env: {},
    home: '/nonexistent-home',
    platform: 'darwin',
    now: NOW,
    sinceMs: NOW - 30 * DAY,
    tempDir: os.tmpdir(),
    isPidAlive: () => false,
    processCommands: async () => [],
    ...overrides,
  };
}

/** A session.json shaped like Herdr's SessionSnapshot v3 (src/persist/snapshot.rs). */
function snapshot(version = 3) {
  return {
    version,
    workspaces: [
      {
        id: 'w1',
        custom_name: 'billing',
        identity_cwd: '/repos/app',
        worktree_space: {
          key: 'k',
          label: 'app',
          repo_root: '/repos/app',
          checkout_path: '/worktrees/app/fix-invoices',
          is_linked_worktree: true,
        },
        tabs: [
          {
            custom_name: 'agents',
            layout: { Pane: 0 },
            zoomed: false,
            panes: {
              '0': {
                cwd: '/worktrees/app/fix-invoices',
                label: 'invoice fix',
                agent_name: 'claude',
                agent_session: { source: 'herdr:claude', agent: 'claude', kind: 'id', value: '7c9e6679-7425-40de-944b-e07fc1f90ae7' },
              },
              '1': {
                cwd: '/worktrees/app/fix-invoices',
                agent_name: 'codex',
                agent_session: { source: 'herdr:codex', agent: 'codex', kind: 'id', value: '019a1b2c-3d4e-7f60-8a9b-0c1d2e3f4a5b' },
              },
              '2': { cwd: '/repos/app', agent_name: 'claude' },
              '3': { cwd: '/repos/app' },
            },
          },
        ],
      },
    ],
    active: 0,
    selected: 0,
  };
}

function writeSession(dir: string, body: ReturnType<typeof snapshot>, mtimeMs = NOW - DAY): string {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'session.json');
  fs.writeFileSync(file, JSON.stringify(body));
  fs.utimesSync(file, mtimeMs / 1000, mtimeMs / 1000);
  return file;
}

function listen(socketPath: string): Promise<void> {
  const server = net.createServer(socket => socket.end());
  servers.push(server);
  return new Promise(resolve => server.listen(socketPath, resolve));
}

describe('readHerdr', () => {
  it('reads panes that carry an agent session id, with file mtime as last activity', async () => {
    const xdg = tempRoot();
    writeSession(path.join(xdg, 'herdr'), snapshot());

    const result = await readHerdr(context({ env: { XDG_CONFIG_HOME: xdg } }));

    expect(result.status).toBe('ok');
    expect(result.sessions).toEqual([
      {
        source: 'herdr',
        agent: 'claude',
        sessionId: '7c9e6679-7425-40de-944b-e07fc1f90ae7',
        folder: '/worktrees/app/fix-invoices',
        title: 'invoice fix',
        lastActiveMs: NOW - DAY,
        running: 'no',
      },
      {
        source: 'herdr',
        agent: 'codex',
        sessionId: '019a1b2c-3d4e-7f60-8a9b-0c1d2e3f4a5b',
        folder: '/worktrees/app/fix-invoices',
        title: 'agents',
        lastActiveMs: NOW - DAY,
        running: 'no',
      },
    ]);
  });

  it('reads named sessions too', async () => {
    const xdg = tempRoot();
    writeSession(path.join(xdg, 'herdr', 'sessions', 'work'), snapshot());

    const result = await readHerdr(context({ env: { XDG_CONFIG_HOME: xdg } }));

    expect(result.sessions.map(session => session.sessionId)).toEqual([
      '7c9e6679-7425-40de-944b-e07fc1f90ae7',
      '019a1b2c-3d4e-7f60-8a9b-0c1d2e3f4a5b',
    ]);
    expect(result.storePaths).toContain(path.join(xdg, 'herdr', 'sessions', 'work', 'session.json'));
  });

  it.skipIf(process.platform === 'win32')('marks panes running when the Herdr server answers on herdr.sock', async () => {
    const xdg = tempRoot();
    const dir = path.join(xdg, 'herdr');
    writeSession(dir, snapshot());
    await listen(path.join(dir, 'herdr.sock'));

    const result = await readHerdr(context({ env: { XDG_CONFIG_HOME: xdg } }));

    expect(result.sessions.map(session => session.running)).toEqual(['yes', 'yes']);
  });

  it.skipIf(process.platform === 'win32')('treats a socket file left by a crashed server as not running', async () => {
    const xdg = tempRoot();
    const dir = path.join(xdg, 'herdr');
    writeSession(dir, snapshot());
    const socketPath = path.join(dir, 'herdr.sock');
    // A server killed with SIGKILL never unlinks its socket.
    const child = spawn(process.execPath, ['-e', `require('net').createServer().listen(${JSON.stringify(socketPath)})`]);
    while (!fs.existsSync(socketPath)) await new Promise(resolve => setTimeout(resolve, 10));
    child.kill('SIGKILL');
    await new Promise(resolve => child.once('exit', resolve));
    expect(fs.statSync(socketPath).isSocket()).toBe(true);

    const result = await readHerdr(context({ env: { XDG_CONFIG_HOME: xdg } }));

    expect(result.sessions.map(session => session.running)).toEqual(['no', 'no']);
  });

  it.each([
    ['darwin', {}, ['.config', 'herdr']],
    ['linux', {}, ['.config', 'herdr']],
    ['win32', {}, ['AppData', 'Roaming', 'herdr']],
  ] as const)('finds the store on %s', async (platform, env, relative) => {
    const home = tempRoot();
    writeSession(path.join(home, ...relative), snapshot());

    const result = await readHerdr(context({ home, platform, env }));

    expect(result.status).toBe('ok');
    expect(result.storePaths).toEqual([path.join(home, ...relative, 'session.json')]);
    expect(result.sessions).toHaveLength(2);
  });

  it('uses %APPDATA% on Windows', async () => {
    const appData = tempRoot();
    writeSession(path.join(appData, 'herdr'), snapshot());

    const result = await readHerdr(context({ platform: 'win32', env: { APPDATA: appData } }));

    expect(result.storePaths).toEqual([path.join(appData, 'herdr', 'session.json')]);
    expect(result.sessions).toHaveLength(2);
  });

  it('honours XDG_CONFIG_HOME on Windows', async () => {
    const xdg = tempRoot();
    writeSession(path.join(xdg, 'herdr'), snapshot());

    const result = await readHerdr(context({ platform: 'win32', env: { XDG_CONFIG_HOME: xdg, APPDATA: '/elsewhere' } }));

    expect(result.storePaths).toEqual([path.join(xdg, 'herdr', 'session.json')]);
  });

  it('reports absent when Herdr has no config folder', async () => {
    const xdg = tempRoot();

    const result = await readHerdr(context({ env: { XDG_CONFIG_HOME: xdg } }));

    expect(result.status).toBe('absent');
    expect(result.sessions).toEqual([]);
  });

  it('fails closed on a snapshot version it does not know', async () => {
    const xdg = tempRoot();
    writeSession(path.join(xdg, 'herdr'), snapshot(4));

    const result = await readHerdr(context({ env: { XDG_CONFIG_HOME: xdg } }));

    expect(result.status).toBe('unreadable');
    expect(result.version).toBe('4');
    expect(result.sessions).toEqual([]);
  });

  it('leaves out a session file last written before sinceMs', async () => {
    const xdg = tempRoot();
    writeSession(path.join(xdg, 'herdr'), snapshot(), NOW - 40 * DAY);

    const result = await readHerdr(context({ env: { XDG_CONFIG_HOME: xdg } }));

    expect(result.status).toBe('ok');
    expect(result.sessions).toEqual([]);
  });

  it('leaves the live session.json untouched', async () => {
    const xdg = tempRoot();
    const file = writeSession(path.join(xdg, 'herdr'), snapshot());
    const before = { bytes: fs.readFileSync(file), mtimeMs: fs.statSync(file).mtimeMs, entries: fs.readdirSync(path.dirname(file)) };

    await readHerdr(context({ env: { XDG_CONFIG_HOME: xdg } }));

    expect(fs.readFileSync(file).equals(before.bytes)).toBe(true);
    expect(fs.statSync(file).mtimeMs).toBe(before.mtimeMs);
    expect(fs.readdirSync(path.dirname(file))).toEqual(before.entries);
  });
});
