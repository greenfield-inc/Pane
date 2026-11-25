import { boundary, type BoundarySchema } from '../validation/boundaryDecoder';

/** What a paired device may do: watch, or everything. Records and answers hold only `read`; absent means full access. */
export type DeviceAccess = 'read' | 'full';

/** `access` on a host's records and links: `read`, or absent for full access. */
export type ReadOnlyMark = 'read';

/** A read-only device's token starts with this; no other token does. */
const READ_TOKEN_PREFIX = 'pane_read_';

export function readOnlyToken(random: string): string {
  return `${READ_TOKEN_PREFIX}${random}`;
}

/**
 * The level of the pairing a token is for, from the token alone. A device's level is fixed when it
 * pairs, so nothing the computer says later, and no field an older Pane drops, changes it.
 */
export function tokenAccess(token: string): ReadOnlyMark | undefined {
  return token.startsWith(READ_TOKEN_PREFIX) ? 'read' : undefined;
}

export const readOnlyMarkSchema: BoundarySchema<ReadOnlyMark> = boundary.literal('read');

/** A host refuses a read-only device with this code; nothing was run or changed. */
export const READ_ONLY_ACCESS_CODE = 'ERR_READ_ONLY_ACCESS';

export const DEVICE_ACCESS_LABELS = {
  full: 'Full access',
  read: 'Read only',
} as const satisfies Record<DeviceAccess, string>;

export const READ_ONLY_GRANT_HELP = 'Sees your Sessions, agents, transcripts and terminal output. Can’t type, run, approve, open files or see your keys.';
export const READ_ONLY_GRANT_WARNING = 'They will see everything your agents and terminals print, including any key or password that appears on screen.';
