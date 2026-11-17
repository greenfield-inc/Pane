/**
 * The loopback ports of this machine's device hub. A linked computer may tunnel to them over its
 * signed-in connection to show this machine's devices; the hub still requires its own token.
 */
const ports = new Set<number>();

export function addDeviceHubPort(port: number): void {
  ports.add(port);
}

export function removeDeviceHubPort(port: number): void {
  ports.delete(port);
}

export function isDeviceHubPort(port: number): boolean {
  return ports.has(port);
}
