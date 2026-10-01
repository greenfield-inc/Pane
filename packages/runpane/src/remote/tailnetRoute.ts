// Mirrors main/src/daemon/client/tailnetRoute.ts (packages/runpane cannot import main/ or shared/).
import dns, { type LookupAddress } from 'node:dns';
import { isIP, type LookupFunction } from 'node:net';
import os from 'node:os';

/**
 * A plain-HTTP request carries its bearer token in clear. Remote profiles accept `http://` for tailnet
 * hosts (*.ts.net, 100.64.0.0/10, fd7a:115c:a1e0::/48) because WireGuard encrypts tailnet traffic, but
 * only while the traffic really goes through Tailscale: 100.64.0.0/10 is also carrier-grade NAT space,
 * and a *.ts.net name is only as good as the resolver that answers it. So a token leaves over `http:`
 * only to this machine (loopback) or to a Tailscale address while this machine is on a tailnet (a
 * Tailscale interface carries a Tailscale address). A name is checked in the connection's own lookup,
 * so nothing re-resolves between the check and the connect.
 */

const PLAIN_HTTP_OFF_TAILNET_CODE = 'ERR_PLAIN_HTTP_OFF_TAILNET';

/** Tailscale's interface names: tailscale0 (Linux), utunN (macOS), "Tailscale" (Windows). */
const TAILSCALE_INTERFACE = /^(tailscale.*|utun\d+)$/iu;
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);

type NetworkInterfaces = ReturnType<typeof os.networkInterfaces>;

export class TailnetRouteError extends Error {
  override name = 'TailnetRouteError';
  readonly code = PLAIN_HTTP_OFF_TAILNET_CODE;
}

function unbracket(address: string): string {
  return address.trim().toLowerCase().replace(/^\[(.*)\]$/u, '$1');
}

/** 100.64.0.0/10 and fd7a:115c:a1e0::/48. */
export function isTailscaleAddress(address: string): boolean {
  const normalized = unbracket(address);
  const ipv4 = /^100\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/u.exec(normalized);
  if (ipv4) {
    const [second, third, fourth] = [Number(ipv4[1]), Number(ipv4[2]), Number(ipv4[3])];
    return second >= 64 && second <= 127 && third <= 255 && fourth <= 255;
  }
  return isIP(normalized) === 6 && normalized.startsWith('fd7a:115c:a1e0:');
}

function isLoopbackAddress(address: string): boolean {
  const normalized = unbracket(address);
  return normalized === '::1' || (isIP(normalized) === 4 && normalized.startsWith('127.'));
}

/** Whether a Tailscale interface on this machine carries a Tailscale address (Tailscale is up). */
export function hasLocalTailnetInterface(interfaces: NetworkInterfaces = os.networkInterfaces()): boolean {
  return Object.entries(interfaces).some(([name, addresses]) => (
    TAILSCALE_INTERFACE.test(name) && (addresses ?? []).some((entry) => isTailscaleAddress(entry.address))
  ));
}

/** True for a plain-HTTP request to anything but a loopback name or address. */
export function needsTailnetRoute(url: URL): boolean {
  return url.protocol === 'http:' && !LOOPBACK_HOSTS.has(unbracket(url.hostname));
}

const notOnTailnet = (target: string) => new TailnetRouteError(
  `Refusing to send a token over plain HTTP to ${target}: this machine is not on a tailnet (Tailscale is off or not `
    + 'connected), so the request would leave unencrypted. Connect Tailscale, or use the host\'s https address.',
);

/** Why a plain-HTTP request may not go to these addresses, or null when it may. */
function routeProblem(target: string, addresses: readonly string[], interfaces: () => NetworkInterfaces): TailnetRouteError | null {
  const outside = addresses.filter((address) => !isTailscaleAddress(address) && !isLoopbackAddress(address));
  if (addresses.length === 0 || outside.length > 0) {
    return new TailnetRouteError(
      `Refusing to send a token over plain HTTP to ${target}: ${outside.join(', ') || 'no address'} is not a Tailscale address. `
        + 'Check this machine\'s DNS (MagicDNS), or use the host\'s https address.',
    );
  }
  const leavesThisMachine = addresses.some((address) => !isLoopbackAddress(address));
  return leavesThisMachine && !hasLocalTailnetInterface(interfaces()) ? notOnTailnet(target) : null;
}

/** Throws TailnetRouteError for a plain-HTTP address literal outside the rules; a name is left to `tailnetOnlyLookup`. */
export function assertTailnetRoute(url: URL, interfaces: () => NetworkInterfaces = () => os.networkInterfaces()): void {
  if (!needsTailnetRoute(url)) return;
  const host = unbracket(url.hostname);
  if (isIP(host) === 0) return;
  const problem = routeProblem(url.host, [host], interfaces);
  if (problem) throw problem;
}

/** A connection lookup that hands out a name's addresses only when every one of them passes the rules. */
export function tailnetOnlyLookup(
  baseLookup: LookupFunction = dns.lookup,
  interfaces: () => NetworkInterfaces = () => os.networkInterfaces(),
): LookupFunction {
  return (hostname, options, callback) => {
    baseLookup(hostname, { ...options, all: true }, (error, result) => {
      if (error) {
        callback(error, '', 0);
        return;
      }
      const addresses: LookupAddress[] = Array.isArray(result) ? result : [{ address: result, family: isIP(result) }];
      const problem = routeProblem(hostname, addresses.map((entry) => entry.address), interfaces);
      if (problem) {
        callback(problem, '', 0);
        return;
      }
      if (options.all === true) {
        callback(null, addresses);
        return;
      }
      callback(null, addresses[0].address, addresses[0].family);
    });
  };
}
