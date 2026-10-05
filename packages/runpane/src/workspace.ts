import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { boundary, decodeBoundary } from './boundaryDecoder';
import type { JsonValue } from './boundaryDecoder';
import type { ParsedArgs } from './commands';
import { invokeDaemon, invokeRemoteDaemon, PaneDaemonClientError, type RemoteDaemonTarget } from './daemonClient';

/** Tailnet port where each joined machine's Pane serves workspaces. */
const WORKSPACE_HTTPS_PORT = 8443;
const TAILSCALE_TIMEOUT_MS = 3_000;
const PROBE_TIMEOUT_MS = 4_000;
const LOCAL_STATUS_TIMEOUT_MS = 1_500;
const REACH_LINE = 'Reach them: runpane workspace <machine> read|write|exec|<command>';

type MachineOs = 'macOS' | 'Windows' | 'Linux';

export interface TailnetMachine {
  name: string;
  dnsName: string;
  os: MachineOs;
  online: boolean;
  ips: string[];
  self: boolean;
}

export type Tailnet =
  | { ok: true; self: TailnetMachine; machines: TailnetMachine[] }
  | { ok: false; reason: string; fix: string };

const peerSchema = boundary.object({
  DNSName: boundary.string,
  OS: boundary.string,
  UserID: boundary.number,
  Online: boundary.optional(boundary.boolean),
  TailscaleIPs: boundary.optional(boundary.nullable(boundary.array(boundary.string))),
  Tags: boundary.optional(boundary.nullable(boundary.array(boundary.string))),
});
const statusSchema = boundary.object({
  BackendState: boundary.string,
  Self: boundary.optional(boundary.nullable(peerSchema)),
  Peer: boundary.optional(boundary.nullable(boundary.jsonObject)),
});

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

/** This machine and the owner's other Mac, Windows, and Linux machines, from `tailscale status --json`. */
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
  const self = toMachine(status.Self, true);
  const ownerId = status.Self.UserID;
  const machines = Object.values(status.Peer ?? {})
    .map(decodePeer)
    .filter((peer): peer is NonNullable<typeof peer> => Boolean(peer && peer.UserID === ownerId && !peer.Tags?.length))
    .map((peer) => toMachine(peer, false))
    .filter((machine): machine is TailnetMachine => machine !== null)
    .sort((left, right) => Number(right.online) - Number(left.online) || left.name.localeCompare(right.name));
  if (!self) return { ok: false, reason: `Tailscale reports an unsupported OS (${status.Self.OS})`, fix: 'Run Pane on macOS, Windows, or Linux.' };
  return { ok: true, self, machines };
}

const TAILSCALE_OS_NAMES = new Map<string, MachineOs>([['macos', 'macOS'], ['windows', 'Windows'], ['linux', 'Linux']]);

function decodePeer(value: JsonValue): ReturnType<typeof peerSchema.decode> | null {
  try {
    return decodeBoundary(value, peerSchema);
  } catch {
    return null;
  }
}

function toMachine(peer: ReturnType<typeof peerSchema.decode>, self: boolean): TailnetMachine | null {
  const osName = TAILSCALE_OS_NAMES.get(peer.OS.toLowerCase());
  if (!osName) return null;
  const dnsName = peer.DNSName.replace(/\.$/, '');
  return { name: dnsName.split('.')[0], dnsName, os: osName, online: self || peer.Online === true, ips: peer.TailscaleIPs ?? [], self };
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
  return candidates.reduce<Promise<string | null>>(async (found, candidate) => (await found) ?? new Promise((resolve) => {
    execFile(candidate.command, args, { encoding: 'utf8', timeout: TAILSCALE_TIMEOUT_MS, env: candidate.env ?? process.env, windowsHide: true },
      (error, stdout) => resolve(error && !stdout ? null : stdout));
  }), Promise.resolve(null));
}

// ---------------------------------------------------------------- machine selection

