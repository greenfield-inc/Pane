import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { boundary, decodeBoundary, type JsonValue } from '../boundaryDecoder';
import { invokeDaemon } from '../daemonClient';
import { resolveDaemonTarget, type DaemonTarget } from './hostDirectory';
import {
  nodeHttpTransport,
  RemoteConnectError,
  type RemoteHttpRequest,
  type RemoteHttpResponse,
} from './remoteDaemonClient';
import { configureDaemonTarget, invokeRemote, resetDaemonTarget } from './target';

const B_URL = 'https://rp-bbbbbbbb.tail.ts.net';
const COORD_URL = 'http://rp-coord.tail.ts.net:47300';

function pairingCode(label: string, baseUrl: string, token: string): string {
  const json = JSON.stringify({ v: 1, label, baseUrl, token, transport: 'http+sse' });
  return `pane-remote://${Buffer.from(json).toString('base64url')}`;
}

function cloudTarget(): DaemonTarget {
  return {
    host: {
      id: 'b', label: 'session-b', baseUrl: B_URL, token: 'peer-token',
      cloud: { provider: 'boat', sandboxId: 'bx_b', sessionId: 'bbbbbbbbbb', hostname: 'rp-bbbbbbbb' },
    },
    coordinator: { baseUrl: COORD_URL, token: 'rpc1.aaaa.mac' },
    source: 'test',
  };
}

interface FakeHost {
  transport: (request: RemoteHttpRequest) => Promise<RemoteHttpResponse>;
  calls: RemoteHttpRequest[];
  /** /invoke requests whose connection opened (the host saw them). */
  delivered: Array<{ channel: string; args: JsonValue[] }>;
}

/** A cloud host that is asleep until the coordinator wakes it. */
function sleepingCloudHost(options: { wakeStatus?: string; failConnectsAfterWake?: number } = {}): FakeHost {
  let awake = false;
  let connectFailuresLeft = options.failConnectsAfterWake ?? 0;
  const calls: RemoteHttpRequest[] = [];
  const delivered: FakeHost['delivered'] = [];
  const transport = async (request: RemoteHttpRequest): Promise<RemoteHttpResponse> => {
    calls.push(request);
    if (request.url.startsWith(COORD_URL)) {
      if (request.url.endsWith('/cloud/wake')) {
        const status = options.wakeStatus ?? 'awake';
        if (status === 'awake') awake = true;
        return { status: 200, body: JSON.stringify({ ok: true, host: 'bbbbbbbbbb', status, baseUrl: B_URL, version: '2.4.141' }) };
      }
      return { status: 200, body: JSON.stringify({ ok: true, host: 'bbbbbbbbbb', status: awake ? 'awake' : 'asleep', baseUrl: B_URL }) };
    }
    if (!awake || connectFailuresLeft > 0) {
      if (awake) connectFailuresLeft -= 1;
      throw new RemoteConnectError('connect ETIMEDOUT', 'ETIMEDOUT');
    }
    const body = decodeBoundary(JSON.parse(request.body ?? '{}'), invokeBodySchema);
    delivered.push(body);
    if (body.channel === 'runpane:panels:list') {
      return { status: 200, body: JSON.stringify({ ok: true, result: { ok: true, paneId: 'p', panels: [{ id: 'orch-1', title: 'Claude' }] } }) };
    }
    return { status: 200, body: JSON.stringify({ ok: true, result: { ok: true, echoed: body.args } }) };
  };
  return { transport, calls, delivered };
}

const invokeBodySchema = boundary.object({ channel: boundary.string, args: boundary.array(boundary.json) });
const submitBodySchema = boundary.object({ args: boundary.array(boundary.object({ idempotencyKey: boundary.string })) });

function listeningAddress(server: http.Server): AddressInfo {
  // SAFETY: every server here listens on 127.0.0.1:<port>, which reports an AddressInfo, never a pipe path.
  return server.address() as AddressInfo;
}

const fast = { timeoutMs: 5_000, wakeWaitMs: 5_000, resendIntervalMs: 1, retryDelayMs: 1 };

