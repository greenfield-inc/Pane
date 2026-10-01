import fs from 'fs';
import os from 'os';
import path from 'path';
import { boundary, decodeBoundary, decodeOptionalBoundary } from '../../../../../shared/validation/boundaryDecoder';
import type { SessionPortScheme, SessionPortSource } from '../../../../../shared/types/sessionPorts';

/** The Session's published ports: the truth the boot/wake reconcile re-applies to Tailscale Serve. */
export function defaultPortsStatePath(): string {
  return path.join(os.homedir(), '.runpane-cloud', 'ports.json');
}

export interface StoredPort {
  name: string;
  port: number;
  httpsPort: number;
  scheme: SessionPortScheme;
  path: string;
  source: SessionPortSource;
  repo?: string;
  createdAt: string;
  /** Why the port is http. */
  detail?: string;
  /** A manifest port waiting for another Serve entry to leave its tailnet port. */
  blockedBy?: string;
}

export interface PortsState {
  version: 1;
  autoOpen: boolean;
  ports: StoredPort[];
  /** `<repo>#<name>` of manifest ports someone closed: the manifest does not reopen them. */
  dismissed: string[];
}

const storedPortSchema = boundary.object({
  name: boundary.string,
  port: boundary.number,
  httpsPort: boundary.number,
  scheme: boundary.enumeration('https', 'http'),
  path: boundary.string,
  source: boundary.enumeration('user', 'manifest', 'auto'),
  repo: boundary.optional(boundary.string),
  createdAt: boundary.string,
  detail: boundary.optional(boundary.string),
  blockedBy: boundary.optional(boundary.string),
});

const stateSchema = boundary.object({
  version: boundary.literal(1),
  autoOpen: boundary.optional(boundary.boolean),
  ports: boundary.array(storedPortSchema),
  dismissed: boundary.optional(boundary.array(boundary.string)),
});

export function emptyPortsState(): PortsState {
  return { version: 1, autoOpen: false, ports: [], dismissed: [] };
}

export function manifestKey(repo: string, name: string): string {
  return `${repo}#${name}`;
}

/**
 * The state file exists but cannot be read or decoded. Nothing writes over it: Pane changes no ports
 * until someone repairs or removes the file, so the published ports it held can still be recovered.
 */
export class PortsStateError extends Error {
  constructor(readonly file: string, reason: string) {
    super(`${file} is unreadable (${reason}); Pane keeps it as is and changes no ports until it is repaired or removed`);
    this.name = 'PortsStateError';
  }
}

const errnoSchema = boundary.object({ code: boundary.string });

/** Only a missing file is an empty state; any other read, JSON or schema failure throws PortsStateError. */
export function readPortsState(file: string): PortsState {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (decodeOptionalBoundary(error, errnoSchema)?.code === 'ENOENT') return emptyPortsState();
    throw new PortsStateError(file, error instanceof Error ? error.message : String(error));
  }
  try {
    const state = decodeBoundary(JSON.parse(text), stateSchema);
    return {
      version: 1,
      autoOpen: state.autoOpen ?? false,
      ports: state.ports.map(port => ({ ...port })),
      dismissed: state.dismissed ?? [],
    };
  } catch (error) {
    throw new PortsStateError(file, error instanceof Error ? error.message : String(error));
  }
}

/** Written to a 0600 temp file in the 0700 directory, then renamed over, so a power-off never leaves half a file. */
export function writePortsState(file: string, state: PortsState): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${process.pid}.tmp`;
  const handle = fs.openSync(temp, 'w', 0o600);
  try {
    fs.writeSync(handle, `${JSON.stringify(state, null, 2)}\n`);
    fs.fsyncSync(handle);
  } finally {
    fs.closeSync(handle);
  }
  fs.chmodSync(temp, 0o600);
  fs.renameSync(temp, file);
}
