import type http from 'http';
import https from 'https';
import type { LookupFunction } from 'net';
import { isIP } from 'net';
import { boundary, decodeOptionalBoundary, type JsonValue } from '../../../shared/validation/boundaryDecoder';
import type { RemotePaneConnectionProfile } from '../../../shared/types/remoteDaemon';
import { decodeComputerRoutesReport } from '../../../shared/types/remoteComputers';
import type {
  TailnetMachine,
  TailnetMachineList,
  TailnetMachineState,
  WorkspaceMachineDescription,
} from '../../../shared/types/workspaceAccess';
import { runRemoteSetupCommand } from '../daemon/remote-setup-command';
import { resolveTailscaleCommandAsync } from '../daemon/tailscaleSetup';
import { WORKSPACE_HTTPS_PORT } from '../daemon/workspacePort';

/** Tailnet port where each machine's Pane serves codeless connections (the Workspaces listener). */
const PROBE_TIMEOUT_MS = 4_000;
const MAX_PROBE_RESPONSE_BYTES = 64 * 1024;
const PROBE_CONCURRENCY = 8;
/** Probing reaches other people's machines too; cap it on large tailnets. */
const MAX_PROBED_MACHINES = 64;

/** A machine worth probing: online, untagged, a desktop OS, in this tailnet. */
export interface TailnetCandidate {
  name: string;
  dnsName: string;
  ip: string;
}

export type WorkspaceProbeResult =
  | { kind: 'described'; description: WorkspaceMachineDescription }
  | { kind: 'password-required' }
  /** Visibility keeps this client out. */
  | { kind: 'refused' }
  /** Pane answers but predates `runpane:workspaces:describe`. */
  | { kind: 'outdated' }
  | { kind: 'unreachable'; detail?: string };

export type WorkspaceProbe = (machine: TailnetCandidate, secret?: string) => Promise<WorkspaceProbeResult>;

/** One command's answer from another machine's Workspaces listener, called as this machine's login. */
export type WorkspaceCallResult =
  | { kind: 'answered'; statusCode: number; ok: true; result: JsonValue | undefined }
  | { kind: 'answered'; statusCode: number; ok: false; code?: string; message?: string }
  | { kind: 'unreachable'; detail: string };

/** A longer call than a probe: a Session move sends 8 MiB chunks and waits for setup on the other machine. */
interface WorkspaceCallOptions {
  timeoutMs?: number;
  maxResponseBytes?: number;
}

export type WorkspaceCall = (machine: TailnetCandidate, channel: string, args: JsonValue[], secret?: string, options?: WorkspaceCallOptions) => Promise<WorkspaceCallResult>;

interface DiscoveryDependencies {
  /** `tailscale status --json`, or null when Tailscale is not installed. */
  readStatus: () => Promise<string | null>;
  probe: WorkspaceProbe;
  /** Saved passwords, keyed by `savedSecretKey`, so one is sent only on the tailnet it was saved for. */
  savedSecrets?: ReadonlyMap<string, string>;
  /** List this machine first, as described by its own listener (for a phone asking a host). */
  self?: { url: string; description: WorkspaceMachineDescription };
  /**
   * Also list other people's machines that keep this login out, as `refused`, so the app can say
   * why. Off for phones, whose installed app may not know that state.
   */
  includeRefused?: boolean;
}

const OS_NAMES = new Map<string, TailnetMachine['os']>([['macos', 'macOS'], ['windows', 'Windows'], ['linux', 'Linux']]);
const STATE_ORDER: TailnetMachineState[] = ['available', 'password-required', 'outdated', 'refused', 'unreachable', 'offline'];

