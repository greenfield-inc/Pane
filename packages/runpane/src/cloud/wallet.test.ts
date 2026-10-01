import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseCloudArgs } from './args';
import { createBoatProvider } from './boat';
import { runCloudCommand } from './commands';
import { BoatCoordinatorProvider } from './coordinator/boatProvider';
import { parseDirectory } from './coordinator/directory';
import { createTestHarness, type TestHarness } from './__tests__/fakes';

// boat wallets (organizations): the wallet a sandbox bills is fixed at create, and boat bills the
// account's *active* wallet when a request names none. `runpane cloud` names it on every create and
// scopes each host's calls to the wallet that host bills.

async function run(harness: TestHarness, argv: string[]): Promise<number> {
  return runCloudCommand(parseCloudArgs(argv), harness.deps);
}

interface WalletJson {
  host?: { hostname: string; boatOrg: { id: string; name: string } | null };
  hosts?: { hostname: string; boatOrg: { id: string; name: string } | null }[];
  settings?: { boatOrg?: { id: string; name: string } };
}

function lastJson(harness: TestHarness): WalletJson {
  return JSON.parse(harness.out[harness.out.length - 1]);
}

async function newHost(harness: TestHarness, extra: string[] = []): Promise<string> {
  assert.equal(await run(harness, ['new', '--name-prefix', 'rp-test', '--no-import', '--yes', '--json', ...extra]), 0);
  const host = lastJson(harness).host;
  assert.ok(host);
  return host.hostname;
}

// ---------------------------------------------------------------- the boat adapter

interface Recorded {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: { org?: string } | undefined;
}

