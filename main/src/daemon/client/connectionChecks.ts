import { execFile } from 'child_process';
import { isIP } from 'net';
import type {
  RemoteConnectionCheck,
  RemoteConnectionCheckFix,
  RemoteConnectionCheckRow,
  RemoteConnectionCheckStage,
  RemotePaneConnectionProfile,
} from '../../../../shared/types/remoteDaemon';
import type { RemotePaneFailedCheck } from '../../services/remoteAnalytics';
import type { TailnetMachineLookup, WorkspaceProbe } from '../../services/tailnetMachines';
import type { HostHealthCheck } from './remotePaneClient';

/** The commands a fix runs on a host. Each is fixed text; no user input reaches it. */
const HOST_FIX_COMMANDS = {
  startDaemon: 'npx --yes runpane@latest daemon repair --yes',
  updateDaemon: 'npx --yes runpane@latest update && npx --yes runpane@latest daemon repair --yes',
  openPaneOnMac: 'open -a Pane',
  updatePane: 'npx --yes runpane@latest update',
} as const;

const SSH_CONNECT_TIMEOUT_S = 10;
/** npx may download runpane first. */
const SSH_FIX_TIMEOUT_MS = 120_000;

export interface ConnectionCheckDependencies {
  /** `tailscale status --json`, or null when Tailscale is not installed. */
  readTailscaleStatus: () => Promise<string | null>;
  lookupTailnetMachine: (machine: { name: string; domain: string }, readStatus: () => Promise<string | null>) => Promise<TailnetMachineLookup>;
  probeWorkspace: WorkspaceProbe;
  listSshHosts: () => Promise<string[]>;
  runSsh: (alias: string, command: string) => Promise<void>;
}

/** The probes a host is asked before the real connect. */
export interface HostProbes {
  checkHealth(): Promise<HostHealthCheck>;
  checkSignIn(): Promise<'accepted' | 'rejected'>;
}

export interface ProbeOutcome {
  rows: RemoteConnectionCheckRow[];
  /** The stage that failed, for analytics; null when every probe passed. */
  failedCheck: RemotePaneFailedCheck | null;
  /** The host's Pane version when a probe reported it (codeless hosts describe themselves). */
  hostVersion: string | null;
  address: string;
  /** Where a `run-on-host` fix runs, by stage: the matching SSH host alias and its command. */
  hostFixes: Map<RemoteConnectionCheckStage, { alias: string; command: string }>;
}

/** The checklist before any probe has run. */
export function initialRows(profile: RemotePaneConnectionProfile): RemoteConnectionCheckRow[] {
  const stages: RemoteConnectionCheckStage[] = profile.tailnetMachine
    ? ['tailscale', 'reachable', 'running', 'signed-in', 'version', 'workspace']
    : ['reachable', 'running', 'signed-in', 'version', 'workspace'];
  return stages.map((stage) => ({ stage, status: 'waiting', label: stageLabel(profile, stage) }));
}

export function routeOf(profile: RemotePaneConnectionProfile): RemoteConnectionCheck['route'] {
  if (profile.tailnetMachine || profile.tunnel?.kind === 'tailscale') return 'Tailscale';
  return profile.tunnel?.kind === 'ssh' ? 'SSH tunnel' : 'URL';
}

export function addressOf(profile: RemotePaneConnectionProfile): string {
  try {
    return new URL(profile.baseUrl).host;
  } catch {
    return profile.baseUrl;
  }
}

function stageLabel(profile: RemotePaneConnectionProfile, stage: RemoteConnectionCheckStage): string {
  switch (stage) {
    case 'tailscale': return 'Tailscale on this computer';
    case 'reachable': return 'Host reachable';
    case 'running': return profile.tailnetMachine ? `Pane open on ${profile.label}` : 'Pane daemon running';
    case 'signed-in': return 'Signed in';
    case 'version': return 'Versions match';
    case 'workspace': return 'Workspace loaded';
  }
}

/**
 * Runs the stages that need no event stream, in order, and stops at the first failure.
 * `onRows` receives the checklist after each stage so the card can follow along.
 */
