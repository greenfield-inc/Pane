import { boundary, decodeBoundary, type JsonObject } from '../boundaryDecoder';
import type { CloudDeps } from './commands';
import { mintCallerToken } from './coordinator/callerAuth';
import { decodePairingCode } from './pairing';
import type { CloudProvider } from './provider';
import { hostProvider } from './wallet';
import { findHost, type CloudHostRecord, type PeerGrant } from './store';

/**
 * `runpane cloud peers allow|revoke|list`: which cloud Sessions may message which.
 *
 * "A may message B" is a paired client record with scope 'peer' minted on B's daemon, allowlisted
 * to one Pane Session on B (runpane:peers:mint), whose token goes into A's peers list. A's peers list
 * is `~/.config/runpane-cloud/peers.json` inside A's sandbox: the file `runpane --host <B>` reads there
 * (remote/hostDirectory.ts), which also names the coordinator so a submit can wake a sleeping B.
 * Nothing is allowed by default; revoking deletes B's record, which kills the token at once.
 */

/** Where `runpane` inside a cloud Session looks for its peers list (default RUNPANE_CLOUD_DIR). */
const SANDBOX_PEERS_DIR = '/home/user/.config/runpane-cloud';
const SANDBOX_PEERS_FILE = `${SANDBOX_PEERS_DIR}/peers.json`;
const INVOKE_TIMEOUT_MS = 30_000;
const PANE_CHAT_SESSION_ID = 'legacy-pane-chat';

interface PeersArgs {
  sub: 'allow' | 'revoke' | 'list';
  from?: string;
  to?: string;
  session?: string;
  json: boolean;
}

const USAGE = `Usage:
  runpane cloud peers allow <from-host> <to-host> [--session <Pane Session on to-host>] [--json]
      Let <from-host> message <to-host>'s orchestrator panel (panels submit, panels list, watch).
  runpane cloud peers revoke <from-host> <to-host> [--json]
  runpane cloud peers list [<host>] [--json]`;

export function parsePeersArgs(argv: readonly string[]): PeersArgs {
  const [sub, ...rest] = argv;
  if (sub !== 'allow' && sub !== 'revoke' && sub !== 'list') throw new Error(USAGE);
  const args: PeersArgs = { sub, json: false };
  const positionals: string[] = [];
  for (let index = 0; index < rest.length; index++) {
    const arg = rest[index];
    if (arg === '--json') args.json = true;
    else if (arg === '--session' && sub === 'allow') {
      const value = rest[++index];
      if (!value || value.startsWith('--')) throw new Error('--session requires a value.');
      args.session = value;
    } else if (arg.startsWith('-')) throw new Error(`Unknown option for runpane cloud peers ${sub}: ${arg}\n\n${USAGE}`);
    else positionals.push(arg);
  }
  const wanted = sub === 'list' ? [0, 1] : [2];
  if (!wanted.includes(positionals.length)) throw new Error(USAGE);
  [args.from, args.to] = positionals;
  return args;
}

export async function runPeersCommand(argv: readonly string[], deps: CloudDeps): Promise<number> {
  const args = parsePeersArgs(argv);
  const records = await deps.store.listHosts();
  if (args.sub === 'list') return list(args, records, deps);
  const from = findHost(records, args.from ?? '');
  const to = findHost(records, args.to ?? '');
  if (from.profile.cloud.hostname === to.profile.cloud.hostname) throw new Error('A cloud Session does not need a peer grant to reach itself.');
  return args.sub === 'allow' ? allow(args, from, to, deps) : revoke(args, from, to, deps);
}

async function allow(args: PeersArgs, from: CloudHostRecord, to: CloudHostRecord, deps: CloudDeps): Promise<number> {
  const target = to.profile.cloud.hostname;
  const existing = from.meta.peers?.find((grant) => grant.host === target);
  if (existing) {
    throw new Error(`${from.profile.cloud.hostname} may already message ${target} (peer ${existing.peerId}). Revoke it first to change the Session.`);
  }
  const session = await resolveTargetSession(to, args.session, deps);
  const minted = decodeBoundary(await invokeHost(to, 'runpane:peers:mint', [{ label: from.profile.label, sessions: [session.id] }], deps), mintResultSchema);
  const code = decodePairingCode(minted.connectionCode);
  const grant: PeerGrant = {
    host: target,
    peerId: minted.peer.id,
    targetSessionId: session.id,
    grantedAt: new Date(deps.now()).toISOString(),
    baseUrl: code.baseUrl,
    token: code.token,
  };
  from.meta.peers = [...(from.meta.peers ?? []), grant];
  await deps.store.writeHost(from);
  const pushed = await pushPeersFile(from, await deps.store.listHosts(), deps);
  report(args, deps, {
    ok: true,
    from: from.profile.cloud.hostname,
    to: target,
    peerId: grant.peerId,
    session: { id: session.id, name: session.name },
    peersFile: pushed,
  }, [
    `${from.profile.cloud.hostname} may now message ${target}'s Session "${session.name}" (orchestrator panel only; peer record ${grant.peerId}).`,
    pushed.written
      ? `  ${from.profile.cloud.hostname}'s peers list is updated: inside it, run \`runpane --host ${target} panels submit --panel orchestrator --text "..."\`.`
      : `  ${from.profile.cloud.hostname}'s peers list was not written (${pushed.reason}); it is written when you run runpane cloud wake ${from.profile.cloud.hostname}.`,
  ].join('\n'));
  return 0;
}

