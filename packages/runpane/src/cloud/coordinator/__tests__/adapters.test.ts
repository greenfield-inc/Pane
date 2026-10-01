import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { BoatCoordinatorProvider, BoatProviderError, mapBoatState } from '../boatProvider';
import { parseCoordinatorConfig } from '../config';
import { decodeHealth, decodeSafeToStop, HttpDaemonProbe } from '../daemonProbe';
import { parseDirectory } from '../directory';
import { renderSystemdUnit } from '../service';
import type { DaemonHealth } from '../types';
import type { JsonValue } from '../../../boundaryDecoder';

function readyOf(health: DaemonHealth): boolean {
  return health.reachable && health.ready;
}

function jsonResponse(status: number, body: JsonValue): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

describe('boat provider', () => {
  it('maps boat states', () => {
    assert.equal(mapBoatState('idle'), 'running');
    assert.equal(mapBoatState('archived'), 'stopped');
    assert.equal(mapBoatState('archiving'), 'stopping');
    assert.equal(mapBoatState('cloning'), 'starting');
    assert.equal(mapBoatState('cancelled'), 'failed');
  });

  it('pages through the list, sends the bearer key, and maps 404 to missing', async () => {
    const requests: Array<{ url: string; init: RequestInit }> = [];
    const provider = new BoatCoordinatorProvider({
      apiBase: 'https://boat.test/api/v1',
      apiKey: 'boat_key',
      fetchImpl: async (url, init) => {
        requests.push({ url, init });
        if (url.includes('/sandboxes?') && !url.includes('cursor=')) {
          return jsonResponse(200, { ok: true, sandboxes: [{ id: 'bx_a', name: 'rp-a', state: 'idle' }], pageInfo: { nextCursor: 'c2' } });
        }
        if (url.includes('cursor=c2')) {
          return jsonResponse(200, { ok: true, sandboxes: [{ id: 'bx_b', name: 'rp-b', state: 'archived' }], pageInfo: { nextCursor: null } });
        }
        if (url.endsWith('/sandboxes/bx_gone')) return jsonResponse(404, { ok: false, error: { code: 'not_found' } });
        if (url.endsWith('/sandboxes/bx_limited/resume')) {
          return jsonResponse(429, { ok: false, code: 'rate_limited', message: 'Rate limit hit: 60 sandbox starts per hour', error: { code: 'rate_limited' } });
        }
        return jsonResponse(202, { ok: true, id: 'bx_a', status: 'resuming' });
      },
    });
    const list = await provider.list();
    assert.deepEqual(list.map((item) => `${item.id}:${item.state}`), ['bx_a:running', 'bx_b:stopped']);
    assert.equal((await provider.get('bx_gone')).state, 'missing');
    await provider.resume('bx_b');
    const resume = requests.at(-1);
    assert.ok(resume);
    assert.equal(resume.url, 'https://boat.test/api/v1/sandboxes/bx_b/resume');
    const headers = new Headers(resume.init.headers);
    assert.equal(headers.get('authorization'), 'Bearer boat_key');
    assert.equal('delete' in provider, false);
    await assert.rejects(provider.resume('bx_limited'), (error: Error) => (
      error instanceof BoatProviderError && error.status === 429 && /rate_limited\): Rate limit hit: 60 sandbox starts per hour/.test(error.message)
    ));
  });
});