describe('invokeRemote wake policy', () => {
  it('wakes a sleeping cloud host for a submit and delivers exactly once with one idempotency key', async () => {
    const host = sleepingCloudHost({ failConnectsAfterWake: 2 });
    const result = await invokeRemote(cloudTarget(), 'runpane:panels:submit', [{ panelId: 'orch-1', input: 'hi' }], {
      ...fast, transport: host.transport,
    });

    const wakes = host.calls.filter((call) => call.url === `${COORD_URL}/cloud/wake`);
    assert.equal(wakes.length, 1);
    assert.deepEqual(JSON.parse(wakes[0]!.body ?? ''), { host: 'bbbbbbbbbb', wait: true, timeoutMs: 5_000 });
    assert.equal(wakes[0]!.headers.Authorization, 'Bearer rpc1.aaaa.mac');
    assert.equal(host.delivered.length, 1);
    const invokeKeys = host.calls
      .filter((call) => call.url === `${B_URL}/invoke`)
      .map((call) => decodeBoundary(JSON.parse(call.body ?? '{}'), submitBodySchema).args[0]!.idempotencyKey);
    // First attempt + 2 failed resends + the delivered one, all the same key.
    assert.equal(invokeKeys.length, 4);
    assert.equal(new Set(invokeKeys).size, 1);
    assert.match(invokeKeys[0]!, /^runpane-cli:[0-9a-f-]{36}$/);
    assert.deepEqual(result, { ok: true, echoed: [{ panelId: 'orch-1', input: 'hi', idempotencyKey: invokeKeys[0] }] });
  });

  it('keeps a caller-supplied idempotency key', async () => {
    const host = sleepingCloudHost();
    await invokeRemote(cloudTarget(), 'runpane:panels:submit', [{ panelId: 'x', input: 'hi', idempotencyKey: 'mine-1' }], {
      ...fast, transport: host.transport,
    });
    assert.deepEqual(host.delivered[0]!.args, [{ panelId: 'x', input: 'hi', idempotencyKey: 'mine-1' }]);
  });

  it('never wakes for panels list or workspace wait: it asks for status and reports asleep', async () => {
    for (const channel of ['runpane:panels:list', 'runpane:workspace:wait']) {
      const host = sleepingCloudHost();
      await assert.rejects(
        invokeRemote(cloudTarget(), channel, [{}], { ...fast, transport: host.transport }),
        { name: 'RemoteTargetError', code: 'ERR_RUNPANE_HOST_ASLEEP', message: /runpane cloud wake/ },
      );
      assert.equal(host.calls.some((call) => call.url.endsWith('/cloud/wake')), false, channel);
      assert.equal(host.calls.filter((call) => call.url === `${COORD_URL}/cloud/status?host=bbbbbbbbbb`).length, 1, channel);
      assert.equal(host.delivered.length, 0);
    }
  });

  it('reports lost and daemon-down from the wake without delivering', async () => {
    for (const status of ['lost', 'daemon-down', 'asleep']) {
      const host = sleepingCloudHost({ wakeStatus: status });
      await assert.rejects(
        invokeRemote(cloudTarget(), 'runpane:panels:submit', [{ panelId: 'x', input: 'hi' }], { ...fast, transport: host.transport }),
        { name: 'RemoteTargetError', code: `ERR_RUNPANE_HOST_${status.toUpperCase().replace('-', '_')}` },
      );
      assert.equal(host.delivered.length, 0);
    }
  });

  it('does not resend a submit whose connection opened', async () => {
    let invokes = 0;
    const transport = async (request: RemoteHttpRequest): Promise<RemoteHttpResponse> => {
      if (request.url.startsWith(COORD_URL)) throw new Error('coordinator must not be called');
      invokes += 1;
      throw new Error('socket hang up');
    };
    await assert.rejects(
      invokeRemote(cloudTarget(), 'runpane:panels:submit', [{ panelId: 'x', input: 'hi' }], { ...fast, transport }),
      { name: 'RemoteTargetError', code: 'ERR_RUNPANE_REMOTE_UNCONFIRMED' },
    );
    assert.equal(invokes, 1);
  });

  it('retries a reviewed read after a failure in transit', async () => {
    let invokes = 0;
    const transport = async (): Promise<RemoteHttpResponse> => {
      invokes += 1;
      if (invokes < 3) return { status: 502, body: 'bad gateway' };
      return { status: 200, body: JSON.stringify({ ok: true, result: { ok: true, paneId: 'p', panels: [] } }) };
    };
    const result = await invokeRemote(cloudTarget(), 'runpane:panels:list', [{ paneId: 'p' }], { ...fast, transport });
    assert.deepEqual(result, { ok: true, paneId: 'p', panels: [] });
    assert.equal(invokes, 3);
  });

  it('retries the Session ports list after a failure in transit, but never a ports change', async () => {
    const flaky = () => {
      const seen: string[] = [];
      const transport = async (request: RemoteHttpRequest): Promise<RemoteHttpResponse> => {
        seen.push(decodeBoundary(JSON.parse(request.body ?? '{}'), invokeBodySchema).channel);
        if (seen.length < 3) return { status: 502, body: 'bad gateway' };
        return { status: 200, body: JSON.stringify({ ok: true, result: { ok: true, available: true, ports: [] } }) };
      };
      return { seen, transport };
    };
    const list = flaky();
    const result = await invokeRemote(cloudTarget(), 'runpane:ports:list', [{ verify: false }], { ...fast, transport: list.transport });
    assert.deepEqual(result, { ok: true, available: true, ports: [] });
    assert.deepEqual(list.seen, ['runpane:ports:list', 'runpane:ports:list', 'runpane:ports:list']);

    for (const channel of ['runpane:ports:open', 'runpane:ports:close', 'runpane:ports:configure']) {
      const change = flaky();
      await assert.rejects(
        invokeRemote(cloudTarget(), channel, [{}], { ...fast, transport: change.transport }),
        { name: 'RemoteTargetError', code: 'ERR_RUNPANE_REMOTE_UNCONFIRMED' },
      );
      assert.deepEqual(change.seen, [channel]);
    }
  });

  it('reports a command error the daemon answered as that error, not as unconfirmed', async () => {
    const answered = (status: number, message: string, code: string) => async (): Promise<RemoteHttpResponse> => ({
      status,
      body: JSON.stringify({ ok: false, error: { message, code } }),
    });
    await assert.rejects(
      invokeRemote(cloudTarget(), 'runpane:panes:create', [{ repo: 'nope' }], {
        ...fast, transport: answered(500, 'No Pane repo found for "nope"', 'ERR_REMOTE_DAEMON_REQUEST_FAILED'),
      }),
      { name: 'RemoteTargetError', code: 'ERR_REMOTE_DAEMON_REQUEST_FAILED', message: 'No Pane repo found for "nope"' },
    );
    // A rate-limited peer submit was refused before delivery: the caller may resend later.
    await assert.rejects(
      invokeRemote(cloudTarget(), 'runpane:panels:submit', [{ panelId: 'x', input: 'hi' }], {
        ...fast, transport: answered(429, 'This peer is sending too many messages', 'ERR_PEER_RATE_LIMITED'),
      }),
      { name: 'RemoteTargetError', code: 'ERR_PEER_RATE_LIMITED' },
    );
    // Without the daemon's envelope (a proxy error page) nobody knows whether it ran.
    await assert.rejects(
      invokeRemote(cloudTarget(), 'runpane:panes:create', [{ repo: 'r' }], {
        ...fast, transport: async () => ({ status: 502, body: 'bad gateway' }),
      }),
      { name: 'RemoteTargetError', code: 'ERR_RUNPANE_REMOTE_UNCONFIRMED' },
    );
  });

  it('passes a peer policy refusal through with its code', async () => {
    const transport = async (): Promise<RemoteHttpResponse> => ({
      status: 403,
      body: JSON.stringify({ ok: false, error: { message: 'Peers may only submit to the orchestrator panel', code: 'ERR_PEER_PANEL_FORBIDDEN' } }),
    });
    await assert.rejects(
      invokeRemote(cloudTarget(), 'runpane:panels:submit', [{ panelId: 'shell', input: 'ls' }], { ...fast, transport }),
      { name: 'RemoteTargetError', code: 'ERR_PEER_PANEL_FORBIDDEN' },
    );
  });

  it('reports a bad token as an auth failure', async () => {
    const transport = async (): Promise<RemoteHttpResponse> => ({ status: 401, body: JSON.stringify({ ok: false, error: { message: 'Unauthorized' } }) });
    await assert.rejects(
      invokeRemote(cloudTarget(), 'runpane:panels:list', [{}], { ...fast, transport }),
      { name: 'RemoteTargetError', code: 'ERR_RUNPANE_REMOTE_AUTH' },
    );
  });

  it('resolves --panel orchestrator through panels list, also after a wake', async () => {
    const host = sleepingCloudHost();
    // The CLI's request carries undefined optionals, as buildPanelInputRequest does.
    await invokeRemote(cloudTarget(), 'runpane:panels:submit', [{ panelId: 'orchestrator', input: 'hi', asFilePointer: undefined }], { ...fast, transport: host.transport });
    assert.deepEqual(host.delivered.map((call) => call.channel), ['runpane:panels:list', 'runpane:panels:submit']);
    const submitted = decodeBoundary(host.delivered[1]!.args[0], boundary.object({ panelId: boundary.string, idempotencyKey: boundary.string }));
    assert.equal(submitted.panelId, 'orch-1');
    assert.match(submitted.idempotencyKey, /^runpane-cli:/);
  });

  it('resolves --panel orchestrator for a full client through its Sessions', async () => {
    const delivered: { channel: string; args: unknown[] }[] = [];
    const transport = async (request: RemoteHttpRequest): Promise<RemoteHttpResponse> => {
      const body = decodeBoundary(JSON.parse(request.body ?? '{}'), boundary.object({ channel: boundary.string, args: boundary.array(boundary.json) }));
      delivered.push(body);
      if (body.channel === 'runpane:panels:list') {
        return { status: 500, body: JSON.stringify({ ok: false, error: { message: 'Panel list request must include paneId' } }) };
      }
      if (body.channel === 'runpane:sessions:list') {
        return { status: 200, body: JSON.stringify({ ok: true, result: { ok: true, sessions: [
          { id: 'legacy-pane-chat', name: 'Pane Chat', agent: 'claude', panelIds: { claude: '__pane_chat_terminal__' } },
          { id: 's-old', name: 'old', archived: true, agent: 'claude', panelIds: { claude: 'orch-old' } },
          { id: 's-main', name: 'main', agent: 'claude', panelIds: { claude: 'orch-main', codex: 'other' } },
        ] } }) };
      }
      return { status: 200, body: JSON.stringify({ ok: true, result: { ok: true } }) };
    };
    await invokeRemote(cloudTarget(), 'runpane:panels:submit', [{ panelId: 'orchestrator', input: 'hi' }], { ...fast, transport });
    // panels:list is a reviewed read, so the client retries the refusal before falling back.
    assert.deepEqual([...new Set(delivered.map((call) => call.channel))], ['runpane:panels:list', 'runpane:sessions:list', 'runpane:panels:submit']);
    const submitted = decodeBoundary(delivered[delivered.length - 1]!.args[0], boundary.object({ panelId: boundary.string }));
    assert.equal(submitted.panelId, 'orch-main');
  });

  it('names the coordinator\'s reason when it rejects the caller', async () => {
    const transport = async (request: RemoteHttpRequest): Promise<RemoteHttpResponse> => {
      if (request.url.startsWith(COORD_URL)) {
        return { status: 403, body: JSON.stringify({ ok: false, code: 'auth-unknown-peer', message: 'caller m3cli-a is not a cloud Session in the directory' }) };
      }
      throw new RemoteConnectError('connect ETIMEDOUT', 'ETIMEDOUT');
    };
    await assert.rejects(
      invokeRemote(cloudTarget(), 'runpane:panels:list', [{}], { ...fast, transport }),
      { name: 'RemoteTargetError', code: 'ERR_RUNPANE_COORDINATOR_AUTH', message: /not a cloud Session in the directory/ },
    );
  });

  it('says a plain unreachable host cannot be woken', async () => {
    const transport = async (): Promise<RemoteHttpResponse> => {
      throw new RemoteConnectError('connect ECONNREFUSED', 'ECONNREFUSED');
    };
    const target: DaemonTarget = { host: { id: 'h', label: 'laptop', baseUrl: 'http://127.0.0.1:1', token: 't' }, source: 'test' };
    await assert.rejects(
      invokeRemote(target, 'runpane:panels:submit', [{ panelId: 'x', input: 'hi' }], { ...fast, transport }),
      { name: 'RemoteTargetError', code: 'ERR_RUNPANE_HOST_UNREACHABLE' },
    );
  });

  it('tells the user to wake an unreachable cloud host when no coordinator is configured', async () => {
    const transport = async (): Promise<RemoteHttpResponse> => {
      throw new RemoteConnectError('connect ETIMEDOUT', 'ETIMEDOUT');
    };
    const target: DaemonTarget = {
      host: {
        id: 'cloud-x', label: 'Checkout', baseUrl: 'https://rp-x1234567.example.ts.net', token: 't',
        cloud: { provider: 'boat', sandboxId: 'bx_1', sessionId: 'x1234567ab', hostname: 'rp-x1234567' },
      },
      source: 'test',
    };
    await assert.rejects(
      invokeRemote(target, 'runpane:panels:list', [{}], { ...fast, transport }),
      { name: 'RemoteTargetError', code: 'ERR_RUNPANE_HOST_UNREACHABLE', message: /run `runpane cloud wake rp-x1234567`/iu },
    );
  });
});

