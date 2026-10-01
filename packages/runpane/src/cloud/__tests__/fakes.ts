import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { JsonObject, JsonValue } from '../../boundaryDecoder';
import type { CloudDeps } from '../commands';
import { NO_COORDINATOR } from '../coordinatorSync';
import { encodePairingCode } from '../pairing';
import type { BootstrapPort, ProvisionRequest, TailnetDevice, TailnetPort } from '../ports';
import type { BundlePushRequest, GitHubPort, GitHubRepoInfo } from '../githubApi';
import type { CoordinatorGitHubStatus } from '../githubBroker';
import { CloudProviderError, type CloudProvider, type CloudSandbox, type CloudSize, type CreateSandboxRequest, type SandboxHandle } from '../provider';
import { createCloudStore, type GitHubTokenSource } from '../store';

/**
 * In-memory fakes for the `runpane cloud` tests: a provider whose sandboxes move through states
 * on each poll, a tailnet, and a bootstrap that "joins" the tailnet and writes a pairing file.
 * Nothing here talks to the network.
 */

interface FakeSandbox extends CloudSandbox {
  /** States still to pass through, one per `get` call, before `state` settles. */
  pending: CloudSandbox['state'][];
}

interface FakeWorld {
  sandboxes: Map<string, FakeSandbox>;
  /** Directories pushed to the coordinator, oldest first; undefined = no coordinator configured. */
  pushedDirectories?: JsonObject[];
  failPush?: string;
  devices: TailnetDevice[];
  calls: string[];
  scripts: { sandboxId: string; script: string }[];
  healthy: Set<string>;
  failProvision?: string;
  /** Files written into sandboxes, by `<sandboxId>:<path>`. */
  files: Map<string, string>;
  /** Fake daemons: Sessions and peer records per sandbox hostname. */
  daemons: Map<string, FakeDaemon>;
  /** Guardrails each host's daemon was given (runpane:cloud:agent-notes); hosts listed in agentNotesDown don't answer. */
  agentNotes: Map<string, string[]>;
  agentNotesDown: Set<string>;
  coordinatorHealthy: boolean;
  /** Shared by every fake provider instance, so ids stay unique across `createProvider` calls. */
  sandboxCounter: number;
  createdByKey: Map<string, string>;
  /** Hosts whose tailnet node comes back logged out after a resume (healthy again once repaired). */
  loggedOut: Set<string>;
  /** The bearer token each CLI /health wait sent (undefined: none). */
  healthTokens: (string | undefined)[];
  /** The Pane version each host's daemon reports on /health (default 2.4.141). */
  daemonVersions: Map<string, string>;
  /** The Pane pin each host's sandbox holds (/etc/rp-cloud/pane-pin.json): a version, or null once cleared. */
  panePins: Map<string, string | null>;
  /** Hosts whose Tailscale Serve config a resume lost (Running, but /health unreachable until re-applied). */
  serveLost: Set<string>;
  /** When true, a coordinator is configured and `wake` goes through it. */
  coordinatorWakes?: boolean;
  /** When set, scoped keys longer than this many days are refused like boat does. */
  maxKeyTtlDays?: number;
  /** When set, revoking a scoped key fails with this message. */
  revokeKeyError?: string;
  /** boat names sandboxes only through a later PATCH: create returns them unnamed when set. */
  createUnnamed?: boolean;
  /** What the daemon's safe-to-stop answers `cloud stop`; 'unreachable' makes the call fail. */
  safeToStop?: { safe: boolean; blockers: { condition: string; message: string }[] } | 'unreachable';
  failRename?: string;
  github: FakeGitHub;
  /** Binary files readable with provider.readFile, by `<sandboxId>:<path>`. */
  binaryFiles: Map<string, Buffer>;
  /** The repository URL each provision was asked to clone. */
  provisionRepos: string[];
  /** The Pane source each provision was asked to install. */
  provisionPaneSources: ProvisionRequest['paneSource'][];
  /** boat wallets: the account's active one bills a create that names none. */
  orgs: { id: string; name: string }[];
  activeOrg: string;
  /** Provider calls with the wallet the provider was scoped to (`-`: none, boat's active wallet). */
  orgCalls: string[];
  /** The Session's Pane-bundled runpane predates `cloud agent` (the broker tools' check says "old"). */
  oldPaneRunpane?: boolean;
  /** What the coordinator's GET /cloud/github/status answers; undefined: no coordinator to ask. */
  broker?: CoordinatorGitHubStatus;
}

