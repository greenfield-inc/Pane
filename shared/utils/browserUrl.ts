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