export async function probeHost(
  profile: RemotePaneConnectionProfile,
  probes: HostProbes,
  dependencies: ConnectionCheckDependencies,
  onRows: (rows: RemoteConnectionCheckRow[]) => void,
): Promise<ProbeOutcome> {
  const rows = initialRows(profile);
  const outcome: ProbeOutcome = { rows, failedCheck: null, hostVersion: null, address: addressOf(profile), hostFixes: new Map() };
  const set = (stage: RemoteConnectionCheckStage, row: Partial<RemoteConnectionCheckRow>): void => {
    const index = rows.findIndex((candidate) => candidate.stage === stage);
    rows[index] = { stage, status: row.status ?? 'passed', label: row.label ?? stageLabel(profile, stage), ...withoutUndefined(row) };
    onRows(rows.map((candidate) => ({ ...candidate })));
  };
  const fail = (stage: RemoteConnectionCheckStage, failedCheck: RemotePaneFailedCheck, row: Partial<RemoteConnectionCheckRow>): ProbeOutcome => {
    set(stage, { ...row, status: 'failed' });
    outcome.failedCheck = failedCheck;
    return outcome;
  };
  const host = profile.label;

  if (profile.tailnetMachine && profile.tailnetDomain) {
    set('tailscale', { status: 'running' });
    const lookup = await dependencies.lookupTailnetMachine(
      { name: profile.tailnetMachine, domain: profile.tailnetDomain },
      dependencies.readTailscaleStatus,
    );
    if (lookup.kind === 'tailscale-missing') {
      return fail('tailscale', 'tailscale_here', { label: 'Tailscale is not installed on this computer', fix: { kind: 'download-tailscale', label: 'Download Tailscale' } });
    }
    if (lookup.kind === 'tailscale-down') {
      const signedOut = lookup.reason === 'Tailscale is signed out';
      return fail('tailscale', 'tailscale_here', signedOut
        ? { label: 'Tailscale is signed out on this computer', fix: { kind: 'open-tailscale', label: 'Open Tailscale Setup' } }
        : { label: lookup.reason, detail: lookup.fix });
    }
    set('tailscale', {});
    set('reachable', { status: 'running' });
    if (lookup.kind === 'not-found') return fail('reachable', 'host_unreachable', { label: `Can't reach ${host}`, detail: lookup.reason });
    const { peer } = lookup;
    if (peer.ip) outcome.address = peer.ip;
    if (!peer.online || !peer.ip) return fail('reachable', 'host_offline', { label: `${host} is offline on Tailscale`, detail: 'Wake it or sign it in to Tailscale, then retry.' });

    const startedAt = Date.now();
    const result = await dependencies.probeWorkspace({ name: profile.tailnetMachine, dnsName: peer.dnsName, ip: peer.ip }, profile.token || undefined);
    set('reachable', { metric: `${Date.now() - startedAt} ms` });
    if (result.kind === 'unreachable') {
      const alias = peer.os === 'macOS' ? await matchingSshHost(profile, dependencies) : null;
      if (alias) outcome.hostFixes.set('running', { alias, command: HOST_FIX_COMMANDS.openPaneOnMac });
      return fail('running', 'pane_not_running', {
        label: `Pane is not open on ${host}`,
        ...(alias ? { fix: { kind: 'run-on-host', label: 'Start it', command: HOST_FIX_COMMANDS.openPaneOnMac } } : { detail: `Open Pane on ${host}, then retry.` }),
      });
    }
    set('running', {});
    if (result.kind === 'password-required') {
      return fail('signed-in', 'password_required', { label: `${host} needs a password`, fix: { kind: 'enter-password', label: 'Enter password' } });
    }
    if (result.kind === 'refused') {
      return fail('signed-in', 'owner_only', { label: `Only ${host}'s owner can connect`, detail: 'Ask them to allow everyone on the tailnet.' });
    }
    set('signed-in', {});
    if (result.kind === 'described') outcome.hostVersion = result.description.paneVersion;
    return outcome;
  }

  set('reachable', { status: 'running' });
  const health = await probes.checkHealth();
  if (health.kind === 'unreachable') {
    return fail('reachable', 'host_unreachable', {
      label: `Can't reach ${host}`,
      detail: `Tried ${outcome.address} (${health.detail}). Check that both computers are on the same network or tailnet.`,
    });
  }
  set('reachable', { metric: `${health.elapsedMs} ms` });
  if (health.kind === 'not-running') {
    const fix = await hostFix(profile, dependencies, HOST_FIX_COMMANDS.startDaemon, 'Start it');
    if (fix.target) outcome.hostFixes.set('running', fix.target);
    return fail('running', 'pane_not_running', { label: `Pane daemon not running on ${host}`, ...fix.row });
  }
  set('running', {});
  set('signed-in', { status: 'running' });
  if (await probes.checkSignIn() === 'rejected') {
    return fail('signed-in', 'sign_in_rejected', { label: `${host} rejected this computer's sign-in`, fix: { kind: 'paste-code', label: 'Paste new code' } });
  }
  set('signed-in', {});
  return outcome;
}

/**
 * The version row, from the host's ready event. A host older than this field reports none; it
 * predates this check, so it is older than this app.
 */