describe('resolveDaemonTarget', () => {
  let dir: string;
  let env: NodeJS.ProcessEnv;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'runpane-target-'));
    env = { RUNPANE_CLOUD_DIR: path.join(dir, 'cloud'), PANE_DIR: path.join(dir, 'pane') };
    fs.mkdirSync(path.join(dir, 'cloud', 'hosts'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'pane'), { recursive: true });
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('decodes a literal connection code and a pairing file', () => {
    const code = pairingCode('box', 'https://box.tail.ts.net/', 'tok-123456789');
    assert.deepEqual(resolveDaemonTarget(code, { env }).host, {
      id: 'box:https://box.tail.ts.net:23456789', label: 'box', baseUrl: 'https://box.tail.ts.net', token: 'tok-123456789',
    });
    const file = path.join(dir, 'box.pairing');
    fs.writeFileSync(file, `${code}\n`, { mode: 0o600 });
    assert.equal(resolveDaemonTarget(file, { env }).host.baseUrl, 'https://box.tail.ts.net');
  });

  it('finds peers by session id, hostname, label and MagicDNS name, with the coordinator', () => {
    fs.writeFileSync(path.join(dir, 'cloud', 'peers.json'), JSON.stringify({
      v: 1,
      coordinator: { baseUrl: COORD_URL, token: 'rpc1.a.b' },
      hosts: [{ ...cloudTarget().host, transport: 'http+sse' }, { junk: true }],
    }));
    for (const selector of ['bbbbbbbbbb', 'rp-bbbbbbbb', 'Session-B', 'rp-bbbbbbbb.tail.ts.net']) {
      const target = resolveDaemonTarget(selector, { env, cloudOnly: true });
      assert.equal(target.host.id, 'b', selector);
      assert.deepEqual(target.coordinator, { baseUrl: COORD_URL, token: 'rpc1.a.b' });
    }
  });

  it('reads runpane cloud host records with coordinator.json', () => {
    fs.writeFileSync(path.join(dir, 'cloud', 'hosts', 'rp-bbbbbbbb.json'), JSON.stringify({ version: 1, profile: cloudTarget().host, meta: {} }));
    fs.writeFileSync(path.join(dir, 'cloud', 'coordinator.json'), JSON.stringify({ baseUrl: COORD_URL, token: 'user-tok' }));
    const target = resolveDaemonTarget('rp-bbbbbbbb', { env });
    assert.equal(target.host.cloud?.sandboxId, 'bx_b');
    assert.equal(target.coordinator?.token, 'user-tok');
  });

  it('falls back to the desktop profiles, but not for --thread', () => {
    fs.writeFileSync(path.join(dir, 'pane', 'config.json'), JSON.stringify({
      remoteDaemon: { client: { profiles: [{ id: 'p1', label: 'Workstation', baseUrl: 'https://ws.tail.ts.net', token: 't', transport: 'http+sse' }] } },
    }));
    assert.equal(resolveDaemonTarget('workstation', { env }).host.id, 'p1');
    assert.throws(() => resolveDaemonTarget('workstation', { env, cloudOnly: true }), /No cloud Session named "workstation"/);
    assert.throws(() => resolveDaemonTarget('nope', { env }), /No host named "nope"/);
  });

  it('clears local Pane terminal ids once a remote target is chosen', () => {
    const code = pairingCode('box', 'https://box.tail.ts.net', 'tok');
    const processEnv: NodeJS.ProcessEnv = { ...env, RUNPANE_HOST: code, PANE_PANEL_ID: 'local-panel', PANE_SESSION_ID: 'local-pane' };
    try {
      assert.equal(configureDaemonTarget({}, processEnv)?.host.label, 'box');
      assert.equal(processEnv.PANE_PANEL_ID, undefined);
      assert.equal(processEnv.PANE_SESSION_ID, undefined);
      assert.throws(() => configureDaemonTarget({ host: 'a', thread: 'b' }, processEnv), /either --host or --thread/);
    } finally {
      resetDaemonTarget();
    }
  });
});