const peerSchema = boundary.object({
  DNSName: boundary.string,
  UserID: boundary.number,
  OS: boundary.string,
  Online: boundary.optional(boundary.boolean),
  TailscaleIPs: boundary.optional(boundary.nullable(boundary.array(boundary.string))),
  Tags: boundary.optional(boundary.nullable(boundary.array(boundary.string))),
  ShareeNode: boundary.optional(boundary.boolean),
});
const statusSchema = boundary.object({
  BackendState: boundary.string,
  MagicDNSSuffix: boundary.optional(boundary.string),
  CurrentTailnet: boundary.optional(boundary.nullable(boundary.object({ Name: boundary.string }))),
  Self: boundary.optional(boundary.nullable(peerSchema)),
  Peer: boundary.optional(boundary.nullable(boundary.jsonObject)),
  User: boundary.optional(boundary.nullable(boundary.jsonObject)),
});
const userSchema = boundary.object({ LoginName: boundary.string });

interface TailnetPeer {
  name: string;
  dnsName: string;
  os: TailnetMachine['os'];
  ownerLogin: string;
  mine: boolean;
  online: boolean;
  ip: string | undefined;
}

type TailnetPeers =
  | { ok: true; tailnet: string; domain: string; self: Omit<TailnetPeer, 'ip' | 'online'> | null; peers: TailnetPeer[] }
  | { ok: false; reason: string; fix: string };

/** Desktop machines of people in the current tailnet; no tagged devices, phones, or sharee nodes. */
function readTailnetPeers(output: string | null): TailnetPeers {
  if (output === null) {
    return { ok: false, reason: 'Tailscale is not installed', fix: 'Install Tailscale from https://tailscale.com/download and sign in.' };
  }
  let status: ReturnType<typeof statusSchema.decode> | undefined;
  try {
    status = decodeOptionalBoundary(JSON.parse(output), statusSchema);
  } catch {
    status = undefined;
  }
  if (!status) return { ok: false, reason: 'Tailscale status could not be read', fix: 'Update Tailscale, then try again.' };
  const self = status.Self;
  if (status.BackendState !== 'Running' || !self) {
    return { ok: false, reason: 'Tailscale is signed out', fix: 'Open Tailscale and sign in.' };
  }

  const suffix = `.${(status.MagicDNSSuffix ?? trimDot(self.DNSName).split('.').slice(1).join('.')).toLowerCase()}`;
  const users = status.User;
  const peers = Object.values(status.Peer ?? {}).flatMap((value): TailnetPeer[] => {
    const peer = decodeOptionalBoundary(value, peerSchema);
    const os = peer ? OS_NAMES.get(peer.OS.toLowerCase()) : undefined;
    // Sharee nodes belong to people outside this tailnet whom a device was shared with.
    if (!peer || !os || peer.Tags?.length || peer.ShareeNode) return [];
    const dnsName = trimDot(peer.DNSName);
    if (!dnsName.toLowerCase().endsWith(suffix)) return [];
    return [{
      name: dnsName.split('.')[0],
      dnsName,
      os,
      ownerLogin: decodeOptionalBoundary(users?.[String(peer.UserID)], userSchema)?.LoginName ?? `user ${peer.UserID}`,
      mine: peer.UserID === self.UserID,
      online: peer.Online === true,
      ip: (peer.TailscaleIPs ?? []).find((address) => isIP(address) === 4) ?? peer.TailscaleIPs?.[0],
    }];
  });
  const selfOs = OS_NAMES.get(self.OS.toLowerCase());
  const selfDnsName = trimDot(self.DNSName);
  return {
    ok: true,
    tailnet: status.CurrentTailnet?.Name ?? suffix.slice(1),
    domain: suffix.slice(1),
    self: selfOs ? {
      name: selfDnsName.split('.')[0],
      dnsName: selfDnsName,
      os: selfOs,
      ownerLogin: decodeOptionalBoundary(users?.[String(self.UserID)], userSchema)?.LoginName ?? `user ${self.UserID}`,
      mine: true,
    } : null,
    peers,
  };
}

/**
 * The machines this one can connect to without a code, from the current tailnet: every desktop
 * machine on my own Tailscale login, and other people's machines only when they let me in (or,
 * with `includeRefused`, marked `refused` when they don't).
 */
