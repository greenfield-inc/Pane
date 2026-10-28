import {
  encodeGlassesPairingCode,
  GLASSES_COMMANDS,
  type GlassesDevice,
  type GlassesListResult,
  type GlassesPairingComputer,
  type GlassesPairingSecretResult,
} from '@shared/types/glasses';
import { RemoteRequestError } from '@shared/remoteClient';
import type { RemotePaneConnectionProfile } from '@shared/types/remoteDaemon';
import type { TailnetMachine } from '@shared/types/workspaceAccess';
import { boundary, decodeBoundary, type BoundarySchema } from '@shared/validation/boundaryDecoder';

import { codelessProfile } from '@/auth/computers';

/** A computer on this phone's Tailscale login and the profile that reaches it, with its password when saved. */
export interface GlassesComputer {
  machine: TailnetMachine;
  profile: RemotePaneConnectionProfile;
}

/** Calls one channel on one computer and returns its decoded result. */
export type GlassesInvoke = (profile: RemotePaneConnectionProfile, channel: string, args: unknown[]) => Promise<unknown>;

export interface GlassesSkip {
  name: string;
  reason: string;
}

const secretSchema: BoundarySchema<GlassesPairingSecretResult> = boundary.object({
  secret: boundary.nonEmptyString,
  expiresAt: boundary.nonEmptyString,
});
const listSchema: BoundarySchema<GlassesListResult> = boundary.object({
  devices: boundary.array(boundary.object({
    id: boundary.nonEmptyString,
    label: boundary.nonEmptyString,
    createdAt: boundary.nonEmptyString,
    lastUsedAt: boundary.optional(boundary.nonEmptyString),
  })),
});

/** What the glasses are called on every computer, such as "Even G2 · Parsa's iPhone". */
export function glassesDeviceName(phoneName: string | undefined, platform: 'ios' | 'android'): string {
  return `Even G2 · ${phoneName?.trim() || (platform === 'ios' ? 'iPhone' : 'Android phone')}`;
}

/**
 * The computers the glasses can pair with: yours, with Pane answering, and reachable with what
 * this phone has saved. A saved connection's password is reused; the rest are skipped with why.
 */
export function pairableComputers(
  machines: readonly TailnetMachine[],
  domain: string,
  saved: readonly RemotePaneConnectionProfile[],
): { computers: GlassesComputer[]; skipped: GlassesSkip[] } {
  const computers: GlassesComputer[] = [];
  const skipped: GlassesSkip[] = [];
  for (const machine of machines) {
    if (!machine.mine) continue;
    const savedProfile = saved.find(profile => profile.tailnetMachine === machine.name && profile.tailnetDomain === domain);
    if (machine.state === 'available' || (machine.state === 'password-required' && savedProfile?.token)) {
      computers.push({ machine, profile: savedProfile ?? codelessProfile(machine, domain) });
    } else if (machine.state === 'password-required') {
      skipped.push({ name: machine.name, reason: 'needs its password; connect to it once in Your Computers' });
    } else if (machine.state === 'outdated') {
      skipped.push({ name: machine.name, reason: 'update Pane there' });
    } else {
      skipped.push({ name: machine.name, reason: 'offline' });
    }
  }
  return { computers, skipped };
}

/**
 * Asks each computer for a single-use pairing secret and packs them into one code that expires
 * with the first secret. Device tokens never pass through the phone: the glasses trade each
 * secret themselves. Returns null for the code when no computer answered.
 */
export async function createGlassesPairingCode(
  computers: readonly GlassesComputer[],
  deviceName: string,
  invoke: GlassesInvoke,
): Promise<{ code: string | null; expiresAt: string | null; paired: string[]; skipped: GlassesSkip[] }> {
  const entries: { entry: GlassesPairingComputer; expiresAt: string }[] = [];
  const skipped: GlassesSkip[] = [];
  await Promise.all(computers.map(async ({ machine, profile }) => {
    try {
      const minted = decodeBoundary(await invoke(profile, GLASSES_COMMANDS.createPairingSecret, [{ deviceName }]), secretSchema);
      entries.push({ entry: { name: machine.name, url: machine.url, secret: minted.secret }, expiresAt: minted.expiresAt });
    } catch (cause) {
      skipped.push({ name: machine.name, reason: isOlderPane(cause) ? OLDER_PANE : reasonOf(cause) });
    }
  }));
  const [expiresAt] = entries.map(entry => entry.expiresAt).sort();
  if (!expiresAt) return { code: null, expiresAt: null, paired: [], skipped };
  entries.sort((left, right) => left.entry.name.localeCompare(right.entry.name));
  return {
    code: encodeGlassesPairingCode({ v: 1, expiresAt, computers: entries.map(entry => entry.entry) }),
    expiresAt,
    paired: entries.map(entry => entry.entry.name),
    skipped,
  };
}

/** These glasses on each computer; `problem` says why a computer could not be asked. */
export async function listGlassesOnComputers(
  computers: readonly GlassesComputer[],
  deviceName: string,
  invoke: GlassesInvoke,
): Promise<{ name: string; device: GlassesDevice | null; problem: string | null }[]> {
  return Promise.all(computers.map(async ({ machine, profile }) => {
    try {
      const { devices } = decodeBoundary(await invoke(profile, GLASSES_COMMANDS.list, []), listSchema);
      return { name: machine.name, device: devices.find(device => device.label === deviceName) ?? null, problem: null };
    } catch (cause) {
      return { name: machine.name, device: null, problem: isOlderPane(cause) ? OLDER_PANE : 'not answering' };
    }
  }));
}

/**
 * Revokes these glasses on every computer that answers. The names it could not reach come back
 * as pending, to retry when they are next reachable; each computer's own Settings also revokes.
 */
export async function revokeGlassesOnComputers(
  computers: readonly GlassesComputer[],
  pending: readonly string[],
  deviceName: string,
  invoke: GlassesInvoke,
): Promise<{ revoked: string[]; pending: string[] }> {
  const revoked: string[] = [];
  const stillPending = new Set(pending);
  await Promise.all(computers.map(async ({ machine, profile }) => {
    try {
      const { devices } = decodeBoundary(await invoke(profile, GLASSES_COMMANDS.list, []), listSchema);
      for (const device of devices.filter(candidate => candidate.label === deviceName)) {
        await invoke(profile, GLASSES_COMMANDS.revoke, [{ id: device.id }]);
      }
      revoked.push(machine.name);
      stillPending.delete(machine.name);
    } catch (cause) {
      // A Pane without glasses support never held these glasses: nothing is left to revoke there.
      if (isOlderPane(cause)) stillPending.delete(machine.name);
      else stillPending.add(machine.name);
    }
  }));
  return { revoked: revoked.sort(), pending: [...stillPending].sort() };
}

const OLDER_PANE = 'update Pane there to use glasses';

/** The computer's Pane predates glasses: it doesn't know the glasses commands. */
function isOlderPane(cause: unknown): boolean {
  return cause instanceof RemoteRequestError && cause.code === 'ERR_UNKNOWN_CHANNEL';
}

function reasonOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : 'did not answer';
}
