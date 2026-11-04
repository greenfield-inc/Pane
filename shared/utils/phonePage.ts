import type { ListeningPortsSnapshot } from '../types/listeningPorts';

/**
 * What a phone browser tab shows for a panel's saved, host-relative URL. `address` is what the
 * address bar reads; `host` is set for pages that live on the host, for its "on <host>" marker.
 */
export type PhonePage =
  | { kind: 'frame'; src: string; address: string; host?: string }
  | {
    kind: 'unavailable'; address: string; host: string; reason: string;
    /** Why, for a client that draws each case its own way. */
    cause: PhoneUnavailableCause;
    /** The host-relative port, for `refused`, `not-web` and `starting`. */
    port?: number;
    /** The host's own reason phone pages are off, for `pages-off`. */
    offReason?: string;
    /** Ask the host for this port's phone address. */
    request?: number;
  };

type UnavailablePage = Extract<PhonePage, { kind: 'unavailable' }>;

/**
 * `invalid`: the saved address is not a URL. `reading`: the host's ports are not read yet. `pages-off`: the host serves no phone pages.
 * `refused`: nothing listens on the port. `not-web`: the port does not answer HTTP.
 * `starting`: the host is giving the port a phone address.
 */
export type PhoneUnavailableCause = 'invalid' | 'reading' | 'pages-off' | 'refused' | 'not-web' | 'starting';

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '0.0.0.0']);

/**
 * Maps a browser panel's URL to what the phone loads: a host dev server to its port's phone
 * address, a host HTML file to the files address, and anything else as it is.
 */
export function phonePage(url: string, ports: ListeningPortsSnapshot | null, panelId: string): PhonePage {
  const parsed = new URL(url);
  const host = ports?.host ?? 'the host';
  const unavailable = (address: string, reason: string, cause: PhoneUnavailableCause, port?: number): UnavailablePage => {
    const page: UnavailablePage = { kind: 'unavailable', address, host, reason, cause };
    if (port !== undefined) page.port = port;
    return page;
  };
  const off = (address: string): UnavailablePage => ports
    ? { ...unavailable(address, offReason(ports), 'pages-off'), offReason: ports.phone?.state === 'off' ? ports.phone.reason : 'starting' }
    : unavailable(address, offReason(ports), 'reading');

  if (parsed.protocol === 'file:') {
    const name = parsed.pathname.slice(parsed.pathname.lastIndexOf('/') + 1);
    const address = decodeURIComponent(name);
    if (ports?.phone?.state !== 'on') return off(address);
    return { kind: 'frame', src: `${ports.phone.filesUrl}/file/${encodeURIComponent(panelId)}/${name}${parsed.search}${parsed.hash}`, address, host };
  }

  if (!LOOPBACK_HOSTS.has(parsed.hostname)) return { kind: 'frame', src: parsed.href, address: url };

  const port = Number(parsed.port || (parsed.protocol === 'https:' ? 443 : 80));
  const path = `${parsed.pathname}${parsed.search}${parsed.hash}`;
  const address = `localhost:${port}${path}`;
  if (ports?.phone?.state !== 'on') return off(address);
  const listening = ports.ports.find(candidate => candidate.port === port);
  if (!listening) return unavailable(address, `Nothing on ${host} listens on port ${port}.`, 'refused', port);
  if (listening.kind !== 'web') return unavailable(address, `localhost:${port} does not answer HTTP, so it opens only on desktops.`, 'not-web', port);
  if (!listening.phoneUrl) return { ...unavailable(address, `Pane is giving localhost:${port} a phone address…`, 'starting', port), request: port };
  return { kind: 'frame', src: `${listening.phoneUrl}${path}`, address, host };
}

/**
 * Where a phone loads a worktree file for preview: the files address, which streams it with Range
 * support. `filePath` is relative to the pane's worktree, in either separator.
 */
export function phoneMediaUrl(filePath: string, ports: ListeningPortsSnapshot | null, sessionId: string): { url: string } | { reason: string } {
  if (ports?.phone?.state !== 'on') return { reason: offReason(ports) };
  const path = filePath.split(/[\\/]/u).filter(Boolean).map(encodeURIComponent).join('/');
  return { url: `${ports.phone.filesUrl}/media/${encodeURIComponent(sessionId)}/${path}` };
}

function offReason(ports: ListeningPortsSnapshot | null): string {
  if (!ports) return 'Reading the host\'s ports…';
  const reason = ports.phone?.state === 'off' ? ports.phone.reason : 'starting';
  return `Phone pages from ${ports.host} are unavailable right now (${reason}). Pane checks again every minute.`;
}
