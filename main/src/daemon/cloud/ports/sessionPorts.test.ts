import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SESSION_PORTS_CHANGED_EVENT, type SessionPortsListResult } from '../../../../../shared/types/sessionPorts';
import { isPaneDaemonEventChannel } from '../../server';
import { PaneCommandError } from '../../../core/commandError';
import type { ManifestRead } from './manifest';
import { readPortsState } from './portsStore';
import { SessionPortsService, type PanelProcess, type ProbeResult, type SessionPortsDependencies } from './sessionPorts';
import { localTarget, type ServeBackend, type ServeListener } from './tailscaleServe';
import type { TcpListener } from './listeners';
import type { ProcessEntry } from '../processTree';

const HOST = 'rp-a1b2c3d4.tail-example.ts.net';

class FakeServe implements ServeBackend {
  entries = new Map<number, ServeListener>();
  running = true;
  cert = true;
  calls: string[] = [];
  /** Set to make `tailscale serve` fail to publish (applyWeb throws it). */
  applyError: Error | undefined;

  async self() {
    return { running: this.running, backendState: this.running ? 'Running' : 'Stopped', dnsName: this.running ? HOST : undefined };
  }
  async listeners() {
    return new Map(this.entries);
  }
  async applyWeb(scheme: 'https' | 'http', tailnetPort: number, localPort: number) {
    this.calls.push(`apply ${scheme} :${tailnetPort} -> ${localPort}`);
    if (this.applyError) throw this.applyError;
    this.entries.set(tailnetPort, { kind: 'web', scheme, proxy: localTarget(localPort) });
  }
  async remove(tailnetPort: number) {
    this.calls.push(`off :${tailnetPort}`);
    this.entries.delete(tailnetPort);
  }
  async certCached() {
    return this.cert;
  }
}

interface Harness {
  service: SessionPortsService;
  serve: FakeServe;
  statePath: string;
  events: SessionPortsListResult[];
  probes: string[];
  manifests: Map<string, ManifestRead>;
  projects: string[];
  panels: PanelProcess[];
  listeners: TcpListener[];
  processes: ProcessEntry[];
  owners: Map<number, number>;
  probeAnswer: (url: string) => ProbeResult;
}

let dir: string;

function makeHarness(): Harness {
  const serve = new FakeServe();
  const harness: Omit<Harness, 'service'> = {
    serve,
    statePath: path.join(dir, 'state', 'ports.json'),
    events: [],
    probes: [],
    manifests: new Map(),
    projects: [],
    panels: [],
    listeners: [],
    processes: [],
    owners: new Map(),
    probeAnswer: () => ({ ok: true, status: 200 }),
  };
  const deps: SessionPortsDependencies = {
    serve,
    statePath: harness.statePath,
    reservedPorts: () => [42137],
    projectPaths: () => harness.projects,
    readManifest: repo => harness.manifests.get(repo) ?? { kind: 'absent' },
    panelProcesses: () => harness.panels,
    readListeners: () => harness.listeners,
    readProcesses: () => harness.processes,
    mapSocketOwners: () => harness.owners,
    probe: async url => {
      harness.probes.push(url);
      return harness.probeAnswer(url);
    },
    emit: result => harness.events.push(result),
    now: () => Date.parse('2026-09-30T23:00:00Z'),
    log: () => undefined,
  };
  // The same object, so the dependencies above see later changes to it.
  return Object.assign(harness, { service: new SessionPortsService(deps) });
}

