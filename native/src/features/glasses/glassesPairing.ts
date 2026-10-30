import { glassesListSchema, isOlderPane } from '@shared/glassesRevoke';
import {
  encodeGlassesPairingCode,
  GLASSES_COMMANDS,
  type GlassesDevice,
  type GlassesPairingComputer,
  type GlassesPairingSecretResult,
} from '@shared/types/glasses';
import type { RemotePaneConnectionProfile } from '@shared/types/remoteDaemon';
import type { TailnetMachine } from '@shared/types/workspaceAccess';
import { boundary, decodeBoundary, type BoundarySchema, type JsonValue } from '@shared/validation/boundaryDecoder';

import { codelessProfile } from '@/auth/computers';

/** A computer on this phone's Tailscale login and the profile that reaches it, with its password when saved. */
export interface GlassesComputer {
  machine: TailnetMachine;
  profile: RemotePaneConnectionProfile;
}

/** Calls one channel on one computer and returns its decoded result. */
export type GlassesInvoke = (profile: RemotePaneConnectionProfile, channel: string, args: unknown[]) => Promise<JsonValue | undefined>;

export interface GlassesSkip {
  name: string;
  /** The computer's full name, unique across tailnets, such as "devbox.tail1234.ts.net". */
  dnsName: string;
  reason: string;
}

/** This phone: the name the glasses are shown by, and its install id, which finds them again. */
export interface GlassesPhone {
  name: string;
  id: string;
}

const secretSchema: BoundarySchema<GlassesPairingSecretResult> = boundary.object({
  secret: boundary.nonEmptyString,
  expiresAt: boundary.nonEmptyString,
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
      skipped.push({ name: machine.name, dnsName: machine.dnsName, reason: 'needs its password; connect to it once in Your Computers' });
    } else if (machine.state === 'outdated') {
      skipped.push({ name: machine.name, dnsName: machine.dnsName, reason: 'update Pane there' });
    } else {
      skipped.push({ name: machine.name, dnsName: machine.dnsName, reason: 'offline' });
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
  phone: GlassesPhone,
  invoke: GlassesInvoke,
): Promise<{ code: string | null; expiresAt: string | null; paired: string[]; skipped: GlassesSkip[] }> {
  const entries: { entry: GlassesPairingComputer; expiresAt: string }[] = [];
  const skipped: GlassesSkip[] = [];
  await Promise.all(computers.map(async ({ machine, profile }) => {
    try {
      const minted = decodeBoundary(await invoke(profile, GLASSES_COMMANDS.createPairingSecret, [{ deviceName: phone.name, phoneId: phone.id }]), secretSchema);
      entries.push({ entry: { name: machine.name, url: machine.url, secret: minted.secret }, expiresAt: minted.expiresAt });
    } catch (cause) {
      skipped.push({ name: machine.name, dnsName: machine.dnsName, reason: isOlderPane(cause) ? OLDER_PANE : reasonOf(cause) });
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

/** The glasses this phone paired, on each computer; `problem` says why a computer could not be asked. */
export async function listGlassesOnComputers(
  computers: readonly GlassesComputer[],
  phoneId: string,
  invoke: GlassesInvoke,
): Promise<{ name: string; device: GlassesDevice | null; problem: string | null }[]> {
  return Promise.all(computers.map(async ({ machine, profile }) => {
    try {
      const { devices } = decodeBoundary(await invoke(profile, GLASSES_COMMANDS.list, []), glassesListSchema);
      return { name: machine.name, device: devices.find(device => device.phoneId === phoneId) ?? null, problem: null };
    } catch (cause) {
      return { name: machine.name, device: null, problem: isOlderPane(cause) ? OLDER_PANE : 'not answering' };
    }
  }));
}

const OLDER_PANE = 'update Pane there to use glasses';

function reasonOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : 'did not answer';
}