async function revoke(args: PeersArgs, from: CloudHostRecord, to: CloudHostRecord, deps: CloudDeps): Promise<number> {
  const target = to.profile.cloud.hostname;
  const grant = from.meta.peers?.find((candidate) => candidate.host === target);
  if (!grant) throw new Error(`${from.profile.cloud.hostname} has no grant to message ${target}. See runpane cloud peers list.`);
  // Revoking on the target is what matters: its daemon forgets the token, so a stale peers list is harmless.
  try {
    await invokeHost(to, 'runpane:peers:revoke', [{ peer: grant.peerId }], deps);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!/not found|unknown peer|no peer/iu.test(message)) {
      throw new Error(`Could not revoke peer ${grant.peerId} on ${target}: ${message}. ${target} must be awake: runpane cloud wake ${target}, then retry.`);
    }
  }
  from.meta.peers = (from.meta.peers ?? []).filter((candidate) => candidate !== grant);
  if (from.meta.peers.length === 0) delete from.meta.peers;
  await deps.store.writeHost(from);
  const pushed = await pushPeersFile(from, await deps.store.listHosts(), deps);
  report(args, deps, { ok: true, from: from.profile.cloud.hostname, to: target, revokedPeerId: grant.peerId, peersFile: pushed },
    `${from.profile.cloud.hostname} may no longer message ${target}: peer record ${grant.peerId} is deleted on ${target}${pushed.written ? ', and the peers list is updated' : ''}.`);
  return 0;
}

async function list(args: PeersArgs, records: CloudHostRecord[], deps: CloudDeps): Promise<number> {
  const host = args.from ? findHost(records, args.from).profile.cloud.hostname : undefined;
  const rows = records.flatMap((record) => (record.meta.peers ?? []).map((grant) => ({
    from: record.profile.cloud.hostname,
    to: grant.host,
    peerId: grant.peerId,
    targetSessionId: grant.targetSessionId,
    grantedAt: grant.grantedAt,
  }))).filter((row) => !host || row.from === host || row.to === host);
  if (args.json) {
    deps.stdout(JSON.stringify({ ok: true, grants: rows }, null, 2));
  } else if (rows.length === 0) {
    deps.stdout('No peer grants: no cloud Session may message another. Add one with runpane cloud peers allow <from> <to>.');
  } else {
    for (const row of rows) deps.stdout(`${row.from} -> ${row.to}  (peer ${row.peerId}, Session ${row.targetSessionId}, since ${row.grantedAt})`);
  }
  return 0;
}

// ---------------------------------------------------------------- the peers list inside a sandbox

type PeersFileResult = { host: string; written: true; peers: number } | { host: string; written: false; reason: string };

/**
 * Renders a Session's peers list: every grant it holds, plus the coordinator with this Session's own
 * caller token (so a submit to a sleeping peer can wake it). Tokens only ever travel in files.
 */
async function renderPeersFile(record: CloudHostRecord, records: readonly CloudHostRecord[], deps: Pick<CloudDeps, 'store'>): Promise<JsonObject> {
  const hosts: JsonObject[] = [];
  for (const grant of record.meta.peers ?? []) {
    const target = records.find((candidate) => candidate.profile.cloud.hostname === grant.host);
    if (!target) continue;
    hosts.push({
      id: target.profile.id,
      label: target.profile.label,
      baseUrl: target.profile.baseUrl || grant.baseUrl,
      token: grant.token,
      cloud: {
        provider: target.profile.cloud.provider,
        sandboxId: target.profile.cloud.sandboxId,
        sessionId: target.profile.cloud.sessionId,
        hostname: target.profile.cloud.hostname,
      },
    });
  }
  const file: JsonObject = { v: 1, hosts };
  const deployment = (await deps.store.readSettings()).coordinator?.deployment;
  const secret = deployment ? await deps.store.readSecretText('coordinator-secret') : undefined;
  if (deployment && secret) {
    file.coordinator = { baseUrl: deployment.baseUrl, token: mintCallerToken(secret, record.profile.cloud.sessionId) };
  }
  return file;
}

