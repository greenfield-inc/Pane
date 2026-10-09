import { boundary, decodeOptionalBoundary } from '../validation/boundaryDecoder';
import type { BoundarySchema } from '../validation/boundaryDecoder';

/**
 * Who opened a listening port, in the order the Ports list shows the groups:
 * a process started in a Pane terminal, any other app, an OS service, or Pane
 * itself.
 */
export type ListeningPortGroup = 'pane-terminal' | 'other' | 'system' | 'pane';

export const LISTENING_PORT_GROUP_ORDER: readonly ListeningPortGroup[] = ['pane-terminal', 'other', 'system', 'pane'];

/** `web` answered an HTTP request when first seen; `tcp` did not. */
export type ListeningPortKind = 'web' | 'tcp';

export interface ListeningPort {
  port: number;
  /** Null when the OS hides the owner, as it does for another user's process. */
  pid: number | null;
  process: string;
  group: ListeningPortGroup;
  kind: ListeningPortKind;
  /** The Pane whose terminal started the process, for `pane-terminal` ports. */
  sessionId?: string;
  paneName?: string;
  /** The HTTPS address phones open this web port at; absent until its Serve handler exists. */
  phoneUrl?: string;
  /**
   * Where a remote desktop reaches this host port on its own loopback: the same number when it
   * was free there, otherwise another. Set only by a desktop connected to a remote host.
   */
  localPort?: number;
}

/** Whether phones can open pages from this host, and where its HTML files and media are served. */
export type PhonePreviewStatus =
  | { state: 'on'; filesUrl: string }
  | { state: 'off'; reason: string };

export interface ListeningPortsSnapshot {
  /** The host machine's name, for "Ports on <host>". */
  host: string;
  /** Sorted by group order, then port. */
  ports: ListeningPort[];
  phone?: PhonePreviewStatus;
  /**
   * Set by a remote desktop when its host is too old to list ports: nothing is tunnelled, and
   * loopback URLs open this computer's own ports.
   */
  unsupportedHost?: true;
}

const listeningPortsSnapshotSchema: BoundarySchema<ListeningPortsSnapshot> = boundary.object({
  host: boundary.string,
  ports: boundary.array(boundary.object({
    port: boundary.number,
    pid: boundary.nullable(boundary.number),
    process: boundary.string,
    group: boundary.enumeration(...LISTENING_PORT_GROUP_ORDER),
    kind: boundary.enumeration('web', 'tcp'),
    sessionId: boundary.optional(boundary.string),
    paneName: boundary.optional(boundary.string),
    localPort: boundary.optional(boundary.number),
  })),
  unsupportedHost: boundary.optional(boundary.literal(true)),
});

/** A Ports list that crossed a process or network boundary, or null when it has another shape. */
export function decodeListeningPortsSnapshot<Value>(value: Value): ListeningPortsSnapshot | null {
  return decodeOptionalBoundary(value, listeningPortsSnapshotSchema) ?? null;
}