async function errorCode(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof PaneCommandError) return error.code;
    throw error;
  }
  return 'no error';
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-ports-'));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('SessionPortsService.open', () => {
  it('publishes a local port on the same tailnet port over HTTPS and records it 0600', async () => {
    const h = makeHarness();
    const result = await h.service.open({ port: 8787, name: 'taste' });
    expect(result.port).toMatchObject({ name: 'taste', port: 8787, httpsPort: 8787, scheme: 'https', status: 'serving', source: 'user' });
    expect(result.port.url).toBe(`https://${HOST}:8787/`);
    expect(h.serve.calls).toEqual(['apply https :8787 -> 8787']);
    expect(fs.statSync(h.statePath).mode & 0o777).toBe(0o600);
    expect(readPortsState(h.statePath).ports.map(port => port.name)).toEqual(['taste']);
    expect(h.events.at(-1)?.ports).toHaveLength(1);
  });

  it('serves two ports on one Session, each on its own tailnet port', async () => {
    const h = makeHarness();
    await h.service.open({ port: 8787 });
    await h.service.open({ port: 3000, httpsPort: 8788, path: '/app' });
    const list = await h.service.list();
    expect(list.ports.map(port => port.url)).toEqual([`https://${HOST}:8787/`, `https://${HOST}:8788/app`]);
    expect(await errorCode(h.service.open({ port: 4000, httpsPort: 8788 }))).toBe('ERR_PORTS_IN_USE');
  });

  it('keeps 443 and the daemon port for Pane', async () => {
    const h = makeHarness();
    expect(await errorCode(h.service.open({ port: 443 }))).toBe('ERR_PORTS_RESERVED');
    expect(await errorCode(h.service.open({ port: 3000, httpsPort: 42137 }))).toBe('ERR_PORTS_RESERVED');
    expect(await errorCode(h.service.open({ port: 42137, httpsPort: 9000 }))).toBe('ERR_PORTS_RESERVED');
    expect((await h.service.open({ port: 443, httpsPort: 8443 })).port.httpsPort).toBe(8443);
  });

  it('replaces a plain tcp Serve entry on the port only with yes', async () => {
    const h = makeHarness();
    h.serve.entries.set(8787, { kind: 'tcp', forward: '127.0.0.1:8787', terminateTls: false });
    expect(await errorCode(h.service.open({ port: 8787 }))).toBe('ERR_PORTS_CONFLICT');
    expect(h.serve.calls).toEqual([]);
    const result = await h.service.open({ port: 8787, yes: true });
    expect(result.replaced).toEqual({ httpsPort: 8787, was: 'plain tcp -> 127.0.0.1:8787' });
    expect(h.serve.calls).toEqual(['off :8787', 'apply https :8787 -> 8787']);
  });

  it('is idempotent for a port already open', async () => {
    const h = makeHarness();
    await h.service.open({ port: 5173 });
    const again = await h.service.open({ port: 5173 });
    expect(again.alreadyOpen).toBe(true);
    expect(h.serve.calls).toEqual(['apply https :5173 -> 5173']);
    expect(await errorCode(h.service.open({ port: 5173, httpsPort: 9443 }))).toBe('ERR_PORTS_IN_USE');
  });

  it('falls back to plain HTTP inside the tailnet when no certificate comes, and says so', async () => {
    const h = makeHarness();
    h.serve.cert = false;
    h.probeAnswer = () => ({ ok: false, error: 'ECONNRESET' });
    const result = await h.service.open({ port: 8787 });
    expect(result.port.scheme).toBe('http');
    expect(result.port.url).toBe(`http://${HOST}:8787/`);
    expect(result.port.detail).toMatch(/no TLS certificate/u);
    expect(h.serve.calls).toEqual(['apply https :8787 -> 8787', 'off :8787', 'apply http :8787 -> 8787']);
    expect((await h.service.list()).scheme).toBe('http');
    // The failure is remembered: the next port does not wait for another check.
    await h.service.open({ port: 3000 });
    expect(h.probes).toHaveLength(1);
    expect(h.serve.calls.at(-1)).toBe('apply http :3000 -> 3000');
  });

  it('moves fallback ports to https once a certificate is cached, and --scheme https retries at once', async () => {
    const h = makeHarness();
    h.serve.cert = false;
    h.probeAnswer = () => ({ ok: false, error: 'timed out after 45000 ms' });
    await h.service.open({ port: 8787 });
    await h.service.open({ port: 3000 });
    h.serve.cert = true;
    h.serve.calls = [];
    const again = await h.service.open({ port: 3000, scheme: 'https' });
    expect(again.port.scheme).toBe('https');
    expect(h.serve.calls).toEqual(['off :3000', 'apply https :3000 -> 3000']);
    await h.service.reconcile('periodic');
    const list = await h.service.list();
    expect(list.ports.map(port => [port.port, port.scheme, port.status, port.detail])).toEqual([
      [8787, 'https', 'serving', undefined],
      [3000, 'https', 'serving', undefined],
    ]);
  });

  it('uses HTTPS when the first TLS request gets a certificate', async () => {
    const h = makeHarness();
    h.serve.cert = false;
    h.probeAnswer = () => ({ ok: true, status: 502 });
    expect((await h.service.open({ port: 8787 })).port.scheme).toBe('https');
    expect(h.probes).toEqual([`https://${HOST}:8787/`]);
  });

  it('neither records nor announces a port Tailscale Serve failed to publish', async () => {
    const h = makeHarness();
    h.serve.applyError = new Error('tailscale serve exited with code 1');
    await expect(h.service.open({ port: 8787, name: 'taste' })).rejects.toThrow('tailscale serve exited with code 1');
    expect(h.serve.calls).toEqual(['apply https :8787 -> 8787']);
    expect(fs.existsSync(h.statePath)).toBe(false);
    expect(h.events).toEqual([]);
    expect((await h.service.list()).ports).toEqual([]);
  });

  it('refuses when Tailscale is not running', async () => {
    const h = makeHarness();
    h.serve.running = false;
    expect(await errorCode(h.service.open({ port: 8787 }))).toBe('ERR_PORTS_UNAVAILABLE');
    expect((await h.service.list()).available).toBe(false);
  });
});