describe('invokeDaemon over HTTP (real sockets)', () => {
  it('calls /invoke with the bearer token and decodes the result', async () => {
    const seen: Array<{ auth: string | undefined; body: string }> = [];
    const server = http.createServer((request, response) => {
      let body = '';
      request.on('data', (chunk: Buffer) => { body += chunk.toString(); });
      request.on('end', () => {
        seen.push({ auth: request.headers.authorization, body });
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ ok: true, result: { ok: true, paneId: 'p1', panels: [] } }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = listeningAddress(server);
    try {
      const target: DaemonTarget = { host: { id: 'h', label: 'h', baseUrl: `http://127.0.0.1:${port}`, token: 'sekrit' }, source: 'test' };
      const result = await invokeDaemon('runpane:panels:list', [{ paneId: 'p1' }], boundary.object({ paneId: boundary.string }), { target });
      assert.deepEqual(result, { paneId: 'p1' });
      assert.equal(seen[0]!.auth, 'Bearer sekrit');
      const body = decodeBoundary(JSON.parse(seen[0]!.body), boundary.object({ channel: boundary.string, args: boundary.array(boundary.json), runtimeId: boundary.string }));
      assert.equal(body.channel, 'runpane:panels:list');
      assert.deepEqual(body.args, [{ paneId: 'p1' }]);
      assert.match(body.runtimeId, /^runpane-cli-[0-9a-f]{16}$/);
    } finally {
      server.close();
    }
  });

  it('maps an unreachable host to a PaneDaemonClientError code', async () => {
    const server = http.createServer();
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = listeningAddress(server);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    const target: DaemonTarget = { host: { id: 'h', label: 'gone', baseUrl: `http://127.0.0.1:${port}`, token: 't' }, source: 'test' };
    await assert.rejects(
      invokeDaemon('runpane:panels:list', [{}], boundary.json, { target }),
      { name: 'PaneDaemonClientError', code: 'ERR_RUNPANE_HOST_UNREACHABLE' },
    );
  });
});

describe('nodeHttpTransport', () => {
  it('tells a refused connection apart from one that opened and then broke', async () => {
    const server = http.createServer((request) => request.socket.destroy());
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = listeningAddress(server);
    const base = { method: 'POST' as const, headers: { Authorization: 'Bearer t' }, body: '{}', connectTimeoutMs: 2_000, timeoutMs: 2_000 };
    try {
      await assert.rejects(
        nodeHttpTransport({ ...base, url: `http://127.0.0.1:${port}/invoke` }),
        { name: 'Error', message: /socket hang up/ },
      );
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    await assert.rejects(
      nodeHttpTransport({ ...base, url: `http://127.0.0.1:${port}/invoke` }),
      { name: 'RemoteConnectError', code: 'ECONNREFUSED' },
    );
  });

  it('times out a connection that never opens as a connect error', async () => {
    // 10.255.255.1 is unroutable, so the SYN goes unanswered like an offline tailnet node.
    await assert.rejects(
      nodeHttpTransport({ url: 'http://10.255.255.1:9/invoke', method: 'GET', headers: { Authorization: 'Bearer t' }, connectTimeoutMs: 300, timeoutMs: 5_000 }),
      { name: 'RemoteConnectError' },
    );
  });
});