/** GitHub as the laptop's credential sees it, plus what the sandbox's git steps report. */
export interface FakeGitHub {
  repos: Map<string, GitHubRepoInfo>;
  keys: { repo: string; id: number; title: string; key: string; readOnly: boolean }[];
  nextKeyId: number;
  pushes: BundlePushRequest[];
  tokenSources: GitHubTokenSource[];
  /** The sandbox's ls-remote with the new credential fails. */
  verifyFails?: boolean;
  /** DELETE of a deploy key fails with this message (GitHub down, credential lost admin). */
  deleteKeyFails?: string;
  /** What the sandbox's bundle step finds; `data` is split into parts the provider can read back. */
  bundle?: { head: string; origin: string; prerequisites: string[]; commits: number; data?: Buffer };
}

export interface FakeDaemon {
  sessions: { id: string; name: string; archived?: boolean }[];
  peers: { id: string; label: string; sessions: string[] }[];
  /** Tokens of its coordinator-scoped clients; undefined: a Pane without runpane:cloud:coordinator-client:*. */
  coordinatorClients?: string[];
}

function createFakeWorld(): FakeWorld {
  return {
    sandboxes: new Map(), devices: [], calls: [], scripts: [], healthy: new Set(),
    files: new Map(), daemons: new Map(), agentNotes: new Map(), agentNotesDown: new Set(), coordinatorHealthy: true, sandboxCounter: 0, createdByKey: new Map(), loggedOut: new Set(), serveLost: new Set(),
    panePins: new Map(),
    daemonVersions: new Map(),
    healthTokens: [],
    binaryFiles: new Map(),
    provisionRepos: [],
    provisionPaneSources: [],
    github: { repos: new Map(), keys: [], nextKeyId: 100, pushes: [], tokenSources: [] },
    orgs: [{ id: 'personal', name: 'Personal' }, { id: 'team_test1', name: 'test' }],
    activeOrg: 'personal',
    orgCalls: [],
  };
}

