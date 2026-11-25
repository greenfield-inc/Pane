import { boundary, type BoundarySchema } from '../validation/boundaryDecoder';

/** What a paired device may do: watch, or everything. Records and answers hold only `read`; absent means full access. */
export type DeviceAccess = 'read' | 'full';

/** `access` on records, routes and answers: `read`, or absent for full access. */
export type ReadOnlyMark = 'read';

export const readOnlyMarkSchema: BoundarySchema<ReadOnlyMark> = boundary.literal('read');

/** A host refuses a read-only device with this code; nothing was run or changed. */
export const READ_ONLY_ACCESS_CODE = 'ERR_READ_ONLY_ACCESS';

export const DEVICE_ACCESS_LABELS = {
  full: 'Full access',
  read: 'Read only',
} as const satisfies Record<DeviceAccess, string>;

export const READ_ONLY_GRANT_HELP = 'Sees your Sessions, agents, transcripts and terminal output. Can’t type, run, approve, open files or see your keys.';
export const READ_ONLY_GRANT_WARNING = 'They will see everything your agents and terminals print, including any key or password that appears on screen.';
