import type { ListeningPortsSnapshot } from '../../../../shared/types/listeningPorts';

/**
 * What a phone browser tab shows for a panel's saved, host-relative URL. `address` is what the
 * address bar reads; `host` is set for pages that live on the host, for its "on <host>" marker.
 */
export type PhonePage =
  | { kind: 'frame'; src: string; address: string; host?: string }
  | { kind: 'unavailable'; address: string; host: string; reason: string };

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '0.0.0.0']);

/**
 * Maps a browser panel's URL to what the phone loads: a host dev server to its port's phone
 * address, a host HTML file to the files address, and anything else as it is.
 */
export function phonePage(url: string, ports: ListeningPortsSnapshot | null, panelId: string): PhonePage {
  const parsed = new URL(url);
  const host = ports?.host ?? 'the host';
  const unavailable = (address: string, reason: string): PhonePage => ({ kind: 'unavailable', address, host, reason });

  if (parsed.protocol === 'file:') {
    const name = parsed.pathname.slice(parsed.pathname.lastIndexOf('/') + 1);
    const address = decodeURIComponent(name);
    if (ports?.phone?.state !== 'on') return unavailable(address, offReason(ports));
    return { kind: 'frame', src: `${ports.phone.filesUrl}/file/${encodeURIComponent(panelId)}/${name}${parsed.search}${parsed.hash}`, address, host };
  }

  if (!LOOPBACK_HOSTS.has(parsed.hostname)) return { kind: 'frame', src: parsed.href, address: url };

  const port = Number(parsed.port || (parsed.protocol === 'https:' ? 443 : 80));
  const path = `${parsed.pathname}${parsed.search}${parsed.hash}`;
  const address = `localhost:${port}${path}`;
  if (ports?.phone?.state !== 'on') return unavailable(address, offReason(ports));
  const listening = ports.ports.find(candidate => candidate.port === port);
  if (!listening) return unavailable(address, `Nothing on ${host} listens on port ${port}.`);
  if (listening.kind !== 'web') return unavailable(address, `localhost:${port} does not answer HTTP, so it opens only on desktops.`);
  if (!listening.phoneUrl) return unavailable(address, `Pane is still giving localhost:${port} a phone address.`);
  return { kind: 'frame', src: `${listening.phoneUrl}${path}`, address, host };
}

function offReason(ports: ListeningPortsSnapshot | null): string {
  if (!ports) return 'Reading the host\'s ports…';
  const reason = ports.phone?.state === 'off' ? ports.phone.reason : 'it is starting';
  return `Phones open host pages through Tailscale, which is off on ${ports.host}: ${reason}.`;
}