function createFakeProvider(world: FakeWorld, org?: string): CloudProvider {
  const scoped = (what: string) => world.orgCalls.push(`${what} ${org ?? '-'}`);
  const walletOf = (wanted: string): { id: string; name: string } => {
    const found = world.orgs.find((candidate) => candidate.id === wanted || candidate.name.toLowerCase() === wanted.toLowerCase());
    if (!found) throw new CloudProviderError('boat POST /sandboxes failed with HTTP 403 (not_org_member)', 403, 'not_org_member');
    return found;
  };
  const createdByKey = world.createdByKey;
  const need = (id: string): FakeSandbox => {
    const sandbox = world.sandboxes.get(id);
    if (!sandbox) throw new Error(`fake: no sandbox ${id}`);
    return sandbox;
  };
  const snapshot = (sandbox: FakeSandbox): CloudSandbox => ({
    id: sandbox.id,
    name: sandbox.name,
    state: sandbox.state,
    providerState: sandbox.state,
    size: sandbox.size,
    org: sandbox.org,
  });
  const handle = (id: string): SandboxHandle => ({
    id,
    async runScript(script) {
      scoped(`exec ${id}`);
      world.calls.push(`script ${id}`);
      world.scripts.push({ sandboxId: id, script });
      if (script.includes('tailscale ip -4')) return { exitCode: 0, stdout: '100.64.0.9\n', stderr: '' };
      if (script.includes("printf 'RP_HEAD")) return { exitCode: 0, stdout: 'RP_HEAD 0123456789abcdef0123456789abcdef01234567\n', stderr: '' };
      if (script.includes('echo RP_OK broker-tools')) return { exitCode: 0, stdout: `${world.oldPaneRunpane ? 'RP_SHIM old runpane 2.4.141-old' : 'RP_SHIM ready'}\nRP_OK broker-tools\n`, stderr: '' };
      const github = fakeSandboxGit(world, id, script);
      if (github) return github;
      const install = /install -m 600 (\S+) (\S+peers\.json)/u.exec(script);
      if (install) world.files.set(`${id}:${install[2]}`, world.files.get(`${id}:${install[1]}`) ?? '');
      return { exitCode: 0, stdout: script.includes('RP_AGENT_ENV') ? 'RP_AGENT_ENV ok\n' : 'RP_COORD ok\n', stderr: '' };
    },
    async writeFile(filePath, content) {
      world.calls.push(`write ${id} ${filePath}`);
      world.files.set(`${id}:${filePath}`, content);
    },
  });
  return {
    name: 'boat',
    async verifyCredentials() {
      return { account: 'fake@example.test' };
    },
    async listOrgs() {
      scoped('orgs');
      return world.orgs.map((candidate) => ({ ...candidate, active: candidate.id === world.activeOrg }));
    },
    async create(request: CreateSandboxRequest) {
      scoped(`create(org=${request.org ?? '-'})`);
      world.calls.push(`create ${request.name} ${request.size} ${request.fromSnapshot ?? '-'}`);
      const existing = createdByKey.get(request.idempotencyKey);
      if (existing) return snapshot(need(existing));
      world.sandboxCounter += 1;
      const sandbox: FakeSandbox = {
        id: `bx_fake${String(world.sandboxCounter).padStart(4, '0')}`,
        name: world.createUnnamed ? '' : request.name,
        state: 'starting',
        providerState: 'provisioning',
        size: request.size,
        pending: ['starting'],
        // Like boat: the body's org, else the request scope, else the account's active wallet.
        org: walletOf(request.org ?? org ?? world.activeOrg),
      };
      world.sandboxes.set(sandbox.id, sandbox);
      createdByKey.set(request.idempotencyKey, sandbox.id);
      return snapshot(sandbox);
    },
    async get(id) {
      const sandbox = world.sandboxes.get(id);
      if (!sandbox) return { id, name: '', state: 'gone', providerState: 'not_found' };
      const next = sandbox.pending.shift();
      if (next === undefined && sandbox.state === 'starting') sandbox.state = 'running';
      if (next === undefined && sandbox.state === 'stopping') sandbox.state = 'stopped';
      return snapshot(sandbox);
    },
    async list() {
      return [...world.sandboxes.values()].map(snapshot);
    },
    async rename(id, name) {
      world.calls.push(`rename ${id} ${name}`);
      if (world.failRename) throw new Error(world.failRename);
      need(id).name = name;
    },
    async stop(id) {
      scoped(`stop ${id}`);
      world.calls.push(`stop ${id}`);
      const sandbox = need(id);
      sandbox.state = 'stopping';
      sandbox.pending = ['stopping'];
      for (const device of world.devices) if (device.hostname === sandbox.name) device.online = false;
    },
    async resume(id, options?: { size?: CloudSize }) {
      scoped(`resume ${id}`);
      world.calls.push(`resume ${id}${options?.size ? ` ${options.size}` : ''}`);
      const sandbox = need(id);
      if (sandbox.state !== 'stopped') throw new Error('fake: resume of a sandbox that is not stopped');
      sandbox.state = 'starting';
      sandbox.pending = ['starting'];
      if (options?.size) sandbox.size = options.size;
      for (const device of world.devices) if (device.hostname === sandbox.name) device.online = true;
    },
    async destroy(id) {
      scoped(`destroy ${id}`);
      world.calls.push(`destroy ${id}`);
      world.sandboxes.delete(id);
    },
    handle,
    async readFile(id, filePath) {
      world.calls.push(`read ${id} ${filePath}`);
      const data = world.binaryFiles.get(`${id}:${filePath}`);
      if (!data) throw new CloudProviderError(`fake: no file ${filePath}`, 404);
      return data;
    },
    async createScopedKey(request) {
      if (world.maxKeyTtlDays !== undefined && Number.parseInt(request.ttl, 10) > world.maxKeyTtlDays) {
        throw new CloudProviderError('boat POST /api-keys/scoped failed with HTTP 403 (api_key_action_forbidden): A delegated key cannot outlive its parent.', 403, 'api_key_action_forbidden');
      }
      world.calls.push(`scoped-key ${request.name} ${request.actions.join(',')}`);
      return { id: 'sak_fake1', secret: 'scoped-secret-value' };
    },
    async revokeKey(keyId) {
      world.calls.push(`revoke-key ${keyId}`);
      if (world.revokeKeyError) throw new CloudProviderError(world.revokeKeyError, 500);
    },
  };
}

