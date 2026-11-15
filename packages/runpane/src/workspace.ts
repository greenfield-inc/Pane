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
}

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
  const exact = machines.filter((machine) => machine.name === wanted || machine.dnsName.toLowerCase() === wanted
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

/** One saved computer as one machine, merged with its tailnet entry when it is on the tailnet. */
function computerMachine(computer: SavedComputer, peer: TailnetMachine | undefined): TailnetMachine {
  const routes: RemoteRoute[] = computer.routes.map((route) => {
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
  } catch {
    return { ...machine, online: false };
  }
}

/**
 * The machines runpane workspace can reach, one entry per computer: those saved in Pane, each with
 * its routes, and the tailnet's other machines. A saved computer on the tailnet is one entry.
 */
async function readMachines(paneDir?: string): Promise<Tailnet> {
  const [tailnet, computers] = await Promise.all([readTailnet(), readSavedComputers(paneDir)]);
  const peers = tailnet.ok ? tailnet.machines : [];
  const merged = new Set<TailnetMachine>();
  const saved = await Promise.all(computers.map((computer) => {
    const peer = peerOf(computer, computers, peers);
    if (peer) merged.add(peer);
    return withOs(computerMachine(computer, peer), Boolean(computer.os ?? peer?.os));
  }));
  const machines = [...saved, ...peers.filter((peer) => !merged.has(peer))]
    .sort((left, right) => Number(right.mine) - Number(left.mine) || Number(right.online) - Number(left.online)
      || left.name.localeCompare(right.name));
  if (tailnet.ok) return { ...tailnet, machines };
  if (!saved.length) return tailnet;
  const hostname = os.hostname().replace(/\.local$/i, '');
  const self: TailnetMachine = {
    name: machineSlug(hostname), dnsName: hostname, os: process.platform === 'darwin' ? 'macOS' : process.platform === 'win32' ? 'Windows' : 'Linux',
    online: true, ips: [], self: true, owner: 'you', mine: true,
  };
  return { ok: true, self, machines, httpsCertificates: true };
}

const NOT_ANSWERING = 'Pane is not answering there; it needs a Pane with workspaces running and signed in to Tailscale';
/** With the tailnet-wide setting off, no machine can answer, so name the setting instead of the machine. */
const CERTIFICATES_OFF = 'this tailnet has HTTPS certificates turned off. Fix: Turn on HTTPS Certificates at https://login.tailscale.com/admin/dns.';

async function probeMachine(machine: TailnetMachine, target = workspaceTarget(machine), notAnswering = NOT_ANSWERING): Promise<{ info?: MachineInfo; error?: string }> {
  if (!machine.online) return { error: 'offline' };
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
  const local = await readLocalStatus(parsed.paneDir);
  // Offline machines need no probe, so only online ones count toward the limit; mine come first.
  const probed = new Set(tailnet.machines.filter((machine) => machine.online).slice(0, MAX_PROBED_MACHINES));
  const rows = await Promise.all(tailnet.machines.map(async (machine) => {
    const target = workspaceTarget(machine);
    const probe = probed.has(machine) || !machine.online
      ? await probeMachine(machine, target, tailnet.httpsCertificates || machine.routes ? NOT_ANSWERING : CERTIFICATES_OFF)
      : { error: `not checked (Pane checks the first ${MAX_PROBED_MACHINES} online machines)` };
    return { machine, probe, route: answeringRoute(target) };
  }));
  if (parsed.json) {
    console.log(JSON.stringify({
      ok: true,
      self: { ...tailnet.self, workspace: local },
      // Route tokens stay internal: the list names where each route goes and which key it holds.
      machines: rows.map(({ machine: { routes, aliases, ...machine }, probe, route }) => ({
        ...machine,
        ids: aliases,
        routes: routes?.map((candidate) => ({ kind: candidate.kind, baseUrl: candidate.baseUrl, fingerprint: candidate.fingerprint, answered: candidate === route })),
        joined: Boolean(probe.info),
        info: probe.info,
        error: probe.error,
      })),
    }, null, 2));
    return 0;
  }
  console.log(`${tailnet.self.name} (this machine, ${tailnet.self.os}): ${local ? describeLocalStatus(local) : 'off (Pane is not running)'}`);
  for (const { machine, probe, route } of rows) {
    const through = route && machine.routes ? ` through ${routeLabel(route.kind)}` : '';
    const state = probe.info ? `joined${through}, shell ${probe.info.shell}` : `not reachable: ${probe.error}`;
    const routes = machine.routes ? ` [${machine.routes.map((candidate) => routeLabel(candidate.kind)).join(', ')}]` : '';
    console.log(`${describeMachine(machine)}${routes}: ${machine.online ? state : 'offline'}`);
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
    machine = resolveMachine(parsed.workspaceMachine, [tailnet.self, ...tailnet.machines]);
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
    return resolveMachine(parsed.workspaceMachine, [tailnet.self, ...tailnet.machines]);
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