describe('daemon probe decoding', () => {
  it('treats today\'s /health as ready and honours explicit readiness fields', () => {
    assert.equal(readyOf(decodeHealth({ ok: true, status: 'ready', transport: 'http+sse' })), true);
    assert.equal(readyOf(decodeHealth({ ok: true, status: 'ready', version: '2.5.0', readiness: { state: 'starting' } })), false);
    assert.equal(readyOf(decodeHealth({ ok: true, status: 'ready', version: '2.5.0', readiness: { state: 'degraded' } })), true);
    assert.equal(readyOf(decodeHealth({ ok: true, status: 'ready', readiness: { state: 'ready', agents: { expected: 1 } } })), true);
    assert.equal(readyOf(decodeHealth({ ok: true, status: 'ready', version: '2.5.0', ready: false })), false);
    assert.equal(readyOf(decodeHealth({ ok: true, status: 'ready', composersReady: false })), false);
    assert.equal(readyOf(decodeHealth({ ok: true, status: 'starting' })), false);
    assert.equal(readyOf(decodeHealth({ ok: true, status: 'ready', readiness: { ready: false } })), false);
  });

  it('decodes safe-to-stop answers', () => {
    const flush = { walCheckpoint: { busy: 0, log: 2, checkpointed: 2 }, fsynced: [], syncedFilesystem: true, durationMs: 3 };
    assert.deepEqual(
      decodeSafeToStop({ ok: true, safe: true, blockers: [], flush: { ...flush, durable: true, failures: [] } }),
      { kind: 'safe', checkpointed: true },
    );
    // Only a flush the daemon verified durable counts; older daemons never said so.
    assert.deepEqual(
      decodeSafeToStop({ ok: true, safe: true, blockers: [], flush: { ...flush, durable: false, failures: ['sync failed'] } }),
      { kind: 'safe', checkpointed: false },
    );
    assert.deepEqual(decodeSafeToStop({ ok: true, safe: true, blockers: [], flush }), { kind: 'safe', checkpointed: false });
    assert.deepEqual(decodeSafeToStop({ ok: true, safe: true, blockers: [], flush: null }), { kind: 'safe', checkpointed: false });
    assert.deepEqual(
      decodeSafeToStop({ ok: true, safe: false, blockers: [{ condition: 'agent-working', message: 'panel p1' }, { condition: 'lock-held' }], flush: null }),
      { kind: 'unsafe', reasons: ['agent-working: panel p1', 'lock-held'] },
    );
  });

  it('maps unknown channels to unsupported and never throws on network errors', async () => {
    const unknown = new HttpDaemonProbe({
      fetchImpl: async () => jsonResponse(404, { ok: false, error: { code: 'ERR_UNKNOWN_CHANNEL', message: 'No Pane daemon command registered' } }),
    });
    assert.equal((await unknown.safeToStop('https://d', 't')).kind, 'unsupported');
    const down = new HttpDaemonProbe({ fetchImpl: async () => { throw new TypeError('fetch failed'); } });
    assert.equal((await down.safeToStop('https://d', 't')).kind, 'error');
    assert.equal((await down.health('https://d')).reachable, false);
  });
});

describe('config and directory', () => {
  it('fills defaults and refuses wildcard listen addresses', () => {
    const config = parseCoordinatorConfig({
      version: 1,
      listenHost: '100.64.0.1',
      provider: { kind: 'boat', apiKeyFile: '/k' },
      managedNamePrefix: 'rp-',
    }, '/home/c');
    assert.equal(config.listenPort, 47300);
    assert.equal(config.guards.maxLiveSandboxes, 25);
    assert.equal(config.idleStop.requiredConsecutiveSafe, 2);
    assert.equal(config.directoryFile, '/home/c/directory.json');
    assert.throws(() => parseCoordinatorConfig({
      version: 1,
      listenHost: '0.0.0.0',
      provider: { kind: 'boat', apiKeyFile: '/k' },
      managedNamePrefix: 'rp-',
    }), /wildcard/);
  });

  it('parses the directory and rejects duplicates', () => {
    const parsed = parseDirectory({
      version: 1,
      sessions: [{ sessionId: 's1', provider: 'boat', sandboxId: 'bx_a', baseUrl: 'https://rp-s1.t.ts.net/' }],
    });
    assert.equal(parsed.entries[0].baseUrl, 'https://rp-s1.t.ts.net');
    assert.equal(parsed.entries[0].label, 's1');
    assert.throws(() => parseDirectory({
      version: 1,
      sessions: [
        { sessionId: 's1', provider: 'boat', sandboxId: 'bx_a', baseUrl: 'https://a' },
        { sessionId: 's1', provider: 'boat', sandboxId: 'bx_b', baseUrl: 'https://b' },
      ],
    }), /duplicate/);
  });

  it('renders a unit that is never the daemon unit', () => {
    const unit = renderSystemdUnit({ nodePath: '/usr/bin/node', entryPath: '/opt/rp/main.js', configPath: '/home/u/c.json' });
    assert.match(unit, /ExecStart=\/usr\/bin\/node \/opt\/rp\/main.js serve --config \/home\/u\/c.json/);
    assert.doesNotMatch(unit, /pane-remote-daemon/);
  });
});