describe('SessionPortsService.close and list', () => {
  it('closes by name or port and removes only its own Serve entry', async () => {
    const h = makeHarness();
    await h.service.open({ port: 8787, name: 'taste' });
    await h.service.open({ port: 3000 });
    expect((await h.service.close('taste')).closed?.name).toBe('taste');
    expect((await h.service.close(3000)).closed?.port).toBe(3000);
    expect((await h.service.close('nothing')).closed).toBeNull();
    expect(h.serve.entries.size).toBe(0);
  });

  it('verifies URLs on request: 502 means nothing listens locally', async () => {
    const h = makeHarness();
    await h.service.open({ port: 8787 });
    await h.service.open({ port: 3000 });
    h.probeAnswer = url => url.includes(':3000') ? { ok: true, status: 502 } : { ok: true, status: 200 };
    const list = await h.service.list({ verify: true });
    expect(list.ports.map(port => port.reachable)).toEqual([true, false]);
  });
});

describe('SessionPortsService.reconcile', () => {
  it('re-applies entries a wake lost', async () => {
    const h = makeHarness();
    await h.service.open({ port: 8787 });
    await h.service.open({ port: 3000, httpsPort: 8788 });
    h.serve.entries.clear();
    expect((await h.service.list()).ports.map(port => port.status)).toEqual(['missing', 'missing']);
    h.serve.calls = [];
    await h.service.reconcile('boot');
    expect(h.serve.calls).toEqual(['apply https :8787 -> 8787', 'apply https :8788 -> 3000']);
    expect((await h.service.list()).ports.map(port => port.status)).toEqual(['serving', 'serving']);
    expect(h.probes).toEqual([`https://${HOST}:8787/`, `https://${HOST}:8788/`]);
  });

  it('keeps a port it could not re-apply as missing, never serving', async () => {
    const h = makeHarness();
    await h.service.open({ port: 8787 });
    h.serve.entries.clear();
    h.events.length = 0;
    h.serve.applyError = new Error('tailscale serve exited with code 1');
    await h.service.reconcile('periodic');
    expect(h.events.flatMap(event => event.ports.map(port => port.status))).not.toContain('serving');
    expect((await h.service.list()).ports.map(port => port.status)).toEqual(['missing']);
    expect(readPortsState(h.statePath).ports.map(port => port.blockedBy)).toEqual([undefined]);
  });

  it('opens manifest ports, drops undeclared ones, and does not reopen a dismissed one', async () => {
    const h = makeHarness();
    h.projects = ['/home/user/app'];
    h.manifests.set('/home/user/app', { kind: 'ok', ports: [{ name: 'web', port: 5173, path: '/' }, { name: 'api', port: 3000, httpsPort: 8443, path: '/health' }] });
    await h.service.reconcile('boot');
    let list = await h.service.list();
    expect(list.ports.map(port => [port.name, port.source, port.repo, port.url])).toEqual([
      ['web', 'manifest', '/home/user/app', `https://${HOST}:5173/`],
      ['api', 'manifest', '/home/user/app', `https://${HOST}:8443/health`],
    ]);
    expect(list.manifests).toEqual([{ repo: '/home/user/app', ok: true, count: 2 }]);

    await h.service.close('web');
    await h.service.reconcile('periodic');
    expect((await h.service.list()).ports.map(port => port.name)).toEqual(['api']);

    h.manifests.set('/home/user/app', { kind: 'ok', ports: [] });
    await h.service.reconcile('periodic');
    list = await h.service.list();
    expect(list.ports).toEqual([]);
    expect(h.serve.entries.size).toBe(0);

    await h.service.open({ port: 5173, name: 'web' });
    expect(readPortsState(h.statePath).dismissed).toEqual(['/home/user/app#web']);
  });

  it('keeps what an invalid manifest had and reports the error', async () => {
    const h = makeHarness();
    h.projects = ['/r'];
    h.manifests.set('/r', { kind: 'ok', ports: [{ name: 'web', port: 5173, path: '/' }] });
    await h.service.reconcile('boot');
    h.manifests.set('/r', { kind: 'invalid', error: 'ports[0]: unknown key htps_port' });
    await h.service.reconcile('periodic');
    const list = await h.service.list();
    expect(list.ports.map(port => port.name)).toEqual(['web']);
    expect(list.manifests).toEqual([{ repo: '/r', ok: false, error: 'ports[0]: unknown key htps_port', count: 0 }]);
  });

  it('never replaces a foreign Serve entry for a manifest; it waits and opens once the port is free', async () => {
    const h = makeHarness();
    h.projects = ['/r'];
    h.manifests.set('/r', { kind: 'ok', ports: [{ name: 'taste', port: 8787, path: '/' }] });
    h.serve.entries.set(8787, { kind: 'tcp', forward: '127.0.0.1:8787', terminateTls: false });
    await h.service.reconcile('boot');
    let [port] = (await h.service.list()).ports;
    expect(port).toMatchObject({ name: 'taste', status: 'error' });
    expect(port?.detail).toMatch(/plain tcp -> 127\.0\.0\.1:8787/u);
    expect(h.serve.entries.get(8787)?.kind).toBe('tcp');

    h.serve.entries.delete(8787);
    await h.service.reconcile('periodic');
    [port] = (await h.service.list()).ports;
    expect(port).toMatchObject({ name: 'taste', status: 'serving', scheme: 'https' });
  });

  it('marks a user port another Serve entry took over, and frees it when that leaves', async () => {
    const h = makeHarness();
    await h.service.open({ port: 3000 });
    h.serve.entries.set(3000, { kind: 'tcp', forward: '127.0.0.1:9999', terminateTls: false });
    await h.service.reconcile('periodic');
    expect((await h.service.list()).ports[0]?.status).toBe('error');
    h.serve.entries.delete(3000);
    await h.service.reconcile('periodic');
    expect((await h.service.list()).ports[0]?.status).toBe('serving');
  });
});