/** Finds a machine by Tailscale name, MagicDNS name, Tailscale IP, or unique name prefix. */
export function resolveMachine(query: string, machines: readonly TailnetMachine[]): TailnetMachine {
  const wanted = query.trim().toLowerCase().replace(/\.$/, '');
  const exact = machines.find((machine) =>
    machine.name === wanted || machine.dnsName.toLowerCase() === wanted || machine.ips.includes(wanted));
  if (exact) return exact;
  const prefixed = machines.filter((machine) => machine.name.startsWith(wanted));
  if (prefixed.length === 1) return prefixed[0];
  if (prefixed.length > 1) {
    throw new Error(`"${query}" matches several machines: ${prefixed.map((machine) => machine.name).join(', ')}. Use the full name.`);
  }
  throw new Error(`No machine of yours on Tailscale is called "${query}". Your machines: ${describeMachines(machines) || 'none'}.`);
}

/** The machines whose OS fits a path that has the shape of another OS's paths; empty for local-shaped paths. */
function machinesForPath(
  value: string,
  machines: readonly TailnetMachine[],
  platform: NodeJS.Platform = process.platform,
): TailnetMachine[] {
  const systems = foreignPathSystems(value, platform);
  return machines.filter((machine) => !machine.self && systems.includes(machine.os));
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
  return machines.filter((machine) => !machine.self)
    .map((machine) => `${machine.name} (${machine.os}, ${machine.online ? 'online' : 'offline'})`).join(', ');
}

export function workspaceTarget(machine: TailnetMachine): RemoteDaemonTarget {
  return { machine: machine.name, baseUrl: `https://${machine.dnsName}:${WORKSPACE_HTTPS_PORT}` };
}

