import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { boundary, decodeBoundary } from './boundaryDecoder';
import type { BoundarySchema, JsonValue } from './boundaryDecoder';
import type { ParsedArgs } from './commands';
import { answeringRoute, invokeDaemon, invokeRemoteDaemon, PaneDaemonClientError, routeLabel, type RemoteDaemonTarget, type RemoteRoute } from './daemonClient';
import { RunpaneError } from './errors';

/**
 * Tailnet port where each joined machine's Pane serves workspaces. Pane reads PANE_WORKSPACES_PORT
 * to serve somewhere else (a development build beside an installed Pane), and so does runpane.
 */
function workspaceHttpsPort(): number {
  const port = Number(process.env.PANE_WORKSPACES_PORT);
  return Number.isInteger(port) && port > 0 && port < 65536 ? port : 8443;
}
const TAILSCALE_TIMEOUT_MS = 3_000;
const PROBE_TIMEOUT_MS = 4_000;
const LOCAL_STATUS_TIMEOUT_MS = 1_500;
const REACH_LINE = 'Reach them: runpane workspace <machine> read|write|exec|<command>';
/** Listing probes other people's machines too; cap it on large tailnets, as the desktop app does. */
const MAX_PROBED_MACHINES = 64;

type MachineOs = 'macOS' | 'Windows' | 'Linux';

export interface TailnetMachine {
  name: string;
  dnsName: string;
  /** `unknown` for a saved computer that has not said and does not answer now. */
  os: MachineOs | 'unknown';
  online: boolean;
  ips: string[];
  self: boolean;
  /** Tailscale login of the machine's owner. */
  owner: string;
  /** Signed in to this machine's own login. Other people's machines let in only who their visibility allows. */
  mine: boolean;
  /** A computer saved in Pane: its routes in the order they are tried. A Tailscale machine Pane has not saved has none. */
  routes?: RemoteRoute[];
  /** Other names it answers to, lowercased: its Pane id, install id, relay id, and route host names. */
  aliases?: string[];
  /** Why a saved computer did not answer when runpane asked it. */
  unreachable?: string;
  /** Set on the one "Pane Cloud" machine: its cloud Sessions, each on its own VM (D-90). */
  cloudSessions?: CloudSession[];
}

/** One cloud Session of the "Pane Cloud" machine, and the saved computer its VM is. */
interface CloudSession {
  name: string;
  awake: boolean;
  machine: TailnetMachine;
}

/** What all of a person's cloud VMs are called together, as desktop Pane names them (shared/utils/paneCloudMachine.ts). */
const PANE_CLOUD_NAME = 'Pane Cloud';
/** The daemon command answering desktop Pane's "Pane Cloud" machine, or null; this package cannot import shared/. */
const PANE_CLOUD_MACHINE_CHANNEL = 'pane-cloud:machine';
const paneCloudMachineSchema = boundary.nullable(boundary.object({
  members: boundary.array(boundary.object({
    computerId: boundary.nonEmptyString,
    sessionName: boundary.string,
    awake: boundary.boolean,
  })),
}));

export type Tailnet =
  /** `httpsCertificates` is the tailnet-wide setting that workspaces need on every machine. */
  | { ok: true; self: TailnetMachine; machines: TailnetMachine[]; httpsCertificates: boolean }
  | { ok: false; reason: string; fix: string };

const peerSchema = boundary.object({
  DNSName: boundary.string,
  OS: boundary.string,
  UserID: boundary.number,
  Online: boundary.optional(boundary.boolean),
  TailscaleIPs: boundary.optional(boundary.nullable(boundary.array(boundary.string))),
  Tags: boundary.optional(boundary.nullable(boundary.array(boundary.string))),
  ShareeNode: boundary.optional(boundary.boolean),
});
const statusSchema = boundary.object({
  BackendState: boundary.string,
  MagicDNSSuffix: boundary.optional(boundary.string),
  Self: boundary.optional(boundary.nullable(peerSchema)),
  Peer: boundary.optional(boundary.nullable(boundary.jsonObject)),
  User: boundary.optional(boundary.nullable(boundary.jsonObject)),
  CertDomains: boundary.optional(boundary.nullable(boundary.array(boundary.string))),
});
const userSchema = boundary.object({ LoginName: boundary.string });

const machineInfoSchema = boundary.object({
  hostname: boundary.string,
  os: boundary.enumeration('macOS', 'Windows', 'Linux'),
  isWsl: boundary.boolean,
  shell: boundary.string,
  homeDir: boundary.string,
  wslDistros: boundary.array(boundary.string),
});
type MachineInfo = ReturnType<typeof machineInfoSchema.decode>;
const readResultSchema = boundary.object({
  path: boundary.string,
  encoding: boundary.enumeration('utf8', 'base64'),
  content: boundary.string,
  bytes: boundary.number,
});
const writeResultSchema = boundary.object({ path: boundary.string, bytes: boundary.number });
const execResultSchema = boundary.object({
  os: boundary.enumeration('macOS', 'Windows', 'Linux'),
  shell: boundary.string,
  cwd: boundary.string,
  exitCode: boundary.nullable(boundary.number),
  signal: boundary.nullable(boundary.string),
  timedOut: boundary.boolean,
  stillRunning: boundary.optional(boundary.literal(true)),
  stdout: boundary.string,
  stderr: boundary.string,
});
const localStatusSchema = boundary.object({
  enabled: boundary.boolean,
  state: boundary.enumeration('on', 'off'),
  reason: boundary.optional(boundary.string),
  fix: boundary.optional(boundary.string),
  machineName: boundary.optional(boundary.string),
  url: boundary.optional(boundary.string),
});

/** This machine's phone access through Pane relay (`relay:status`): linked computers reach it the same way. */
const relayStatusSchema = boundary.object({
  enabled: boundary.boolean,
  phase: boundary.string,
  address: boundary.nullable(boundary.string),
  lastError: boundary.nullable(boundary.string),
  /** Absent from a Pane before it; set while the CA's certificate limit keeps new devices off the relay. */
  certificateLimit: boundary.optional(boundary.nullable(boundary.object({ until: boundary.string }))),
});