function withPanelServer(h: Harness): void {
  h.panels = [{ pid: 100, panelId: 'panel-1', paneId: 'pane-1' }];
  h.processes = [
    { pid: 1, ppid: 0, name: 'systemd' },
    { pid: 100, ppid: 1, name: 'bash' },
    { pid: 101, ppid: 100, name: 'claude' },
    { pid: 102, ppid: 101, name: 'node' },
    { pid: 200, ppid: 1, name: 'postgres' },
  ];
  h.listeners = [
    { port: 5173, address: '127.0.0.1', inode: 11 },
    { port: 5173, address: '::1', inode: 12 },
    { port: 5432, address: '127.0.0.1', inode: 13 },
    { port: 42137, address: '127.0.0.1', inode: 14 },
  ];
  h.owners = new Map([[11, 102], [12, 102], [13, 200]]);
}

describe('SessionPortsService.detect', () => {
  it('suggests only listeners started under a Pane panel, without publishing them', async () => {
    const h = makeHarness();
    withPanelServer(h);
    await h.service.detect();
    const list = await h.service.list();
    expect(list.suggested).toEqual([{ port: 5173, address: '127.0.0.1', process: 'node', pid: 102, paneId: 'pane-1', panelId: 'panel-1', detectedAt: '2026-09-30T23:00:00.000Z' }]);
    expect(list.ports).toEqual([]);
    expect(h.serve.calls).toEqual([]);
    expect(h.events.at(-1)?.suggested).toHaveLength(1);
  });

  it('drops a suggestion as soon as it is opened, before the next detection round', async () => {
    const h = makeHarness();
    withPanelServer(h);
    await h.service.detect();
    await h.service.open({ port: 5173 });
    const list = await h.service.list();
    expect(list.ports.map(port => port.port)).toEqual([5173]);
    expect(list.suggested).toEqual([]);
    expect(h.events.at(-1)?.suggested).toEqual([]);
  });

  it('publishes suggestions with autoOpen', async () => {
    const h = makeHarness();
    withPanelServer(h);
    await h.service.configure({ autoOpen: true });
    await h.service.detect();
    expect((await h.service.list()).ports.map(port => [port.port, port.source])).toEqual([[5173, 'auto']]);
    await h.service.detect();
    expect((await h.service.list()).suggested).toEqual([]);
  });

  it('reconciles when a repository is added, even right after the boot reconcile', async () => {
    const h = makeHarness();
    await h.service.reconcile('boot');
    h.projects = ['/home/user/new-repo'];
    h.manifests.set('/home/user/new-repo', { kind: 'ok', ports: [{ name: 'docs', port: 4000, path: '/' }] });
    await h.service.detect();
    expect((await h.service.list()).ports.map(port => port.name)).toEqual(['docs']);
  });
});