export async function discoverTailnetMachines({ readStatus, probe, savedSecrets, self, includeRefused = false }: DiscoveryDependencies): Promise<TailnetMachineList> {
  const tailnet = readTailnetPeers(await readStatus());
  if (!tailnet.ok) return tailnet;
  const { peers, domain } = tailnet;

  // My machines first, so a large tailnet never pushes them past the cap.
  const probed = [...peers.filter((peer) => peer.mine), ...peers.filter((peer) => !peer.mine)]
    .filter((peer) => peer.online && peer.ip)
    .slice(0, MAX_PROBED_MACHINES);
  const results = new Map<string, WorkspaceProbeResult>();
  await forEachLimited(probed, PROBE_CONCURRENCY, async ({ name, dnsName, ip }) => {
    if (!ip) return;
    results.set(dnsName, await probe({ name, dnsName, ip }, savedSecrets?.get(savedSecretKey(domain, name))));
  });

  const machines = peers.flatMap(({ name, dnsName, os, ownerLogin, mine: isMine, online }): TailnetMachine[] => {
    const base = { name, dnsName, url: workspaceBaseUrl(dnsName), os, ownerLogin, mine: isMine };
    if (isMine && !online) return [{ ...base, state: 'offline' }];
    const result = results.get(dnsName);
    if (!result) return isMine ? [{ ...base, state: 'unreachable' }] : [];
    switch (result.kind) {
      case 'described': {
        const available: TailnetMachine = { ...base, state: 'available', visibility: result.description.visibility, paneVersion: result.description.paneVersion };
        if (result.description.machineId) available.machineId = result.description.machineId;
        return [available];
      }
      case 'password-required':
        return [{ ...base, state: 'password-required' }];
      case 'outdated':
        // An older Pane accepts only its owner's login.
        if (isMine) return [{ ...base, state: 'outdated' }];
        return includeRefused ? [{ ...base, state: 'refused' }] : [];
      case 'refused':
        return includeRefused ? [{ ...base, state: 'refused' }] : [];
      default:
        // Someone else's machine with no Pane listening stays hidden.
        return isMine ? [{ ...base, state: 'unreachable' }] : [];
    }
  });
  machines.sort((left, right) =>
    Number(right.mine) - Number(left.mine)
    || STATE_ORDER.indexOf(left.state) - STATE_ORDER.indexOf(right.state)
    || left.name.localeCompare(right.name));

  if (self && tailnet.self) {
    machines.unshift({
      ...tailnet.self,
      url: self.url,
      state: 'available',
      visibility: self.description.visibility,
      paneVersion: self.description.paneVersion,
    });
  }
  return { ok: true, tailnet: tailnet.tailnet, domain, machines };
}

/** Machine names are unique only within a tailnet, so a saved password is keyed by both. */
export function savedSecretKey(domain: string, name: string): string {
  return `${domain.toLowerCase()}/${name.toLowerCase()}`;
}

/** The passwords saved with this machine's codeless connections, keyed by `savedSecretKey`. */
export function savedWorkspaceSecrets(profiles: readonly RemotePaneConnectionProfile[]): Map<string, string> {
  return new Map(profiles.flatMap((profile): [string, string][] => (profile.tailnetMachine && profile.tailnetDomain && profile.token
    ? [[savedSecretKey(profile.tailnetDomain, profile.tailnetMachine), profile.token]]
    : [])));
}

/**
 * The address of a saved machine, looked up at each connect. A profile belongs to the tailnet it
 * was saved on: after a switch, a machine with the same name is a different machine, so it is
 * never connected to (or sent the saved password) in its place.
 */