async function probeMachine(machine: TailnetMachine): Promise<{ info?: MachineInfo; error?: string }> {
  if (!machine.online) return { error: 'offline' };
  try {
    return { info: await invokeRemoteDaemon(workspaceTarget(machine), 'runpane:machine:info', [], machineInfoSchema, PROBE_TIMEOUT_MS) };
  } catch (error) {
    if (error instanceof PaneDaemonClientError && (error.code === 'ERR_WORKSPACE_UNREACHABLE' || error.code === 'ERR_WORKSPACE_TIMEOUT')) {
      return { error: 'Pane is not answering there; it needs a Pane with workspaces running and signed in to Tailscale' };
    }
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

async function requireTailnet(): Promise<Extract<Tailnet, { ok: true }>> {
  const tailnet = await readTailnet();
  if (!tailnet.ok) throw new Error(`runpane workspace needs Tailscale: ${tailnet.reason}. ${tailnet.fix}`);
  return tailnet;
}

/** Picks the machine for a path that is not on this machine, or explains which names to choose from. */
async function routePath(value: string, verb: string): Promise<TailnetMachine> {
  const tailnet = await requireTailnet();
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
  const tailnet = await requireTailnet();
  const local = await readLocalStatus(parsed.paneDir);
  const rows = await Promise.all(tailnet.machines.map(async (machine) => ({ machine, probe: await probeMachine(machine) })));
  if (parsed.json) {
    console.log(JSON.stringify({
      ok: true,
      self: { ...tailnet.self, workspace: local },
      machines: rows.map(({ machine, probe }) => ({ ...machine, joined: Boolean(probe.info), info: probe.info, error: probe.error })),
    }, null, 2));
    return 0;
  }
  console.log(`${tailnet.self.name} (this machine, ${tailnet.self.os}): ${local ? describeLocalStatus(local) : 'off (Pane is not running)'}`);
  for (const { machine, probe } of rows) {
    const state = probe.info ? `joined, shell ${probe.info.shell}` : `not reachable: ${probe.error}`;
    console.log(`${machine.name} (${machine.os}, ${machine.online ? 'online' : 'offline'}): ${machine.online ? state : 'offline'}`);
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
  const machine = await pickMachine(parsed, target, 'read', fs.existsSync(target));
  const result = machine
    ? await invokeRemoteDaemon(workspaceTarget(machine), 'runpane:machine:read', [{ path: target }], readResultSchema)
    : readLocalFile(target);
  if (parsed.json) {
    console.log(JSON.stringify({ ok: true, machine: machine?.name ?? null, ...result }, null, 2));
  } else {
    process.stdout.write(Buffer.from(result.content, result.encoding));
  }
  return 0;
}

export async function runWorkspaceWrite(parsed: ParsedArgs): Promise<number> {
  const target = requirePath(parsed, 'write');
  const machine = await pickMachine(parsed, target, 'write', fs.existsSync(path.dirname(target)));
  const content = fs.readFileSync(0);
  const encoding = isUtf8(content) ? 'utf8' : 'base64';
  const request = { path: target, content: content.toString(encoding), encoding };
  const result = machine
    ? await invokeRemoteDaemon(workspaceTarget(machine), 'runpane:machine:write', [request], writeResultSchema)
    : (fs.writeFileSync(target, content), { path: target, bytes: content.length });
  if (parsed.json) console.log(JSON.stringify({ ok: true, machine: machine?.name ?? null, ...result }, null, 2));
  else console.log(`Wrote ${result.bytes} bytes to ${machine?.name ?? 'this machine'}:${result.path}`);
  return 0;
}

export async function runWorkspaceExec(parsed: ParsedArgs): Promise<number> {
  const command = parsed.execCommand?.join(' ').trim();
  if (!command) throw new Error('runpane workspace exec needs a command: runpane workspace <machine> exec -- <command>');
  let machine: TailnetMachine;
  if (parsed.workspaceMachine) {
    const tailnet = await requireTailnet();
    machine = resolveMachine(parsed.workspaceMachine, [tailnet.self, ...tailnet.machines]);
  } else if (parsed.cwd && foreignPathSystems(parsed.cwd, process.platform).length > 0) {
    machine = await routePath(parsed.cwd, `exec --cwd ${quoteArg(parsed.cwd)} --`);
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
    const ending = result.timedOut ? 'timed out' : result.signal ? `signal ${result.signal}` : `exit ${result.exitCode}`;
    process.stderr.write(`[${machine.name}: ${result.os}, ${result.shell}, ${ending}]\n`);
  }
  return result.exitCode ?? 1;
}

function requirePath(parsed: ParsedArgs, verb: string): string {
  if (!parsed.workspacePath) throw new Error(`runpane workspace ${verb} needs a path: runpane workspace [<machine>] ${verb} <path>`);
  return parsed.workspacePath;
}

/** null means this machine. */
async function pickMachine(parsed: ParsedArgs, target: string, verb: string, existsHere: boolean): Promise<TailnetMachine | null> {
  if (parsed.workspaceMachine) {
    const tailnet = await requireTailnet();
    return resolveMachine(parsed.workspaceMachine, [tailnet.self, ...tailnet.machines]);
  }
  // A path shaped like another OS's (C:\... on a Mac) never means this machine, even when
  // a same-named relative file could exist here.
  const foreign = foreignPathSystems(target, process.platform).length > 0;
  if (existsHere && !foreign) return null;
  if (!foreign) {
    throw new Error(`No such file on this machine: ${target}. To read another machine's file, name it: runpane workspace <machine> ${verb} ${quoteArg(target)}`);
  }
  return routePath(target, verb);
}

function readLocalFile(target: string): ReturnType<typeof readResultSchema.decode> {
  const buffer = fs.readFileSync(target);
  return isUtf8(buffer)
    ? { path: target, encoding: 'utf8', content: buffer.toString('utf8'), bytes: buffer.length }
    : { path: target, encoding: 'base64', content: buffer.toString('base64'), bytes: buffer.length };
}

// ---------------------------------------------------------------- discovery

export interface WorkspaceSummary {
  state: 'on' | 'off';
  machine: string | null;
  reason?: string;
  fix?: string;
  otherMachines: Array<{ name: string; os: MachineOs; online: boolean }>;
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
  const otherMachines = tailnet.machines.map(({ name, os: machineOs, online }) => ({ name, os: machineOs, online }));
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
    const found = await Promise.all(tailnet.machines.filter((machine) => machine.online).map(async (machine) => {
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