/** Writes a Session's peers list into its sandbox (0600). Needs the sandbox running; never throws. */
export async function pushPeersFile(
  record: CloudHostRecord,
  records: readonly CloudHostRecord[],
  deps: CloudDeps,
  givenProvider?: CloudProvider,
): Promise<PeersFileResult> {
  const host = record.profile.cloud.hostname;
  try {
    const provider = givenProvider ?? await hostProvider(deps, await deps.store.readCredentials(), record);
    const sandbox = await provider.get(record.profile.cloud.sandboxId);
    if (sandbox.state !== 'running') return { host, written: false, reason: `sandbox is ${sandbox.providerState}` };
    const file = await renderPeersFile(record, records, deps);
    const handle = provider.handle(record.profile.cloud.sandboxId);
    const staged = `/home/user/.runpane-cloud/peers.json.${Date.now().toString(36)}`;
    await handle.writeFile(staged, `${JSON.stringify(file, null, 2)}\n`);
    const result = await handle.runScript(
      `set -e; umask 077; mkdir -p ${SANDBOX_PEERS_DIR}; chmod 700 ${SANDBOX_PEERS_DIR}; install -m 600 ${staged} ${SANDBOX_PEERS_FILE}; rm -f ${staged}`,
      { timeoutSeconds: 60 },
    );
    if (result.exitCode !== 0) return { host, written: false, reason: `install exited ${String(result.exitCode)}` };
    return { host, written: true, peers: Array.isArray(file.hosts) ? file.hosts.length : 0 };
  } catch (error) {
    return { host, written: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

/** Rewrites the peers list of every running Session (after a coordinator deploy changes its address). */
export async function refreshPeersFiles(records: readonly CloudHostRecord[], deps: CloudDeps): Promise<PeersFileResult[]> {
  const results: PeersFileResult[] = [];
  for (const record of records) {
    if (!record.profile.baseUrl) continue;
    results.push(await pushPeersFile(record, records, deps));
  }
  return results;
}

// ---------------------------------------------------------------- the target daemon

const mintResultSchema = boundary.object({
  peer: boundary.object({ id: boundary.nonEmptyString }),
  connectionCode: boundary.nonEmptyString,
});

const sessionsSchema = boundary.object({
  sessions: boundary.array(boundary.object({
    id: boundary.nonEmptyString,
    name: boundary.string,
    archived: boundary.optional(boundary.boolean),
  })),
});

async function resolveTargetSession(to: CloudHostRecord, selector: string | undefined, deps: CloudDeps): Promise<{ id: string; name: string }> {
  const { sessions } = decodeBoundary(await invokeHost(to, 'runpane:sessions:list', [], deps), sessionsSchema);
  const all = sessions.filter((session) => session.archived !== true);
  // Every daemon has the built-in Pane Chat Session; prefer the Sessions the user created.
  const named = all.filter((session) => session.id !== PANE_CHAT_SESSION_ID);
  const live = selector ? all : named.length > 0 ? named : all;
  const host = to.profile.cloud.hostname;
  if (selector) {
    const match = live.find((session) => session.id === selector || session.name === selector);
    if (!match) throw new Error(`${host} has no Session "${selector}". Its Sessions: ${live.map((session) => session.name).join(', ') || 'none'}.`);
    return match;
  }
  if (live.length === 1) return live[0];
  if (live.length === 0) {
    throw new Error(`${host} has no Pane Session yet, so there is nothing to allow. Create one (in Pane desktop, or runpane --host ${host} sessions create ...), then retry.`);
  }
  throw new Error(`${host} has ${live.length} Sessions; name one with --session <name>: ${live.map((session) => session.name).join(', ')}.`);
}

async function invokeHost(record: CloudHostRecord, channel: string, args: JsonObject[], deps: CloudDeps) {
  const host = record.profile.cloud.hostname;
  if (!record.profile.baseUrl || !record.profile.token) throw new Error(`${host} has no daemon address yet; its setup never finished.`);
  try {
    return await deps.invokeDaemon(record.profile, channel, args, INVOKE_TIMEOUT_MS);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${host}: ${message}${/connect|ECONN|ETIMEDOUT|ENOTFOUND|timed out/iu.test(message) ? ` (is it asleep? run runpane cloud wake ${host})` : ''}`);
  }
}

function report(args: PeersArgs, deps: CloudDeps, json: JsonObject, text: string): void {
  deps.stdout(args.json ? JSON.stringify(json, null, 2) : text);
}