/** The sandbox side of `runpane cloud github|git`: keygen, ls-remote, bundle and cleanup scripts. */
function fakeSandboxGit(world: FakeWorld, id: string, script: string) {
  if (script.includes('ssh-keygen -q -t ed25519')) {
    world.calls.push(`sandbox-keygen ${id}`);
    return { exitCode: 0, stdout: `RP_PUBKEY ssh-ed25519 AAAAC3fake${id} runpane-cloud\nRP_FPR SHA256:fake${id}\n`, stderr: '' };
  }
  if (script.includes('git ls-remote')) {
    world.calls.push(`sandbox-ls-remote ${id} ${/git ls-remote '([^']+)'/u.exec(script)?.[1] ?? ''}`);
    return world.github.verifyFails
      ? { exitCode: 1, stdout: 'RP_FAIL git@github.com: Permission denied (publickey).\n', stderr: '' }
      : { exitCode: 0, stdout: 'RP_OK 0123456789abcdef\n', stderr: '' };
  }
  if (script.includes('git bundle create')) {
    const xfer = /mkdir -p (\S+\/xfer\/[0-9a-f]+)/u.exec(script)?.[1] ?? '';
    world.calls.push(`sandbox-bundle ${id}`);
    const bundle = world.github.bundle;
    if (!bundle) return { exitCode: 1, stdout: 'RP_FAIL no such local branch\n', stderr: '' };
    const parts: string[] = [];
    const data = bundle.data ?? Buffer.alloc(0);
    const partSize = 4 * 1024 * 1024;
    for (let offset = 0, index = 0; offset < data.length; offset += partSize, index++) {
      const name = `part-${String(index).padStart(4, '0')}`;
      world.binaryFiles.set(`${id}:${xfer}/${name}`, data.subarray(offset, offset + partSize));
      parts.push(name);
    }
    const summary = {
      head: bundle.head,
      origin: bundle.origin,
      prerequisites: bundle.prerequisites,
      commits: bundle.commits,
      size: data.length,
      sha256: data.length ? createHash('sha256').update(data).digest('hex') : '',
      parts,
    };
    return { exitCode: 0, stdout: `RP_BUNDLE ${JSON.stringify(summary)}\n`, stderr: '' };
  }
  if (script.includes('rp_github_known_hosts') || script.includes('runpane-cloud-git')) {
    world.calls.push(`sandbox-credential-cleanup ${id}`);
    return { exitCode: 0, stdout: 'RP_OK removed\n', stderr: '' };
  }
  if (script.startsWith('rm -rf ') && script.includes('/xfer/')) {
    world.calls.push(`sandbox-xfer-cleanup ${id}`);
    return { exitCode: 0, stdout: '', stderr: '' };
  }
  return undefined;
}

function createFakeGitHub(world: FakeWorld): GitHubPort {
  const github = world.github;
  return {
    async resolveToken(source) {
      github.tokenSources.push(source);
      return 'laptop-gh-token';
    },
    api(token) {
      const repoInfo = (repo: string) => {
        const info = [...github.repos.values()].find((candidate) => candidate.fullName.toLowerCase() === repo.toLowerCase());
        if (!info) throw new Error(`GitHub GET /repos/${repo} failed with HTTP 404: Not Found`);
        return info;
      };
      return {
        async getRepo(repo) {
          world.calls.push(`github-get-repo ${repo} ${token}`);
          return repoInfo(repo);
        },
        async addDeployKey(repo, key) {
          world.calls.push(`github-add-key ${repo} ${key.readOnly ? 'ro' : 'rw'}`);
          const created = { repo: repoInfo(repo).fullName, id: github.nextKeyId++, title: key.title, key: key.key, readOnly: key.readOnly };
          github.keys.push(created);
          return { id: created.id, title: created.title, readOnly: created.readOnly };
        },
        async deleteDeployKey(repo, keyId) {
          world.calls.push(`github-delete-key ${repo} ${keyId}`);
          if (github.deleteKeyFails) throw new Error(github.deleteKeyFails);
          const before = github.keys.length;
          github.keys = github.keys.filter((key) => !(key.repo === repo && key.id === keyId));
          return github.keys.length < before;
        },
        async getDeployKey(repo, keyId) {
          const key = github.keys.find((candidate) => candidate.repo === repo && candidate.id === keyId);
          return key ? { id: key.id, title: key.title, readOnly: key.readOnly } : null;
        },
        async sshKnownHosts() {
          return ['github.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl'];
        },
      };
    },
    async pushBundle(request) {
      world.calls.push(`push ${request.repo} ${request.head} -> ${request.targetRef}`);
      github.pushes.push(request);
      return 'created';
    },
  };
}

