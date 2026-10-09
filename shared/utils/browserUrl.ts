import type { ListeningPortsSnapshot } from '../types/listeningPorts';

/** Match the browser's URL parser, including scheme casing and whitespace. */
export function hasFileProtocol(value: string | undefined): boolean {
  if (!value) return false;
  try {
    return new URL(value).protocol === 'file:';
  } catch {
    return false;
  }
}

const LOOPBACK_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]']);

/** The port an http(s) URL points at on loopback, if it does. */
export function loopbackPortOf(url: string): number | null {
  try {
    const parsed = new URL(url);
    if (!['http:', 'https:'].includes(parsed.protocol) || !LOOPBACK_HOSTNAMES.has(parsed.hostname)) return null;
    return Number.parseInt(parsed.port || (parsed.protocol === 'https:' ? '443' : '80'), 10);
  } catch {
    return null;
  }
}

/**
 * Moves a loopback URL to the port `ports` maps its port to. A remote desktop uses it both
 * ways: host port to where it reaches that port here, and back. Any other URL is unchanged.
 */
export function remapLoopbackPort(url: string, ports: ReadonlyMap<number, number>): string {
  const port = loopbackPortOf(url);
  const mapped = port === null ? undefined : ports.get(port);
  if (mapped === undefined || mapped === port) return url;
  const parsed = new URL(url);
  parsed.port = String(mapped);
  return parsed.toString();
}

/** Where a remote desktop loads a host URL. */
export type LocalTarget =
  | { kind: 'load'; url: string }
  /** The host's Ports list is not known yet. */
  | { kind: 'waiting' }
  /** A host loopback port with no tunnel here; `listed` when the host still lists it. */
  | { kind: 'unreachable'; port: number; listed: boolean };

/**
 * Resolves a host URL against the Ports list a remote desktop received (null while unknown).
 * A tunnelled port loads at its local number. Any other host loopback port is unreachable, so the
 * desktop never loads its own service in the host's place. URLs off loopback load as they are.
 */
export function localTargetOf(hostUrl: string, snapshot: ListeningPortsSnapshot | null): LocalTarget {
  const port = loopbackPortOf(hostUrl);
  if (port === null) return { kind: 'load', url: hostUrl };
  if (!snapshot) return { kind: 'waiting' };
  if (snapshot.unsupportedHost) return { kind: 'load', url: hostUrl };
  const listed = snapshot.ports.find(candidate => candidate.port === port);
  if (listed?.localPort === undefined) return { kind: 'unreachable', port, listed: listed !== undefined };
  return { kind: 'load', url: remapLoopbackPort(hostUrl, new Map([[port, listed.localPort]])) };
}