export async function versionRow(
  profile: RemotePaneConnectionProfile,
  hostVersion: string | null,
  appVersion: string,
  dependencies: Pick<ConnectionCheckDependencies, 'listSshHosts'>,
): Promise<{ row: RemoteConnectionCheckRow; target: { alias: string; command: string } | null }> {
  const host = profile.label;
  const order = hostVersion ? compareVersions(hostVersion, appVersion) : -1;
  if (order === 0) return { row: { stage: 'version', status: 'passed', label: 'Versions match', metric: appVersion }, target: null };
  if (order > 0) {
    return {
      row: { stage: 'version', status: 'warning', label: `This Pane is older than ${host} (${hostVersion})`, fix: { kind: 'update-pane', label: 'Update Pane' } },
      target: null,
    };
  }
  const command = profile.tailnetMachine ? HOST_FIX_COMMANDS.updatePane : HOST_FIX_COMMANDS.updateDaemon;
  const fix = await hostFix(profile, dependencies, command, 'Update it');
  return {
    row: { stage: 'version', status: 'warning', label: `${host} runs an older Pane (${hostVersion ?? 'version unknown'})`, ...fix.row },
    target: fix.target,
  };
}

/** "Start it" or "Update it" when exactly one SSH host matches; otherwise the command to copy. */
async function hostFix(
  profile: RemotePaneConnectionProfile,
  dependencies: Pick<ConnectionCheckDependencies, 'listSshHosts'>,
  command: string,
  actLabel: string,
): Promise<{ row: Pick<RemoteConnectionCheckRow, 'fix' | 'detail'>; target: { alias: string; command: string } | null }> {
  const alias = await matchingSshHost(profile, dependencies);
  if (alias) return { row: { fix: { kind: 'run-on-host', label: actLabel, command } }, target: { alias, command } };
  return { row: copyCommandRow(profile, command), target: null };
}

export function copyCommandRow(profile: RemotePaneConnectionProfile, command: string, why?: string): Pick<RemoteConnectionCheckRow, 'fix' | 'detail'> {
  const fix: RemoteConnectionCheckFix = { kind: 'copy-command', label: 'Copy command', command };
  return { fix, detail: `${why ? `${why} ` : ''}Run this on ${profile.label}: ${command}` };
}

/**
 * The one Host alias in the user's SSH config named like this host: the Tailscale machine name, or
 * the first label of the host name. None, or more than one, means Pane does not guess.
 */
async function matchingSshHost(
  profile: RemotePaneConnectionProfile,
  dependencies: Pick<ConnectionCheckDependencies, 'listSshHosts'>,
): Promise<string | null> {
  const name = profile.tailnetMachine ?? hostNameLabel(profile.baseUrl);
  if (!name) return null;
  const matches = (await dependencies.listSshHosts().catch(() => [])).filter((alias) => alias.toLowerCase() === name.toLowerCase());
  return matches.length === 1 ? matches[0] : null;
}

function hostNameLabel(baseUrl: string): string | null {
  let hostname: string;
  try {
    hostname = new URL(baseUrl).hostname.replace(/^\[(.*)]$/, '$1');
  } catch {
    return null;
  }
  if (isIP(hostname) !== 0 || hostname === 'localhost') return null;
  return hostname.split('.')[0] || null;
}

/** Numeric dotted-version order; prerelease suffixes are ignored. */
function compareVersions(left: string, right: string): number {
  const parts = (version: string) => version.replace(/^v/, '').split(/[-+]/)[0].split('.').map((part) => Number.parseInt(part, 10) || 0);
  const [a, b] = [parts(left), parts(right)];
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference !== 0) return Math.sign(difference);
  }
  return 0;
}

/**
 * Runs a fixed command on an SSH host from the user's own config. BatchMode makes ssh fail rather
 * than ask for a password or a host key; the remote login shell puts npx on PATH.
 */
export function runSshCommand(alias: string, command: string): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile('ssh', [
      '-o', 'BatchMode=yes',
      '-o', `ConnectTimeout=${SSH_CONNECT_TIMEOUT_S}`,
      alias,
      `"$SHELL" -lc '${command}'`,
    ], { timeout: SSH_FIX_TIMEOUT_MS, windowsHide: true }, (error, _stdout, stderr) => {
      if (!error) { resolve(); return; }
      const lastLine = String(stderr).trim().split(/\r?\n/).filter(Boolean).pop();
      reject(new Error(lastLine ?? (error.killed ? 'ssh timed out' : error.message)));
    });
  });
}

function withoutUndefined(row: Partial<RemoteConnectionCheckRow>): Partial<RemoteConnectionCheckRow> {
  return Object.fromEntries(Object.entries(row).filter(([, value]) => value !== undefined));
}