export async function resolveTailnetMachineUrl(
  machine: { name: string; domain: string },
  readStatus: () => Promise<string | null>,
): Promise<string> {
  const tailnet = readTailnetPeers(await readStatus());
  if (!tailnet.ok) throw new Error(`${tailnet.reason}. ${tailnet.fix}`);
  if (tailnet.domain.toLowerCase() !== machine.domain.toLowerCase()) {
    throw new Error(`${machine.name} was saved on another tailnet (${machine.domain}). This computer is now on ${tailnet.tailnet}; connect again from Settings › Remote Access › Computers.`);
  }
  return findMachineUrl(tailnet, machine.name);
}

export type TailnetMachineLookup =
  | { kind: 'tailscale-missing'; reason: string }
  | { kind: 'tailscale-down'; reason: string; fix: string }
  | { kind: 'not-found'; reason: string }
  | { kind: 'found'; peer: { dnsName: string; ip: string | undefined; online: boolean; os: TailnetMachine['os'] } };

/** Where a saved machine stands on this computer's tailnet, for the connection checklist. */
export async function lookupTailnetMachine(
  machine: { name: string; domain: string },
  readStatus: () => Promise<string | null>,
): Promise<TailnetMachineLookup> {
  const output = await readStatus();
  const tailnet = readTailnetPeers(output);
  if (!tailnet.ok) {
    return output === null
      ? { kind: 'tailscale-missing', reason: tailnet.reason }
      : { kind: 'tailscale-down', reason: tailnet.reason, fix: tailnet.fix };
  }
  if (tailnet.domain.toLowerCase() !== machine.domain.toLowerCase()) {
    return { kind: 'not-found', reason: `${machine.name} was saved on another tailnet (${machine.domain}). This computer is now on ${tailnet.tailnet}; connect again from Settings › Remote Access › Computers.` };
  }
  const peer = tailnet.peers.find((candidate) => candidate.name.toLowerCase() === machine.name.toLowerCase());
  if (!peer) return { kind: 'not-found', reason: `${machine.name} is not on your current tailnet (${tailnet.tailnet}).` };
  return { kind: 'found', peer: { dnsName: peer.dnsName, ip: peer.ip, online: peer.online, os: peer.os } };
}

/**
 * Whether a saved machine's Tailscale owner is this computer's own Tailscale login (D-500), as this
 * computer's Tailscale reports it. False when the machine is on another tailnet, missing from this
 * one, or owned by another login (tagged devices have no owner login, so they are never listed);
 * undefined when Tailscale here can't say (not installed, signed out, or unreadable), so a mark
 * made earlier is kept rather than cleared.
 */
export async function tailnetLoginMatches(
  machine: { name: string; domain: string },
  readStatus: () => Promise<string | null>,
): Promise<boolean | undefined> {
  const tailnet = readTailnetPeers(await readStatus());
  if (!tailnet.ok) return undefined;
  if (tailnet.domain.toLowerCase() !== machine.domain.toLowerCase()) return false;
  return tailnet.peers.find((candidate) => candidate.name.toLowerCase() === machine.name.toLowerCase())?.mine ?? false;
}

/**
 * The relay key a machine on this computer's tailnet holds, read over Tailscale (D-500 side check).
 * Dials the name through this computer's Tailscale, as a Tailscale route does, so TLS checks that
 * name, and reads `computers:routes-report` with this machine's login. Null when it has no relay
 * key; undefined when it can't be reached, isn't on the tailnet it was saved on, or doesn't answer.
 */
export async function tailnetRelayKey(
  machine: { name: string; domain: string },
  secret: string,
  readStatus: () => Promise<string | null>,
  call: WorkspaceCall = callWorkspace,
): Promise<{ computerId: string; fingerprint: string } | null | undefined> {
  let located: Awaited<ReturnType<typeof locateTailnetCandidate>>;
  try {
    located = await locateTailnetCandidate(machine.name, readStatus);
  } catch {
    return undefined;
  }
  if (located.domain.toLowerCase() !== machine.domain.toLowerCase()) return undefined;
  const answer = await call(located.candidate, 'computers:routes-report', [], secret || undefined, { timeoutMs: 5_000 });
  if (answer.kind !== 'answered' || !answer.ok) return undefined;
  // A Pane without an install id yet reports nothing; one with relay off reports no relay.
  if (answer.result === null) return null;
  const decoded = decodeComputerRoutesReport(answer.result);
  if (!decoded) return undefined;
  return decoded.relay ? { computerId: decoded.relay.id, fingerprint: decoded.relay.fingerprint } : null;
}