function createFakeTailnet(world: FakeWorld): TailnetPort {
  return {
    async findDevicesByHostname(hostname) {
      return world.devices.filter((device) => device.hostname === hostname).map((device) => ({ ...device }));
    },
    async deleteDevice(nodeId) {
      world.calls.push(`tailnet-delete ${nodeId}`);
      world.devices = world.devices.filter((device) => device.nodeId !== nodeId);
    },
  };
}

function createFakeBootstrap(world: FakeWorld): BootstrapPort {
  return {
    cloudHostname: (sessionId, prefix) => `${prefix}-${sessionId.slice(0, 8)}`,
    createTailnet: () => createFakeTailnet(world),
    async writePanePin(sandbox, pin) {
      world.calls.push(`pane-pin ${sandbox.id} ${pin?.version ?? '--clear'}`);
      const host = [...world.sandboxes.values()].find((candidate) => candidate.id === sandbox.id);
      if (host?.state !== 'running') throw new Error(`fake: ${sandbox.id} is not running`);
      world.panePins.set(host.name, pin?.version ?? null);
    },
    async repairServe(sandbox, request) {
      world.calls.push(`repair-serve ${sandbox.id} ${request.transport}`);
      const host = [...world.sandboxes.values()].find((candidate) => candidate.id === sandbox.id)?.name ?? '';
      const serveApplied = world.serveLost.delete(host);
      return { backendState: 'Running', serveApplied, detail: serveApplied ? 'RE-APPLIED' : 'serve ok' };
    },
    async repairTailnet(sandbox, request) {
      world.calls.push(`repair ${sandbox.id} ${request.hostname}`);
      if (!world.loggedOut.has(request.hostname)) return { reenrolled: false, backendState: 'Running' };
      world.loggedOut.delete(request.hostname);
      if (request.hostname.endsWith('-coord')) world.coordinatorHealthy = true;
      world.devices = world.devices.filter((device) => device.hostname !== request.hostname);
      const nodeId = `n${request.hostname.replace(/-/g, '')}NEW`;
      world.devices.push({ nodeId, hostname: request.hostname, name: `${request.hostname}.tailtest.ts.net`, online: true, tags: ['tag:rp-session'] });
      return { reenrolled: true, previousBackendState: 'NeedsLogin', nodeId, magicDnsName: `${request.hostname}.tailtest.ts.net`, deletedNodeIds: [request.oldNodeId ?? ''] };
    },
    async joinTailnet(sandbox, request) {
      world.calls.push(`join ${sandbox.id} ${request.hostname}`);
      const nodeId = `n${request.hostname.replace(/-/g, '')}CNTRL`;
      const magicDnsName = `${request.hostname}.tailtest.ts.net`;
      world.devices.push({ nodeId, hostname: request.hostname, name: magicDnsName, online: true, tags: ['tag:rp-session'] });
      return { nodeId, magicDnsName, tailscaleIps: ['100.64.0.9'] };
    },
    async waitForDaemonHealth(baseUrl, options) {
      world.healthTokens.push(options?.token);
      const host = new URL(baseUrl).hostname.split('.')[0];
      const sandbox = [...world.sandboxes.values()].find((candidate) => candidate.name === host);
      const ok = world.healthy.has(host) && !world.loggedOut.has(host) && !world.serveLost.has(host) && sandbox?.state === 'running';
      return ok ? { ok, elapsedMs: 1, status: 200, version: world.daemonVersions.get(host) ?? '2.4.141' } : { ok, elapsedMs: 1 };
    },
    async provision(sandbox: SandboxHandle, request: ProvisionRequest) {
      world.calls.push(`provision ${sandbox.id} ${request.hostname}`);
      if (request.repo) world.provisionRepos.push(request.repo.url);
      world.provisionPaneSources.push(request.paneSource);
      if (world.failProvision) throw new Error(world.failProvision);
      const nodeId = `n${request.hostname.replace(/-/g, '')}CNTRL`;
      const magicDnsName = `${request.hostname}.tailtest.ts.net`;
      world.devices.push({ nodeId, hostname: request.hostname, name: magicDnsName, online: true, tags: ['tag:rp-session'] });
      world.healthy.add(request.hostname);
      const code = encodePairingCode({
        v: 1,
        label: request.label,
        baseUrl: `https://${magicDnsName}`,
        token: `secret-token-${request.sessionId}`,
        transport: 'http+sse',
        tunnel: { kind: 'tailscale', selected: true },
      });
      await fs.mkdir(path.dirname(request.pairingOutputPath), { recursive: true });
      await fs.writeFile(request.pairingOutputPath, `${code}\n`, { mode: 0o600 });
      for (const extra of request.extraClients ?? []) {
        const extraCode = encodePairingCode({
          v: 1,
          label: extra.label,
          baseUrl: `https://${magicDnsName}`,
          token: `coordinator-token-${request.sessionId}`,
          transport: 'http+sse',
        });
        await fs.writeFile(extra.outputPath, `${extraCode}\n`, { mode: 0o600 });
      }
      return {
        hostname: request.hostname,
        magicDnsName,
        nodeId,
        baseUrl: `https://${magicDnsName}`,
        pairingPath: request.pairingOutputPath,
        daemonVersion: '2.4.141',
        timings: {},
      };
    },
  };
}