// ---------------------------------------------------------------- tailnet

/**
 * This machine and the other Mac, Windows, and Linux machines in its tailnet, from `tailscale status --json`:
 * the ones the desktop app's device switcher offers. Each machine decides who it lets in.
 */
export async function readTailnet(): Promise<Tailnet> {
  const output = await runTailscale(['status', '--json']);
  if (output === null) {
    return { ok: false, reason: 'Tailscale is not installed', fix: 'Install Tailscale from https://tailscale.com/download and sign in.' };
  }
  let status: ReturnType<typeof statusSchema.decode>;
  try {
    status = decodeBoundary(JSON.parse(output), statusSchema);
  } catch {
    return { ok: false, reason: 'Tailscale status could not be read', fix: 'Update Tailscale.' };
  }
  if (status.BackendState !== 'Running' || !status.Self) {
    return { ok: false, reason: 'Tailscale is signed out', fix: 'Open Tailscale and sign in.' };
  }
  const ownerId = status.Self.UserID;
  const users = status.User;
  const ownerOf = (peer: ReturnType<typeof peerSchema.decode>) => {
    const user = users?.[String(peer.UserID)];
    try {
      if (user !== undefined) return decodeBoundary(user, userSchema).LoginName;
    } catch {
      // Falls through to the numeric ID.
    }
    return `user ${peer.UserID}`;
  };
  const self = toMachine(status.Self, true, ownerOf(status.Self), true);
  const suffix = `.${(status.MagicDNSSuffix ?? status.Self.DNSName.replace(/\.$/, '').split('.').slice(1).join('.')).toLowerCase()}`;
  const machines = Object.values(status.Peer ?? {})
    .map(decodePeer)
    // Sharee nodes belong to people outside this tailnet whom a device was shared with.
    .filter((peer): peer is NonNullable<typeof peer> => Boolean(peer && !peer.Tags?.length && !peer.ShareeNode
      && peer.DNSName.replace(/\.$/, '').toLowerCase().endsWith(suffix)))
    .map((peer) => toMachine(peer, false, ownerOf(peer), peer.UserID === ownerId))
    .filter((machine): machine is TailnetMachine => machine !== null)
    .sort((left, right) => Number(right.mine) - Number(left.mine) || Number(right.online) - Number(left.online)
      || left.name.localeCompare(right.name));
  if (!self) return { ok: false, reason: `Tailscale reports an unsupported OS (${status.Self.OS})`, fix: 'Run Pane on macOS, Windows, or Linux.' };
  return { ok: true, self, machines, httpsCertificates: Boolean(status.CertDomains?.length) };
}

const TAILSCALE_OS_NAMES = new Map<string, MachineOs>([['macos', 'macOS'], ['windows', 'Windows'], ['linux', 'Linux']]);

function decodePeer(value: JsonValue): ReturnType<typeof peerSchema.decode> | null {
  try {
    return decodeBoundary(value, peerSchema);
  } catch {
    return null;
  }
}

function toMachine(peer: ReturnType<typeof peerSchema.decode>, self: boolean, owner: string, mine: boolean): TailnetMachine | null {
  const osName = TAILSCALE_OS_NAMES.get(peer.OS.toLowerCase());
  if (!osName) return null;
  const dnsName = peer.DNSName.replace(/\.$/, '');
  return { name: dnsName.split('.')[0], dnsName, os: osName, online: self || peer.Online === true, ips: peer.TailscaleIPs ?? [], self, owner, mine };
}

function runTailscale(args: string[]): Promise<string | null> {
  const candidates: Array<{ command: string; env?: NodeJS.ProcessEnv }> = [{ command: 'tailscale' }];
  if (process.platform === 'darwin') {
    for (const app of ['/Applications/Tailscale.app', path.join(os.homedir(), 'Applications', 'Tailscale.app')]) {
      candidates.push({ command: path.join(app, 'Contents', 'MacOS', 'Tailscale'), env: { ...process.env, TAILSCALE_BE_CLI: '1' } });
    }
  }
  if (process.platform === 'win32') {
    for (const directory of [process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.LOCALAPPDATA]) {
      if (directory) candidates.push({ command: path.join(directory, 'Tailscale', 'tailscale.exe') });
    }
  }
  // Inside WSL, Tailscale runs on Windows; its CLI is on PATH through interop.
  if (process.platform === 'linux' && process.env.WSL_DISTRO_NAME) candidates.push({ command: 'tailscale.exe' });
  return candidates.reduce<Promise<string | null>>(async (found, candidate) => (await found) ?? new Promise((resolve) => {
    execFile(candidate.command, args, { encoding: 'utf8', timeout: TAILSCALE_TIMEOUT_MS, env: candidate.env ?? process.env, windowsHide: true },
      (error, stdout) => resolve(error && !stdout ? null : stdout));
  }), Promise.resolve(null));
}

// ---------------------------------------------------------------- machine selection

/**
 * Finds a machine by name, MagicDNS name, Tailscale IP, any id it is saved under (Pane id, install
 * id, relay id), a route's host name, or a unique name prefix.
 */
/** Machines' names, each with an id where two share a name. */
function namesWithIds(machines: readonly TailnetMachine[]): string {
  return machines.map((machine) => {
    if (machines.filter((other) => other.name === machine.name).length === 1) return machine.name;
    const id = machine.aliases?.find((alias) => alias !== machine.name && !alias.includes('.')) ?? machine.dnsName;
    return `${machine.name} (${id})`;
  }).join(', ');
}