/** A machine by name on the current tailnet, as a candidate to call, with whether it is on this machine's own login. */
export async function locateTailnetCandidate(name: string, readStatus: () => Promise<string | null>): Promise<{ candidate: TailnetCandidate; domain: string; mine: boolean; online: boolean }> {
  const tailnet = readTailnetPeers(await readStatus());
  if (!tailnet.ok) throw new Error(`${tailnet.reason}. ${tailnet.fix}`);
  const peer = tailnet.peers.find((candidate) => candidate.name.toLowerCase() === name.toLowerCase());
  if (!peer) throw new Error(`${name} is not on your current tailnet (${tailnet.tailnet}).`);
  if (!peer.ip) throw new Error(`${name} has no Tailscale address right now.`);
  return { candidate: { name: peer.name, dnsName: peer.dnsName, ip: peer.ip }, domain: tailnet.domain, mine: peer.mine, online: peer.online };
}

/** The address of a machine by name on the current tailnet, and that tailnet's domain. */
export async function locateTailnetMachine(name: string, readStatus: () => Promise<string | null>): Promise<{ url: string; domain: string }> {
  const tailnet = readTailnetPeers(await readStatus());
  if (!tailnet.ok) throw new Error(`${tailnet.reason}. ${tailnet.fix}`);
  return { url: findMachineUrl(tailnet, name), domain: tailnet.domain };
}

function findMachineUrl(tailnet: Extract<TailnetPeers, { ok: true }>, name: string): string {
  const machine = tailnet.peers.find((peer) => peer.name.toLowerCase() === name.toLowerCase());
  if (!machine) throw new Error(`${name} is not on your current tailnet (${tailnet.tailnet}).`);
  return workspaceBaseUrl(machine.dnsName);
}

function workspaceBaseUrl(dnsName: string): string {
  return `https://${dnsName}:${WORKSPACE_HTTPS_PORT}`;
}

/** Runs `tailscale status --json` with the same CLI lookup the Workspaces host uses. */
export async function readTailscaleStatus(): Promise<string | null> {
  const tailscale = await resolveTailscaleCommandAsync(runRemoteSetupCommand);
  if (!tailscale) return null;
  const result = await runRemoteSetupCommand(tailscale.command, ['status', '--json'], { env: tailscale.env, timeoutMs: 5_000 });
  return result.stdout || null;
}

const probeResponseSchema = boundary.object({
  ok: boundary.boolean,
  result: boundary.optional(boundary.json),
  error: boundary.optional(boundary.object({ code: boundary.optional(boundary.string), message: boundary.optional(boundary.string) })),
});
const descriptionSchema = boundary.object({
  machineName: boundary.string,
  visibility: boundary.enumeration('owner', 'tailnet'),
  passwordProtected: boundary.boolean,
  paneVersion: boundary.string,
  machineId: boundary.optional(boundary.string),
});

/**
 * Runs one command on another machine's Workspaces listener. Connects to the Tailscale IP
 * directly, so it works where the system resolver does not know MagicDNS, while TLS still checks
 * the name. Serve on that machine signs the request with this machine's Tailscale login.
 */