describe('SessionPortsService with an unreadable state file', () => {
  const unreadable: Array<[string, string]> = [
    ['not JSON', '{"version": 1, "ports": ['],
    ['JSON with the wrong shape', JSON.stringify({ version: 1, ports: [{ name: 'taste', port: 'eight' }] })],
  ];

  for (const [label, content] of unreadable) {
    it(`refuses every change and keeps the file as is when it is ${label}`, async () => {
      const h = makeHarness();
      fs.mkdirSync(path.dirname(h.statePath), { recursive: true });
      fs.writeFileSync(h.statePath, content);
      h.projects = ['/home/user/app'];
      h.manifests.set('/home/user/app', { kind: 'ok', ports: [{ name: 'web', port: 3000, path: '/' }] });
      withPanelServer(h);

      expect(await errorCode(h.service.open({ port: 8787 }))).toBe('ERR_PORTS_STATE_INVALID');
      expect(await errorCode(h.service.close(8787))).toBe('ERR_PORTS_STATE_INVALID');
      expect(await errorCode(h.service.configure({ autoOpen: true }))).toBe('ERR_PORTS_STATE_INVALID');
      await expect(h.service.reconcile('boot')).rejects.toMatchObject({ code: 'ERR_PORTS_STATE_INVALID' });
      await h.service.detect();

      expect(fs.readFileSync(h.statePath, 'utf8')).toBe(content);
      expect(h.serve.calls).toEqual([]);
      const list = await h.service.list();
      expect(list.ports).toEqual([]);
      expect(list.stateError).toContain(h.statePath);
      expect(list.suggested.map(port => port.port)).toEqual([5173]);
      expect(h.events.at(-1)?.stateError).toContain(h.statePath);
    });
  }

  it('treats only a missing file as no ports', async () => {
    const h = makeHarness();
    fs.mkdirSync(h.statePath, { recursive: true });
    expect(() => readPortsState(path.join(dir, 'absent.json'))).not.toThrow();
    expect(readPortsState(path.join(dir, 'absent.json')).ports).toEqual([]);
    expect(await errorCode(h.service.open({ port: 8787 }))).toBe('ERR_PORTS_STATE_INVALID');
    expect((await h.service.list()).stateError).toContain(h.statePath);
    expect(fs.statSync(h.statePath).isDirectory()).toBe(true);
  });
});

describe('runpane:ports:changed delivery', () => {
  it('passes the daemon event filter, so desktop and web clients hear about changes at once', () => {
    expect(isPaneDaemonEventChannel(SESSION_PORTS_CHANGED_EVENT)).toBe(true);
  });
});