export function resolveMachine(query: string, machines: readonly TailnetMachine[]): TailnetMachine {
  const wanted = query.trim().toLowerCase().replace(/\.$/, '');
  // A cloud Session's VM is listed under "Pane Cloud", and still answers to its own name and ids.
  const vms = machines.flatMap((machine) => machine.cloudSessions?.map((session) => session.machine) ?? []);
  const exact = [...machines, ...vms].filter((machine) => machine.name.toLowerCase() === wanted || machine.dnsName.toLowerCase() === wanted
    || machine.ips.includes(wanted) || machine.aliases?.includes(wanted));
  const matches = exact.length ? exact : machines.filter((machine) => machine.name.startsWith(wanted));
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) {
    throw new RunpaneError(
      'ERR_WORKSPACE_MACHINE_AMBIGUOUS',
      `"${query}" matches several machines: ${namesWithIds(matches)}. Nothing was sent.`,
      'Use the full name, or the id shown.',
    );
  }
  throw new RunpaneError(
    'ERR_WORKSPACE_MACHINE_UNKNOWN',
    `No machine on your tailnet or saved in Pane is called "${query}". Machines: ${describeMachines(machines) || 'none'}. Nothing was sent.`,
    'Pick a name from `runpane workspace list`, or link the computer first: runpane link <link>.',
  );
}

/**
 * My machines whose OS fits a path that has the shape of another OS's paths; empty for local-shaped paths.
 * Other people's machines are reached only by name.
 */
function machinesForPath(
  value: string,
  machines: readonly TailnetMachine[],
  platform: NodeJS.Platform = process.platform,
): TailnetMachine[] {
  const systems = foreignPathSystems(value, platform);
  return machines.filter((machine) => machine.mine && !machine.self && machine.os !== 'unknown' && systems.includes(machine.os));
}

/** The systems a path belongs to when its shape cannot exist on this platform; empty otherwise. */
function foreignPathSystems(value: string, platform: NodeJS.Platform): MachineOs[] {
  const local = platform === 'darwin' ? 'macOS' : platform === 'win32' ? 'Windows' : 'Linux';
  const p = value.trim();
  let systems: MachineOs[];
  if (/^[A-Za-z]:([\\/]|$)/.test(p) || /^(\\\\|\/\/)wsl(\.localhost|\$)[\\/]/i.test(p)) systems = ['Windows'];
  else if (/^\/mnt\/[a-z](\/|$)/.test(p) || p.startsWith('/home/')) systems = ['Windows', 'Linux'];
  else if (p.startsWith('/Users/')) systems = ['macOS'];
  else return [];
  return systems.includes(local) ? [] : systems;
}

function describeMachines(machines: readonly TailnetMachine[]): string {
  return machines.filter((machine) => !machine.self).map(describeMachine).join(', ');
}

/** "name (OS, online)", plus the owner's login for someone else's machine. */
function describeMachine(machine: TailnetMachine): string {
  return `${machine.name} (${machine.os === 'unknown' ? 'OS unknown' : machine.os}, ${machine.online ? 'online' : 'offline'}${machine.mine ? '' : `, owner ${machine.owner}`})`;
}

function tailscaleRoute(dnsName: string): RemoteRoute {
  return { kind: 'tailscale', baseUrl: `https://${dnsName}:${workspaceHttpsPort()}` };
}

/** A saved computer's routes in order; a Tailscale machine Pane has not saved is reached by its MagicDNS name and login. */
export function workspaceTarget(machine: TailnetMachine): RemoteDaemonTarget {
  if (machine.cloudSessions) throw new Error(`${PANE_CLOUD_NAME} runs each Session on its own machine: pick one with cloudSessionMachine first.`);
  return { machine: machine.name, routes: machine.routes ?? [tailscaleRoute(machine.dnsName)] };
}

/** The CLI's copy of what it reads from `RemoteComputer` in shared/types/remoteComputers.ts, which this package cannot import. */
const savedComputerSchema = boundary.object({
  id: boundary.nonEmptyString,
  label: boundary.nonEmptyString,
  machineId: boundary.optional(boundary.nonEmptyString),
  os: boundary.optional(boundary.enumeration('macOS', 'Windows', 'Linux')),
  routes: boundary.array(boundary.object({
    kind: boundary.string,
    baseUrl: boundary.nonEmptyString,
    token: boundary.string,
    relay: boundary.optional(boundary.object({ computerId: boundary.nonEmptyString, fingerprint: boundary.nonEmptyString })),
    tailnetMachine: boundary.optional(boundary.nonEmptyString),
  })),
});
type SavedComputer = ReturnType<typeof savedComputerSchema.decode>;

/** What a Pane older than computers answers: one entry per computer linked through the relay. */
const linkedComputersSchema = boundary.array(boundary.object({
  id: boundary.string,
  name: boundary.string,
  address: boundary.string,
  token: boundary.string,
  fingerprint: boundary.nonEmptyString,
}));

/** "lowercase-with-dashes" for a computer name, so it reads like a Tailscale machine name. */
function machineSlug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'computer';
}

/** How a relay name and a Tailscale name compare, as Pane compares them: lowercased, first label, spaces as dashes. */
function machineNameKey(name: string): string {
  return name.trim().toLowerCase().replace(/\.local$/u, '').split('.')[0].replace(/[\s_]+/gu, '-');
}

/**
 * The computers saved in this machine's Pane (Settings › Remote Access › Computers), one record
 * each with its routes in order. A Pane older than computers lists its relay links instead.
 */
async function readSavedComputers(paneDir?: string): Promise<SavedComputer[]> {
  const options = { paneDir, timeoutMs: LOCAL_STATUS_TIMEOUT_MS };
  let saved: JsonValue[];
  try {
    saved = await invokeDaemon('computers:list', [], boundary.array(boundary.json), options);
  } catch (error) {
    if (!(error instanceof PaneDaemonClientError && (error.code === 'ERR_UNKNOWN_CHANNEL' || error.message.includes('No Pane daemon command registered')))) return [];
    try {
      const linked = await invokeDaemon('relay:linked-computers', [], linkedComputersSchema, options);
      return linked.map((computer) => ({
        id: `relay-${computer.id}`,
        label: computer.name,
        machineId: undefined,
        os: undefined,
        routes: [{
          kind: 'relay', baseUrl: computer.address, token: computer.token,
          relay: { computerId: computer.id, fingerprint: computer.fingerprint }, tailnetMachine: undefined,
        }],
      }));
    } catch {
      return [];
    }
  }
  // A record this runpane cannot read is left out; the rest still work.
  return saved.flatMap((entry) => {
    try {
      const computer = decodeBoundary(entry, savedComputerSchema);
      return computer.routes.length ? [computer] : [];
    } catch {
      return [];
    }
  });
}