export const callWorkspace: WorkspaceCall = (machine, channel, args, secret, options = {}) => new Promise((resolve) => {
  const maxResponseBytes = options.maxResponseBytes ?? MAX_PROBE_RESPONSE_BYTES;
  let settled = false;
  const finish = (result: WorkspaceCallResult) => {
    if (settled) return;
    settled = true;
    clearTimeout(deadline);
    resolve(result);
  };
  const lookup: LookupFunction = (_hostname, options, callback) => {
    const family = isIP(machine.ip);
    if (options.all) callback(null, [{ address: machine.ip, family }]);
    else callback(null, machine.ip, family);
  };
  const body = JSON.stringify({ channel, args });
  const request = https.request({
    host: machine.dnsName,
    servername: machine.dnsName,
    port: WORKSPACE_HTTPS_PORT,
    path: '/invoke',
    method: 'POST',
    lookup,
    headers: probeHeaders(body, secret),
  }, (response) => {
    const chunks: Buffer[] = [];
    let size = 0;
    response.on('data', (chunk: Buffer) => {
      size += chunk.length;
      // A describe or glasses answer is a few kilobytes; anything this large is not Pane.
      if (size > maxResponseBytes) {
        request.destroy();
        finish({ kind: 'unreachable', detail: 'response too large' });
        return;
      }
      chunks.push(chunk);
    });
    response.on('end', () => finish(readCallResponse(response.statusCode ?? 0, Buffer.concat(chunks).toString('utf8'))));
    response.on('error', (error) => finish({ kind: 'unreachable', detail: error.message }));
  });
  // An absolute deadline: a socket timeout alone would let a peer that trickles bytes hang the caller.
  const deadline = setTimeout(() => {
    request.destroy();
    finish({ kind: 'unreachable', detail: 'timed out' });
  }, options.timeoutMs ?? PROBE_TIMEOUT_MS);
  request.on('error', (error) => finish({ kind: 'unreachable', detail: error.message }));
  request.end(body);
});

/** Asks a machine's Workspaces listener to describe itself. */
export const probeWorkspace: WorkspaceProbe = async (machine, secret) =>
  readProbeAnswer(await callWorkspace(machine, 'runpane:workspaces:describe', [], secret));

function probeHeaders(body: string, secret: string | undefined): http.OutgoingHttpHeaders {
  const headers: http.OutgoingHttpHeaders = {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
  };
  if (secret) headers.Authorization = `Bearer ${secret}`;
  return headers;
}

function readCallResponse(statusCode: number, text: string): WorkspaceCallResult {
  let parsed: ReturnType<typeof probeResponseSchema.decode> | undefined;
  try {
    parsed = decodeOptionalBoundary(JSON.parse(text), probeResponseSchema);
  } catch {
    parsed = undefined;
  }
  if (statusCode === 200 && parsed?.ok) return { kind: 'answered', statusCode, ok: true, result: parsed.result };
  return { kind: 'answered', statusCode, ok: false, code: parsed?.error?.code, message: parsed?.error?.message };
}

function readProbeAnswer(answer: WorkspaceCallResult): WorkspaceProbeResult {
  if (answer.kind === 'unreachable') return answer;
  if (answer.ok) {
    const description = decodeOptionalBoundary(answer.result, descriptionSchema);
    return description ? { kind: 'described', description } : { kind: 'outdated' };
  }
  const { statusCode, code } = answer;
  // 429: too many wrong passwords from this login; it still needs the right one.
  if (statusCode === 401 || statusCode === 429) return { kind: 'password-required' };
  if (statusCode === 403 && code?.startsWith('ERR_WORKSPACE_IDENTITY')) return { kind: 'refused' };
  if (statusCode === 404 && code === 'ERR_UNKNOWN_CHANNEL') return { kind: 'outdated' };
  return { kind: 'unreachable', detail: answer.message ?? `HTTP ${statusCode}` };
}

function trimDot(name: string): string {
  return name.replace(/\.$/, '');
}

async function forEachLimited<Item>(items: readonly Item[], limit: number, work: (item: Item) => Promise<void>): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const item = items[next++];
      await work(item);
    }
  });
  await Promise.all(workers);
}
