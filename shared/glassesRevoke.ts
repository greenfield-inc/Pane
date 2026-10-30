import { RemoteRequestError } from './remoteClient/remoteDaemonClient';
import { GLASSES_COMMANDS, type GlassesListResult } from './types/glasses';
import { boundary, decodeBoundary, type BoundarySchema, type JsonValue } from './validation/boundaryDecoder';

/** One of your computers, as the phone or the desktop reaches it. */
export interface GlassesRevokeComputer<Profile> {
  machine: { name: string; dnsName: string };
  profile: Profile;
}

/** Calls one channel on one computer and returns its answer as sent, or throws why it could not. */
export type GlassesRevokeInvoke<Profile> = (profile: Profile, channel: string, args: JsonValue[]) => Promise<JsonValue | undefined>;

export const glassesListSchema: BoundarySchema<GlassesListResult> = boundary.object({
  devices: boundary.array(boundary.object({
    id: boundary.nonEmptyString,
    label: boundary.nonEmptyString,
    phoneId: boundary.optional(boundary.nonEmptyString),
    createdAt: boundary.nonEmptyString,
    lastUsedAt: boundary.optional(boundary.nonEmptyString),
  })),
});

/** The computer's Pane predates glasses: it doesn't know the glasses commands. */
export function isOlderPane(cause: unknown): boolean {
  return cause instanceof RemoteRequestError && cause.code === 'ERR_UNKNOWN_CHANNEL';
}

/**
 * Revokes the glasses one phone paired on every computer that answers, as the owner. Each
 * computer's revoke keeps them off it until the phone pairs them there again. Pending revokes
 * are kept by full DNS name, so a computer of the same name on another tailnet never settles
 * them; the ones that did not answer come back pending, to retry when they are next reachable.
 * A computer whose Pane predates glasses never held them, so it is neither revoked nor pending.
 */
export async function revokeGlassesOnComputers<Profile>(
  computers: readonly GlassesRevokeComputer<Profile>[],
  pending: readonly string[],
  phoneId: string,
  invoke: GlassesRevokeInvoke<Profile>,
): Promise<{ revoked: string[]; pending: string[] }> {
  const revoked: string[] = [];
  const stillPending = new Set(pending);
  await Promise.all(computers.map(async ({ machine, profile }) => {
    try {
      const { devices } = decodeBoundary(await invoke(profile, GLASSES_COMMANDS.list, []), glassesListSchema);
      for (const device of devices.filter(candidate => candidate.phoneId === phoneId)) {
        await invoke(profile, GLASSES_COMMANDS.revoke, [{ id: device.id }]);
      }
      revoked.push(machine.name);
      stillPending.delete(machine.dnsName);
    } catch (cause) {
      if (isOlderPane(cause)) stillPending.delete(machine.dnsName);
      else stillPending.add(machine.dnsName);
    }
  }));
  return { revoked: revoked.sort(), pending: [...stillPending].sort() };
}