function hostOf(baseUrl: string): string {
  try {
    return new URL(baseUrl).hostname.toLowerCase();
  } catch {
    return '';
  }
}

/** The tailnet machine a saved computer is: by its Tailscale route, else by a name no other saved computer has. */
function peerOf(computer: SavedComputer, computers: readonly SavedComputer[], peers: readonly TailnetMachine[]): TailnetMachine | undefined {
  const tailnetName = computer.routes.find((route) => route.tailnetMachine)?.tailnetMachine?.toLowerCase();
  const hosts = new Set(computer.routes.map((route) => hostOf(route.baseUrl)));
  const byRoute = peers.find((peer) => peer.name === tailnetName || hosts.has(peer.dnsName.toLowerCase()));
  if (byRoute || computer.routes.some((route) => route.kind === 'tailscale')) return byRoute;
  const key = machineNameKey(computer.label);
  if (computers.filter((other) => machineNameKey(other.label) === key).length > 1) return undefined;
  return peers.find((peer) => peer.name === key);
}

const ROUTE_ORDER = ['lan', 'tailscale', 'ssh', 'public', 'relay'];

function ipv4Number(address: string): number | undefined {
  const parts = address.split('.').map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return undefined;
  return parts.reduce((value, part) => value * 256 + part, 0);
}

/**
 * Whether a Same network route (`https://l<a-b-c-d>.<id>.<domain>`) is on one of this computer's
 * subnets, as `routesReachableHere` in shared/types/remoteComputers.ts decides for desktop Pane.
 */
function onThisNetwork(baseUrl: string): boolean {
  const encoded = /^l(\d+-\d+-\d+-\d+)\./u.exec(hostOf(baseUrl))?.[1];
  const address = encoded === undefined ? undefined : ipv4Number(encoded.replace(/-/gu, '.'));
  if (address === undefined) return true;
  return Object.values(os.networkInterfaces()).flatMap((entries) => entries ?? []).some((entry) => {
    const own = entry.family === 'IPv4' && !entry.internal ? ipv4Number(entry.address) : undefined;
    const mask = ipv4Number(entry.netmask);
    return own !== undefined && mask !== undefined && ((own & mask) >>> 0) === ((address & mask) >>> 0);
  });
}

/** One saved computer as one machine, merged with its tailnet entry when it is on the tailnet. */
function computerMachine(computer: SavedComputer, peer: TailnetMachine | undefined): TailnetMachine {
  // Same network routes on another network (or WSL, Docker and VM adapters) would only cost timeouts.
  const nearby = computer.routes.filter((route) => route.kind !== 'lan' || onThisNetwork(route.baseUrl));
  const routes: RemoteRoute[] = (nearby.length ? nearby : computer.routes).map((route) => {
    const remote: RemoteRoute = { kind: route.kind, baseUrl: route.baseUrl };
    if (route.token) remote.token = route.token;
    if (route.relay) remote.fingerprint = route.relay.fingerprint;
    return remote;
  });
  // On the tailnet without a saved Tailscale route: reach it there too, before the routes that are farther.
  if (peer && !routes.some((route) => route.kind === 'tailscale')) {
    const after = routes.findIndex((route) => ROUTE_ORDER.indexOf(route.kind) > ROUTE_ORDER.indexOf('tailscale'));
    routes.splice(after < 0 ? routes.length : after, 0, tailscaleRoute(peer.dnsName));
  }
  // The tailnet says it is offline there (Tailscale signed out on it): try Tailscale last.
  if (peer && !peer.online) routes.sort((left, right) => Number(left.kind === 'tailscale') - Number(right.kind === 'tailscale'));
  const aliases = [computer.id, computer.machineId, machineNameKey(computer.label),
    ...computer.routes.flatMap((route) => [route.relay?.computerId, route.tailnetMachine, hostOf(route.baseUrl)])]
    .filter((alias): alias is string => Boolean(alias)).map((alias) => alias.toLowerCase());
  return {
    name: peer?.name ?? computer.routes.find((route) => route.tailnetMachine)?.tailnetMachine?.toLowerCase() ?? machineSlug(computer.label),
    dnsName: peer?.dnsName ?? hostOf(computer.routes[0].baseUrl),
    os: computer.os ?? peer?.os ?? 'unknown',
    // A route other than Tailscale may answer whether or not the tailnet sees it.
    online: Boolean(peer?.online) || computer.routes.some((route) => route.kind !== 'tailscale'),
    ips: peer?.ips ?? [],
    self: false,
    owner: peer?.owner ?? 'you',
    mine: true,
    routes,
    aliases: [...new Set(aliases)],
  };
}

