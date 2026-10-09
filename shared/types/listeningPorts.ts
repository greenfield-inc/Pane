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
}

export interface ListeningPortsSnapshot {
  /** The host machine's name, for "Ports on <host>". */
  host: string;
  /** Sorted by group order, then port. */
  ports: ListeningPort[];
}