function recordingBoat(responses: Array<{ status: number; body?: unknown }>, org?: string) {
  const calls: Recorded[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((value, key) => {
      headers[key] = value;
    });
    calls.push({ method: init?.method ?? 'GET', url: String(input), headers, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const next = responses.shift() ?? { status: 200, body: { ok: true } };
    return new Response(next.body === undefined ? '' : JSON.stringify(next.body), { status: next.status });
  };
  return { calls, boat: createBoatProvider({ apiKey: 'boat_test', org, fetchImpl, sleep: async () => undefined }) };
}

function boatSandbox(team: { id: string; name: string } | null | undefined) {
  const base = { id: 'bx_abcdefgh', name: 'rp-x', state: 'idle', type: 'small' };
  return team === undefined ? base : { ...base, team };
}

test('a wallet-scoped boat provider sends X-Boat-Org on every call, and org in the create body', async () => {
  const { calls, boat } = recordingBoat([
    { status: 202, body: { ok: true, sandbox: boatSandbox({ id: 'team_852', name: 'test' }) } },
    { status: 200, body: { ok: true, sandbox: boatSandbox({ id: 'team_852', name: 'test' }) } },
  ], 'team_852');
  const created = await boat.create({ name: 'rp-x', size: 'small', idempotencyKey: 'k1' });
  assert.deepEqual(created.org, { id: 'team_852', name: 'test' });
  assert.equal(calls[0].body?.org, 'team_852');
  await boat.get('bx_abcdefgh');
  await boat.list();
  await boat.stop('bx_abcdefgh');
  await boat.resume('bx_abcdefgh');
  await boat.handle('bx_abcdefgh').writeFile('/home/user/x', 'x');
  await boat.destroy('bx_abcdefgh');
  for (const call of calls) assert.equal(call.headers['x-boat-org'], 'team_852', `${call.method} ${call.url}`);
});

test('a create naming another wallet sends that one in both the body and the header', async () => {
  const { calls, boat } = recordingBoat([{ status: 202, body: { ok: true, sandbox: boatSandbox(null) } }], 'team_852');
  const created = await boat.create({ name: 'rp-x', size: 'small', idempotencyKey: 'k2', org: 'personal' });
  assert.equal(calls[0].body?.org, 'personal');
  assert.equal(calls[0].headers['x-boat-org'], 'personal');
  // boat's `team: null` means the owner (personal) is billed.
  assert.deepEqual(created.org, { id: 'personal', name: 'Personal' });
});

test('an unscoped provider sends no X-Boat-Org, and a sandbox without `team` has no known wallet', async () => {
  const { calls, boat } = recordingBoat([{ status: 200, body: { ok: true, sandbox: boatSandbox(undefined) } }]);
  assert.equal((await boat.get('bx_abcdefgh')).org, undefined);
  assert.equal(calls[0].headers['x-boat-org'], undefined);
});

test('listOrgs names the personal wallet `personal`', async () => {
  const { boat } = recordingBoat([{ status: 200, body: { ok: true, orgs: [
    { id: '291db8d1-uuid', name: 'Personal', type: 'personal', active: false },
    { id: 'team_852', name: 'test', type: 'org', active: true },
  ] } }]);
  assert.deepEqual(await boat.listOrgs(), [
    { id: 'personal', name: 'Personal', active: false },
    { id: 'team_852', name: 'test', active: true },
  ]);
});

// ---------------------------------------------------------------- setup / new / list / status

test('setup --boat-org resolves a name, an id or personal against GET /orgs and saves it', async () => {
  const harness = await createTestHarness();
  assert.equal(await run(harness, ['setup', '--boat-org', 'TEST', '--no-verify', '--json']), 0);
  assert.deepEqual((await harness.deps.store.readSettings()).boatOrg, { id: 'team_test1', name: 'test' });
  assert.equal(await run(harness, ['setup', '--boat-org', 'personal', '--no-verify']), 0);
  assert.deepEqual((await harness.deps.store.readSettings()).boatOrg, { id: 'personal', name: 'Personal' });
  assert.match(harness.out.join('\n'), /boat wallet \(new\): +Personal/u);
  await assert.rejects(run(harness, ['setup', '--boat-org', 'acme', '--no-verify']), /No boat wallet "acme"\. Yours: Personal \(personal\) \[active\], test \(team_test1\)/u);
  harness.world.orgs.push({ id: 'team_test2', name: 'Test' });
  await assert.rejects(run(harness, ['setup', '--boat-org', 'test', '--no-verify']), /Several boat organizations are named "test"; pass the id: team_test1, team_test2/u);
});

test('new bills the saved wallet even when another is active, and records it on the host', async () => {
  const harness = await createTestHarness();
  harness.world.activeOrg = 'team_test1';
  await harness.deps.store.writeSettings({ boatOrg: { id: 'personal', name: 'Personal' } });
  const hostname = await newHost(harness);
  const [sandbox] = harness.world.sandboxes.values();
  assert.deepEqual(sandbox.org, { id: 'personal', name: 'Personal' }, 'the active test wallet was not billed');
  assert.ok(harness.world.orgCalls.includes('create(org=personal) personal'));
  assert.deepEqual(lastJson(harness).host?.boatOrg, { id: 'personal', name: 'Personal' });
  const [record] = await harness.deps.store.listHosts();
  assert.equal(record.profile.cloud.hostname, hostname);
  assert.deepEqual(record.meta.boatOrg, { id: 'personal', name: 'Personal' });
});

test('new --boat-org overrides the saved wallet for one create', async () => {
  const harness = await createTestHarness();
  await harness.deps.store.writeSettings({ boatOrg: { id: 'personal', name: 'Personal' } });
  await newHost(harness, ['--boat-org', 'test']);
  const [sandbox] = harness.world.sandboxes.values();
  assert.deepEqual(sandbox.org, { id: 'team_test1', name: 'test' });
  await assert.rejects(run(harness, ['new', '--boat-org', 'nope', '--no-import', '--yes']), /No boat wallet "nope"/u);
  assert.equal(harness.world.sandboxes.size, 1, 'an unknown wallet creates nothing');
});

test('with no wallet saved, new records the wallet boat billed and says it was the active one', async () => {
  const harness = await createTestHarness();
  harness.world.activeOrg = 'team_test1';
  assert.equal(await run(harness, ['new', '--name-prefix', 'rp-test', '--no-import', '--yes']), 0);
  assert.match(harness.out.join('\n'), /boat wallet: test \(team_test1\) \(boat's active wallet; pin one with runpane cloud setup --boat-org <org\|personal>\)/u);
  const [record] = await harness.deps.store.listHosts();
  assert.deepEqual(record.meta.boatOrg, { id: 'team_test1', name: 'test' });
});

test("lifecycle calls for a host go to the host's own wallet, whatever is active or saved now", async () => {
  const harness = await createTestHarness();
  await harness.deps.store.writeSettings({ boatOrg: { id: 'team_test1', name: 'test' } });
  const hostname = await newHost(harness);
  const [sandbox] = harness.world.sandboxes.values();
  // The saved wallet and the active one change later; the host keeps billing test.
  await harness.deps.store.writeSettings({ boatOrg: { id: 'personal', name: 'Personal' } });
  harness.world.activeOrg = 'personal';
  harness.world.orgCalls.length = 0;
  assert.equal(await run(harness, ['stop', hostname, '--yes', '--json']), 0);
  assert.equal(await run(harness, ['wake', hostname, '--json']), 0);
  assert.ok(harness.world.orgCalls.includes(`stop ${sandbox.id} team_test1`));
  assert.ok(harness.world.orgCalls.includes(`resume ${sandbox.id} team_test1`));
  assert.deepEqual(harness.world.orgCalls.filter((call) => call.startsWith('stop ') || call.startsWith('resume ')).filter((call) => !call.endsWith(' team_test1')), []);

  assert.equal(await run(harness, ['status', hostname, '--json']), 0);
  assert.deepEqual(lastJson(harness).host?.boatOrg, { id: 'team_test1', name: 'test' });
  assert.equal(await run(harness, ['list', '--json']), 0);
  assert.deepEqual(lastJson(harness).hosts?.map((host) => host.boatOrg?.name), ['test']);
  assert.equal(await run(harness, ['destroy', hostname, '--yes', '--no-import', '--json']), 0);
  assert.ok(harness.world.orgCalls.includes(`destroy ${sandbox.id} team_test1`));
});

test('a host recorded before wallets were tracked learns its wallet from boat once', async () => {
  const harness = await createTestHarness();
  const hostname = await newHost(harness);
  const [record] = await harness.deps.store.listHosts();
  delete record.meta.boatOrg;
  await harness.deps.store.writeHost(record);
  harness.world.activeOrg = 'team_test1';
  harness.world.orgCalls.length = 0;
  assert.equal(await run(harness, ['stop', hostname, '--yes', '--json']), 0);
  const [after] = await harness.deps.store.listHosts();
  assert.deepEqual(after.meta.boatOrg, { id: 'personal', name: 'Personal' });
  assert.ok(harness.world.orgCalls.includes(`stop ${record.profile.cloud.sandboxId} personal`), 'not the now-active test wallet');
});

// ---------------------------------------------------------------- the coordinator

test('coordinator deploy --boat-org bills that wallet and writes it into the coordinator config', async () => {
  const harness = await createTestHarness();
  harness.world.activeOrg = 'personal';
  await harness.deps.store.writeSettings({ namePrefix: 'rp-test' });
  assert.equal(await run(harness, ['coordinator', 'deploy', '--yes', '--boat-org', 'test', '--json']), 0);
  const deployment = (await harness.deps.store.readSettings()).coordinator?.deployment;
  assert.deepEqual(deployment?.boatOrg, { id: 'team_test1', name: 'test' });
  assert.deepEqual(harness.world.sandboxes.get(deployment?.sandboxId ?? '')?.org, { id: 'team_test1', name: 'test' });
  const config = JSON.parse(harness.world.files.get(`${deployment?.sandboxId}:/home/user/.runpane-cloud/coordinator-stage/config.json`) ?? '{}');
  assert.equal(config.provider.org, 'team_test1');
});

test("the coordinator scopes each Session's calls to the wallet the directory names", async () => {
  const seen: string[] = [];
  const provider = new BoatCoordinatorProvider({
    apiBase: 'https://boat.test/api/v1',
    apiKey: 'scoped',
    org: 'team_852',
    fetchImpl: async (url, init) => {
      seen.push(`${init.method} ${url.replace('https://boat.test/api/v1', '')} ${new Headers(init.headers).get('X-Boat-Org') ?? '-'}`);
      if (url.includes('/sandboxes?')) {
        return new Response(JSON.stringify({ ok: true, sandboxes: [
          { id: 'bx_p', name: 'rp-p', state: 'idle', team: null },
          { id: 'bx_t', name: 'rp-t', state: 'idle', team: { id: 'team_852', name: 'test' } },
        ] }), { status: 200 });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 202 });
    },
  });
  assert.deepEqual((await provider.list()).map((sandbox) => `${sandbox.id}:${sandbox.org}`), ['bx_p:personal', 'bx_t:team_852']);
  await provider.resume('bx_p', 'personal');
  await provider.stop('bx_t');
  assert.deepEqual(seen.slice(1), ['POST /sandboxes/bx_p/resume personal', 'POST /sandboxes/bx_t/stop team_852']);

  const { entries } = parseDirectory({ version: 1, sessions: [
    { sessionId: 's1', provider: 'boat', sandboxId: 'bx_p', baseUrl: 'https://a', org: 'personal' },
    { sessionId: 's2', provider: 'boat', sandboxId: 'bx_t', baseUrl: 'https://b' },
  ] });
  assert.deepEqual(entries.map((entry) => entry.org), ['personal', null]);
});