/** Asks a saved computer without a known OS for it, as the list and path routing need one. */
async function withOs(machine: TailnetMachine, known: boolean): Promise<TailnetMachine> {
  if (known) return machine;
  try {
    const info = await invokeRemoteDaemon(workspaceTarget(machine), 'runpane:machine:info', [], machineInfoSchema, PROBE_TIMEOUT_MS);
    return { ...machine, os: info.os, online: true };
  } catch (error) {
    return { ...machine, online: false, unreachable: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * The machines runpane workspace can reach, one entry per computer: those saved in Pane, each with
 * its routes, and the tailnet's other machines. A saved computer on the tailnet is one entry.
 */
async function readMachines(paneDir?: string): Promise<Tailnet> {
  const [tailnet, computers, cloud] = await Promise.all([readTailnet(), readSavedComputers(paneDir), readPaneCloud(paneDir)]);
  const peers = tailnet.ok ? tailnet.machines : [];
  const merged = new Set<TailnetMachine>();
  const members = new Map((cloud?.members ?? []).map((member) => [member.computerId, member]));
  const vms: CloudSession[] = [];
  const saved = (await Promise.all(computers.map(async (computer) => {
    const peer = peerOf(computer, computers, peers);
    if (peer) merged.add(peer);
    const machine = await withOs(computerMachine(computer, peer), Boolean(computer.os ?? peer?.os));
    const member = members.get(computer.id);
    if (!member) return [machine];
    vms.push({ name: member.sessionName, awake: member.awake, machine });
    return [];
  }))).flat();
  if (vms.length) {
    // In the order desktop Pane lists them: newest first.
    const order = [...members.keys()].map((id) => id.toLowerCase());
    vms.sort((left, right) => order.indexOf(machineIdOf(left.machine)) - order.indexOf(machineIdOf(right.machine)));
    saved.push(paneCloudGroup(vms));
  }
  const machines = [...saved, ...peers.filter((peer) => !merged.has(peer))]
    .sort((left, right) => Number(right.mine) - Number(left.mine) || Number(right.online) - Number(left.online)
      || left.name.localeCompare(right.name));
  if (tailnet.ok) return { ...tailnet, machines };
  if (!saved.length) return tailnet;
  const hostname = await machineHostname();
  const self: TailnetMachine = {
    name: machineSlug(hostname), dnsName: hostname, os: process.platform === 'darwin' ? 'macOS' : process.platform === 'win32' ? 'Windows' : 'Linux',
    online: true, ips: [], self: true, owner: 'you', mine: true,
  };
  return { ok: true, self, machines, httpsCertificates: true };
}

/** The saved computer id a machine was built from (its first alias). */
function machineIdOf(machine: TailnetMachine): string {
  return machine.aliases?.[0] ?? machine.name;
}

/** Desktop Pane's "Pane Cloud" machine: its paired cloud Sessions, newest first. Null without one, or from a Pane before it. */
async function readPaneCloud(paneDir?: string): Promise<ReturnType<typeof paneCloudMachineSchema.decode>> {
  try {
    return await invokeDaemon(PANE_CLOUD_MACHINE_CHANNEL, [], paneCloudMachineSchema, { paneDir, timeoutMs: LOCAL_STATUS_TIMEOUT_MS * 4 });
  } catch {
    return null;
  }
}

/** All cloud VMs as one machine (D-90). It has no route of its own: a command reaches one of its Sessions. */
function paneCloudGroup(sessions: CloudSession[]): TailnetMachine {
  return {
    name: PANE_CLOUD_NAME, dnsName: 'pane-cloud', os: 'Linux',
    online: sessions.some((session) => session.machine.online), ips: [], self: false, owner: 'you', mine: true,
    aliases: ['pane cloud', 'pane-cloud'], cloudSessions: sessions,
  };
}

function describeCloudSessions(machine: TailnetMachine): string {
  return (machine.cloudSessions ?? []).map((session) => `"${session.name}"${session.awake ? '' : ' (stopped)'}`).join(', ');
}

/** What names a cloud Session in a command: the Session itself, or a Pane or tab in it. */
export interface CloudSelector {
  session?: string;
  pane?: string;
  panel?: string;
}

/**
 * `example` is the command line after the machine, with `--session "<name>"` where it belongs.
 * The VM a command for "Pane Cloud" goes to: the cloud Session it names by name or id, or the one
 * holding the Pane or tab it names. A command that names none of them is refused, listing the Sessions.
 */
async function cloudSessionMachine(group: TailnetMachine, selector: CloudSelector, example: string): Promise<TailnetMachine> {
  const sessions = group.cloudSessions ?? [];
  const named = selector.session?.trim();
  const byName = named ? sessions.filter((session) => session.name.toLowerCase() === named.toLowerCase()) : [];
  let found: CloudSession[] = byName;
  if (!found.length && (named || selector.pane || selector.panel)) {
    const probe = named
      ? (target: RemoteDaemonTarget) => invokeRemoteDaemon(target, 'runpane:sessions:get', [{ sessionId: named }], boundary.json, PROBE_TIMEOUT_MS).then(() => true)
      : selector.pane
        ? async (target: RemoteDaemonTarget) => {
          const list = await invokeRemoteDaemon(target, 'runpane:panes:list', [{}], paneIdsSchema, PROBE_TIMEOUT_MS);
          return list.panes.some((pane) => pane.id === selector.pane || pane.paneId === selector.pane);
        }
        : (target: RemoteDaemonTarget) => invokeRemoteDaemon(target, 'runpane:panels:output', [{ panelId: selector.panel, limit: 1 }], boundary.json, PROBE_TIMEOUT_MS).then(() => true);
    const answers = await Promise.all(sessions.filter((session) => session.awake && session.machine.online)
      .map(async (session) => ((await probe(workspaceTarget(session.machine)).catch(() => false)) ? session : null)));
    found = answers.filter((session): session is CloudSession => session !== null);
  }
  const list = describeCloudSessions(group);
  if (found.length > 1) {
    throw new RunpaneError('ERR_WORKSPACE_CLOUD_SESSION_AMBIGUOUS', `Several cloud Sessions match: ${found.map((session) => `"${session.name}"`).join(', ')}. Nothing was sent.`, 'Name the Session by its id with --session <id>.');
  }
  if (found.length === 1) {
    const [session] = found;
    if (!session.awake) {
      throw new RunpaneError('ERR_WORKSPACE_CLOUD_SESSION_STOPPED', `Cloud Session "${session.name}" is stopped, so nothing was sent.`, 'Start it in Pane (Settings › Pane Cloud), then try again.');
    }
    return session.machine;
  }
  // A stopped Session's machine can't be asked, so an id of one reads as unknown: say so.
  const asleep = sessions.some((session) => !session.awake) ? ', or it is a stopped Session (start it in Pane)' : '';
  const what = named ? `No awake cloud Session is called "${named}" or has that id${asleep}` : selector.pane ? `No awake cloud Session has Pane ${selector.pane}`
    : selector.panel ? `No awake cloud Session has tab ${selector.panel}` : `${PANE_CLOUD_NAME} runs each Session on its own machine, so this command needs --session`;
  throw new RunpaneError('ERR_WORKSPACE_CLOUD_SESSION_REQUIRED', `${what}. Your cloud Sessions: ${list || 'none'}. Nothing was sent.`,
    `Name one: runpane workspace "${PANE_CLOUD_NAME}" ${example}`);
}

/** A machine a command can reach: the machine itself, or for "Pane Cloud" the VM of the Session the command names. */
export function concreteMachine(machine: TailnetMachine, selector: CloudSelector, example: string): Promise<TailnetMachine> {
  return machine.cloudSessions ? cloudSessionMachine(machine, selector, example) : Promise.resolve(machine);
}

const paneIdsSchema = boundary.object({ panes: boundary.array(boundary.object({ id: boundary.string, paneId: boundary.string })) });

const NOT_ANSWERING = 'Pane is not answering there; it needs a Pane with workspaces running and signed in to Tailscale';
/** With the tailnet-wide setting off, no machine can answer, so name the setting instead of the machine. */
const CERTIFICATES_OFF = 'this tailnet has HTTPS certificates turned off. Fix: Turn on HTTPS Certificates at https://login.tailscale.com/admin/dns.';

async function probeMachine(machine: TailnetMachine, target = workspaceTarget(machine), notAnswering = NOT_ANSWERING): Promise<{ info?: MachineInfo; error?: string }> {
  if (!machine.online) return { error: machine.unreachable ?? 'offline' };
  try {
    return { info: await invokeRemoteDaemon(target, 'runpane:machine:info', [], machineInfoSchema, PROBE_TIMEOUT_MS) };
  } catch (error) {
    // A saved computer's error names each route it tried.
    if (!machine.routes && error instanceof PaneDaemonClientError && (error.code === 'ERR_WORKSPACE_UNREACHABLE' || error.code === 'ERR_WORKSPACE_TIMEOUT')) {
      return { error: notAnswering };
    }
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

export async function requireTailnet(paneDir?: string): Promise<Extract<Tailnet, { ok: true }>> {
  const tailnet = await readMachines(paneDir);
  if (!tailnet.ok) {
    throw new RunpaneError(
      'ERR_WORKSPACE_NO_MACHINES',
      `runpane workspace needs Tailscale or a computer saved in Pane, and this machine has neither: ${tailnet.reason}. Nothing was sent.`,
      `${tailnet.fix} Or link a computer: runpane link <link>.`,
    );
  }
  return tailnet;
}

/** Picks the machine for a path that is not on this machine, or explains which names to choose from. */
async function routePath(value: string, verb: string, paneDir?: string): Promise<TailnetMachine> {
  const tailnet = await requireTailnet(paneDir);
  const candidates = machinesForPath(value, tailnet.machines).filter((machine) => machine.online);
  const probes = await Promise.all(candidates.map(async (machine) => ({ machine, probe: await probeMachine(machine) })));
  const joined = probes.filter(({ probe }) => probe.info).map(({ machine }) => machine);
  if (joined.length === 1) return joined[0];
  const names = (joined.length ? joined : candidates).map((machine) => machine.name);
  if (names.length > 1) {
    throw new Error(`"${value}" could be on ${names.join(', ')}. Name one: runpane workspace <machine> ${verb} ${quoteArg(value)}`);
  }
  if (probes.length === 1) {
    throw new Error(`"${value}" is not on this machine. It fits ${probes[0].machine.name}, but ${probes[0].probe.error}.`);
  }
  throw new Error(`"${value}" is not on this machine, and none of your online machines fits it. Machines: ${describeMachines(tailnet.machines) || 'none'}.`);
}

// ---------------------------------------------------------------- commands

export async function runWorkspaceList(parsed: ParsedArgs): Promise<number> {
  const tailnet = await requireTailnet(parsed.paneDir);
  const [local, relay] = await Promise.all([readLocalStatus(parsed.paneDir), readRelayStatus(parsed.paneDir)]);
  // Offline machines need no probe, so only online ones count toward the limit; mine come first.
  const reachable = tailnet.machines.flatMap((machine) => machine.cloudSessions?.map((session) => session.machine) ?? [machine]);
  const probed = new Set(reachable.filter((machine) => machine.online).slice(0, MAX_PROBED_MACHINES));
  const check = async (machine: TailnetMachine) => {
    const target = workspaceTarget(machine);
    const probe = probed.has(machine) || !machine.online
      ? await probeMachine(machine, target, tailnet.httpsCertificates || machine.routes ? NOT_ANSWERING : CERTIFICATES_OFF)
      : { error: `not checked (Pane checks the first ${MAX_PROBED_MACHINES} online machines)` };
    return { machine, probe, route: answeringRoute(target) };
  };
  type Row = Awaited<ReturnType<typeof check>>;
  const rows = await Promise.all(tailnet.machines.map(async (machine) => ({
    machine,
    row: machine.cloudSessions ? null : await check(machine),
    sessions: machine.cloudSessions ? await Promise.all(machine.cloudSessions.map(async (session) => ({ session, row: await check(session.machine) }))) : null,
  })));
  // Route tokens stay internal: the list names where each route goes and which key it holds.
  const entry = ({ machine: { routes, aliases, unreachable: _unreachable, cloudSessions: _sessions, ...machine }, probe, route }: Row) => ({
    ...machine,
    ids: aliases,
    routes: routes?.map((candidate) => ({ kind: candidate.kind, baseUrl: candidate.baseUrl, fingerprint: candidate.fingerprint, answered: candidate === route })),
    joined: Boolean(probe.info),
    info: probe.info,
    error: probe.error,
  });
  if (parsed.json) {
    console.log(JSON.stringify({
      ok: true,
      self: { ...tailnet.self, workspace: local, relay },
      machines: rows.map(({ machine, row, sessions }) => (row ? entry(row) : {
        ...entry({ machine, probe: sessions?.some(({ row: vm }) => vm.probe.info) ? { info: undefined } : { error: 'no cloud Session answers' }, route: undefined }),
        joined: Boolean(sessions?.some(({ row: vm }) => vm.probe.info)),
        sessions: sessions?.map(({ session, row: vm }) => ({ name: session.name, awake: session.awake, machine: entry(vm) })),
      })),
    }, null, 2));
    return 0;
  }
  const state = ({ machine, probe, route }: Row) => {
    const through = route && machine.routes ? ` through ${routeLabel(route.kind)}` : '';
    const offline = machine.unreachable ? `not reachable: ${machine.unreachable}` : 'offline';
    return machine.online ? (probe.info ? `joined${through}, shell ${probe.info.shell}` : `not reachable: ${probe.error}`) : offline;
  };
  const tailscale = local ? describeLocalStatus(local) : 'off (Pane is not running)';
  console.log(`${tailnet.self.name} (this machine, ${tailnet.self.os}): ${relay?.enabled ? `${describeRelay(relay)}. Tailscale: ${tailscale}` : tailscale}`);
  for (const { machine, row, sessions } of rows) {
    if (row) {
      const routes = machine.routes ? ` [${machine.routes.map((candidate) => routeLabel(candidate.kind)).join(', ')}]` : '';
      console.log(`${describeMachine(machine)}${routes}: ${state(row)}`);
      continue;
    }
    console.log(`${PANE_CLOUD_NAME} (${sessions?.length ?? 0} cloud Session${sessions?.length === 1 ? '' : 's'}, each on its own machine; name one with --session):`);
    for (const { session, row: vm } of sessions ?? []) console.log(`  "${session.name}": ${session.awake ? state(vm) : 'stopped'}`);
  }
  console.log(REACH_LINE);
  return 0;
}

export async function runWorkspaceSetEnabled(parsed: ParsedArgs, enabled: boolean): Promise<number> {
  const result = await invokeDaemon('runpane:workspaces:set-enabled', [{ enabled }], localStatusSchema, { paneDir: parsed.paneDir });
  if (parsed.json) console.log(JSON.stringify({ ok: true, ...result }, null, 2));
  else console.log(`Workspaces: ${describeLocalStatus(result)}`);
  return 0;
}

export async function runWorkspaceRead(parsed: ParsedArgs): Promise<number> {
  const target = requirePath(parsed, 'read');
  const machine = await pickMachine(parsed, target, 'read');
  const result = await callMachine(parsed, machine, 'runpane:machine:read', [{ path: target }], readResultSchema);
  if (parsed.json) {
    console.log(JSON.stringify({ ok: true, machine: machine?.name ?? null, ...result }, null, 2));
  } else {
    process.stdout.write(Buffer.from(result.content, result.encoding));
  }
  return 0;
}

export async function runWorkspaceWrite(parsed: ParsedArgs): Promise<number> {
  const target = requirePath(parsed, 'write');
  const machine = await pickMachine(parsed, target, 'write');
  const content = parsed.writeContent === undefined ? fs.readFileSync(0) : Buffer.from(parsed.writeContent, 'utf8');
  const encoding = isUtf8(content) ? 'utf8' : 'base64';
  const request = { path: target, content: content.toString(encoding), encoding };
  const result = await callMachine(parsed, machine, 'runpane:machine:write', [request], writeResultSchema);
  if (parsed.json) console.log(JSON.stringify({ ok: true, machine: machine?.name ?? null, ...result }, null, 2));
  else console.log(`Wrote ${result.bytes} bytes to ${machine?.name ?? 'this machine'}:${result.path}`);
  return 0;
}

export async function runWorkspaceExec(parsed: ParsedArgs): Promise<number> {
  const command = parsed.execCommand?.join(' ').trim();
  if (!command) throw new Error('runpane workspace exec needs a command: runpane workspace <machine> exec -- <command>');
  let machine: TailnetMachine;
  if (parsed.workspaceMachine) {
    const tailnet = await requireTailnet(parsed.paneDir);
    machine = await concreteMachine(resolveMachine(parsed.workspaceMachine, [tailnet.self, ...tailnet.machines]), { session: parsed.sessionId }, 'exec --session "<name>" -- <command>');
  } else if (parsed.cwd && foreignPathSystems(parsed.cwd, process.platform).length > 0) {
    machine = await routePath(parsed.cwd, `exec --cwd ${quoteArg(parsed.cwd)} --`, parsed.paneDir);
  } else {
    throw new Error('runpane workspace exec needs a machine: runpane workspace <machine> exec -- <command>. List machines with: runpane workspace list');
  }
  const result = await invokeRemoteDaemon(
    workspaceTarget(machine),
    'runpane:machine:exec',
    [{ command, cwd: parsed.cwd, timeoutMs: parsed.timeoutMs }],
    execResultSchema,
    (parsed.timeoutMs ?? 120_000) + 30_000,
  );
  if (parsed.json) {
    console.log(JSON.stringify({ ok: result.exitCode === 0, machine: machine.name, ...result }, null, 2));
  } else {
    process.stdout.write(result.stdout);
    process.stderr.write(result.stderr);
    const ending = result.stillRunning
      ? 'timed out, and could not be stopped; it may still be running'
      : result.timedOut ? 'timed out' : result.signal ? `signal ${result.signal}` : `exit ${result.exitCode}`;
    process.stderr.write(`[${machine.name}: ${result.os}, ${result.shell}, ${ending}]\n`);
  }
  return result.exitCode ?? 1;
}

function requirePath(parsed: ParsedArgs, verb: string): string {
  if (!parsed.workspacePath) throw new Error(`runpane workspace ${verb} needs a path: runpane workspace [<machine>] ${verb} <path>`);
  return parsed.workspacePath;
}

/**
 * null means this machine. A path shaped like another OS's (C:\... on a Mac) goes to the machine
 * it fits; every other path is this machine's.
 */
async function pickMachine(parsed: ParsedArgs, target: string, verb: string): Promise<TailnetMachine | null> {
  if (parsed.workspaceMachine) {
    const tailnet = await requireTailnet(parsed.paneDir);
    return concreteMachine(resolveMachine(parsed.workspaceMachine, [tailnet.self, ...tailnet.machines]), { session: parsed.sessionId }, `${verb} ${quoteArg(target)} --session "<name>"`);
  }
  return foreignPathSystems(target, process.platform).length > 0 ? routePath(target, verb, parsed.paneDir) : null;
}

/** Another machine's Pane over the tailnet, or this machine's own Pane; both resolve paths the same way. */
function callMachine<T>(
  parsed: ParsedArgs,
  machine: TailnetMachine | null,
  channel: string,
  args: unknown[],
  schema: BoundarySchema<T>,
): Promise<T> {
  return machine
    ? invokeRemoteDaemon(workspaceTarget(machine), channel, args, schema)
    : invokeDaemon(channel, args, schema, { paneDir: parsed.paneDir });
}

// ---------------------------------------------------------------- discovery

export interface WorkspaceSummary {
  state: 'on' | 'off';
  machine: string | null;
  reason?: string;
  fix?: string;
  otherMachines: Array<{ name: string; os: MachineOs | 'unknown'; online: boolean; owner: string; mine: boolean }>;
  lines: string[];
}

/** The short workspaces block that help, doctor, and agent-context print. */
export async function readWorkspaceSummary(paneDir?: string): Promise<WorkspaceSummary> {
  const [tailnet, local] = await Promise.all([readTailnet(), readLocalStatus(paneDir)]);
  if (!tailnet.ok) {
    return {
      state: 'off', machine: null, reason: tailnet.reason, fix: tailnet.fix, otherMachines: [],
      lines: [`Workspaces: off (${tailnet.reason}). Fix: ${tailnet.fix}`],
    };
  }
  const otherMachines = tailnet.machines.map(({ name, os: machineOs, online, owner, mine }) => ({ name, os: machineOs, online, owner, mine }));
  const state = local?.state ?? 'off';
  const reason = local ? local.reason : 'Pane is not running';
  const fix = local ? local.fix : 'Open Pane.';
  const lines = [
    state === 'on' ? `Workspaces: on (${tailnet.self.name})` : `Workspaces: off on ${tailnet.self.name} (${reason}). Fix: ${fix}`,
    `Other machines: ${describeMachines(tailnet.machines) || 'none'}`,
  ];
  if (otherMachines.length) lines.push(REACH_LINE);
  return { state, machine: tailnet.self.name, reason: state === 'on' ? undefined : reason, fix: state === 'on' ? undefined : fix, otherMachines, lines };
}

/** null when Pane does not answer here. */
async function readLocalStatus(paneDir?: string): Promise<ReturnType<typeof localStatusSchema.decode> | null> {
  try {
    return await invokeDaemon('runpane:workspaces:status', [], localStatusSchema, { paneDir, timeoutMs: LOCAL_STATUS_TIMEOUT_MS });
  } catch (error) {
    return error instanceof Error && error.message.includes('No Pane daemon command registered')
      ? { enabled: false, state: 'off', reason: 'this Pane is older than workspaces', fix: 'Update Pane, then restart it.', machineName: undefined, url: undefined }
      : null;
  }
}

/**
 * This machine's name as Pane and Tailscale give it (main/src/utils/computerName.ts): a Mac with a
 * network-assigned host name (`Mac.localdomain`, `localhost`) goes by its LocalHostName.
 */
async function machineHostname(): Promise<string> {
  const host = os.hostname().replace(/\.local$/i, '');
  if (process.platform !== 'darwin' || (!host.includes('.') && host !== 'localhost')) return host;
  return new Promise((resolve) => {
    execFile('/usr/sbin/scutil', ['--get', 'LocalHostName'], { encoding: 'utf8', timeout: 2_000 }, (error, stdout) => resolve((!error && stdout.trim()) || host));
  });
}

/** null when Pane does not answer here or is older than phone access. */
async function readRelayStatus(paneDir?: string): Promise<ReturnType<typeof relayStatusSchema.decode> | null> {
  try {
    return await invokeDaemon('relay:status', [], relayStatusSchema, { paneDir, timeoutMs: LOCAL_STATUS_TIMEOUT_MS });
  } catch {
    return null;
  }
}

function describeRelay(relay: ReturnType<typeof relayStatusSchema.decode>): string {
  if (relay.certificateLimit) {
    const until = new Date(relay.certificateLimit.until).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    return `not accepting new phone pairings through Pane relay until ${until}: both certificate services are turning away new computers. Connect with Tailscale instead`;
  }
  if (relay.phase === 'ready') return `reachable through Pane relay (${relay.address ?? 'its relay address'})`;
  return `not reachable through Pane relay yet (${relay.lastError ?? 'still connecting'})`;
}

function describeLocalStatus(status: ReturnType<typeof localStatusSchema.decode>): string {
  if (status.state === 'on') return `on (${status.machineName ?? 'this machine'})`;
  return `off (${status.reason ?? 'unknown'})${status.fix ? `. Fix: ${status.fix}` : ''}`;
}

/** For a path or Session ID that is not on this machine: the likely machine and the exact command to use. */
export async function workspaceHintFor(error: NodeJS.ErrnoException, parsed: ParsedArgs): Promise<string | null> {
  if (error.code === 'ENOENT' && error.path) {
    const tailnet = await readTailnet();
    if (!tailnet.ok) return null;
    const candidates = machinesForPath(error.path, tailnet.machines);
    if (!candidates.length) return null;
    return `That path is not on this machine. It looks like it is on ${describeMachines(candidates)}. Read it with: runpane workspace ${candidates[0].name} read ${quoteArg(error.path)}`;
  }
  const sessionId = parsed.sessionId;
  if (sessionId && /not found|no session|unknown session/i.test(error.message)) {
    const tailnet = await readTailnet();
    if (!tailnet.ok) return null;
    const found = await Promise.all(tailnet.machines.filter((machine) => machine.mine && machine.online).map(async (machine) => {
      try {
        await invokeRemoteDaemon(workspaceTarget(machine), 'runpane:sessions:get', [{ sessionId }], boundary.json, PROBE_TIMEOUT_MS);
        return machine;
      } catch {
        return null;
      }
    }));
    const machine = found.find((candidate) => candidate !== null);
    if (machine) {
      return `Session ${sessionId} is on ${machine.name}. Use: runpane workspace ${machine.name} ${parsed.command} --session ${quoteArg(sessionId)}`;
    }
  }
  return null;
}

// ---------------------------------------------------------------- helpers

function isUtf8(buffer: Buffer): boolean {
  if (buffer.includes(0)) return false;
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(buffer);
    return true;
  } catch {
    return false;
  }
}

function quoteArg(value: string): string {
  return /^[\w./:@-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`;
}