export interface TestHarness {
  deps: CloudDeps;
  world: FakeWorld;
  out: string[];
  err: string[];
  root: string;
  desktopDir: string;
}

export async function createTestHarness(): Promise<TestHarness> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'runpane-cloud-test-'));
  const world = createFakeWorld();
  const out: string[] = [];
  const err: string[] = [];
  let clock = 1_000_000;
  const store = createCloudStore(path.join(root, 'cloud'));
  await store.writeCredentials({
    boat: { apiKey: 'boat-test-key' },
    tailscale: { clientId: 'client-id', clientSecret: 'client-secret' },
  });
  const deps: CloudDeps = {
    store,
    github: createFakeGitHub(world),
    createProvider: (_credentials, org) => createFakeProvider(world, org),
    bootstrap: createFakeBootstrap(world),
    readSecretFile: (file) => fs.readFile(file, 'utf8'),
    stdout: (line) => out.push(line),
    stderr: (line) => err.push(line),
    sleep: async (ms) => {
      clock += ms;
    },
    now: () => clock,
    env: {},
    defaultDesktopDir: path.join(root, 'no-desktop-here'),
    async safeToStop(profile) {
      world.calls.push(`safe-to-stop ${profile.baseUrl}`);
      const answer = world.safeToStop ?? { safe: true, blockers: [] };
      if (answer === 'unreachable') throw new Error('connect ECONNREFUSED');
      return { ...answer, flushed: true };
    },
    async pushCoordinatorDirectory(directory) {
      if (!world.pushedDirectories) return { pushed: false, reason: NO_COORDINATOR };
      if (world.failPush) throw new Error(world.failPush);
      world.pushedDirectories.push(directory);
      const sessions = directory.sessions;
      return { pushed: true, sessions: Array.isArray(sessions) ? sessions.length : 0 };
    },
    async wakeViaCoordinator(sessionId) {
      if (!world.coordinatorWakes) return null;
      world.calls.push(`coordinator-wake ${sessionId}`);
      const sandbox = [...world.sandboxes.values()].find((candidate) => candidate.name.endsWith(sessionId.slice(0, 8)));
      if (sandbox?.state === 'running') {
        // An awake Session upgrades only to the pin the laptop wrote into it.
        const pinned = world.panePins.get(sandbox.name);
        if (!pinned) return { status: 'awake', version: world.daemonVersions.get(sandbox.name) ?? '2.4.141', detail: 'version-mismatch: ERR_CLOUD_UPGRADE_NOT_PINNED' };
        world.daemonVersions.set(sandbox.name, pinned);
        return { status: 'awake', version: pinned, detail: `upgraded to pinned ${pinned}` };
      }
      if (!sandbox || sandbox.state !== 'stopped') return { status: 'lost' };
      sandbox.state = 'running';
      sandbox.pending = [];
      return { status: 'awake', version: '2.4.141-pinned', detail: 'upgraded to pinned 2.4.141-pinned' };
    },
    async packCoordinatorApp() {
      return { archiveBase64: 'ZmFrZQ==', version: '2.4.141-test' };
    },
    async callCoordinatorApi(method, pathAndQuery): Promise<{ status: number; body: JsonValue }> {
      world.calls.push(`coordinator-api ${method} ${pathAndQuery}`);
      if (!world.broker) throw new Error('No coordinator client is configured: run runpane cloud coordinator deploy --yes.');
      if (method === 'GET' && pathAndQuery === '/cloud/github/status') {
        return { status: 200, body: { ok: true, mode: world.broker.mode, app: world.broker.app ? { slug: world.broker.app } : null, repos: world.broker.repos, caller: null } };
      }
      return { status: 404, body: { ok: false, code: 'not-found', message: pathAndQuery } };
    },
    async probeCoordinatorHealth() {
      return world.coordinatorHealthy ? { ok: true, status: 200, version: '2.4.141-test' } : { ok: false };
    },
    async invokeDaemon(profile, channel, args): Promise<JsonValue | undefined> {
      const host = new URL(profile.baseUrl).hostname.split('.')[0];
      world.calls.push(`invoke ${host} ${channel}`);
      const request = args[0] ?? {};
      // Every provisioned host's daemon registers repositories.
      if (channel === 'runpane:repos:add') return { ok: true, repo: { path: String(request.path), name: String(request.name) } };
      // ...and keeps the user's guardrails.
      if (channel === 'runpane:cloud:agent-notes') {
        if (world.agentNotesDown.has(host)) throw new Error('connect ETIMEDOUT');
        const guardrails = Array.isArray(request.guardrails) ? request.guardrails.map(String) : [];
        world.agentNotes.set(host, guardrails);
        return { ok: true, guardrails, changedFiles: ['/home/user/.claude/CLAUDE.md', '/home/user/.codex/AGENTS.md'] };
      }
      const daemon = world.daemons.get(host);
      if (!daemon) throw new Error('connect ECONNREFUSED');
      switch (channel) {
        case 'runpane:sessions:list':
          return { ok: true, sessions: daemon.sessions.map((session) => ({ id: session.id, name: session.name, archived: session.archived === true })) };
        case 'runpane:peers:mint': {
          const peer = { id: `peer-${daemon.peers.length + 1}`, label: String(request.label), sessions: Array.isArray(request.sessions) ? request.sessions.map(String) : [] };
          daemon.peers.push(peer);
          const connectionCode = encodePairingCode({ v: 1, label: host, baseUrl: profile.baseUrl, token: `peer-token-${peer.id}`, transport: 'http+sse' });
          return { ok: true, peer: { id: peer.id, label: peer.label, scope: 'peer', allowedSessionIds: peer.sessions }, connectionCode };
        }
        case 'runpane:peers:revoke': {
          const before = daemon.peers.length;
          daemon.peers = daemon.peers.filter((peer) => peer.id !== request.peer);
          if (daemon.peers.length === before) throw new Error('Unknown peer');
          return { ok: true, revoked: true, peerId: String(request.peer) };
        }
        case 'runpane:cloud:coordinator-client:revoke':
        case 'runpane:cloud:coordinator-client:pair': {
          if (!daemon.coordinatorClients) throw new Error(`No Pane daemon command registered for channel "${channel}"`);
          const revokedClientIds = daemon.coordinatorClients;
          daemon.coordinatorClients = [];
          if (channel.endsWith(':revoke')) return { ok: true, revokedClientIds };
          const token = `coordinator-token-${host}-${world.calls.length}`;
          daemon.coordinatorClients.push(token);
          return { ok: true, clientId: `client-${token}`, token, revokedClientIds };
        }
        default:
          throw new Error(`fake daemon: unexpected ${channel}`);
      }
    },
  };
  return { deps, world, out, err, root, desktopDir: path.join(root, 'desktop') };
}
