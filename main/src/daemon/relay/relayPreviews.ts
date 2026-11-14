import { createHash, randomBytes, timingSafeEqual } from 'crypto';
import type http from 'http';
import { hostnameOf, singleHeader, type PreviewRoute } from '../previewProxy';
import { filesHost, parseComputerName, portHost } from './computerNames';
import { PaneError } from '../../../../shared/paneError';

const TICKET_TTL_MS = 60_000;
const SESSION_TTL_MS = 12 * 60 * 60_000;
const COOKIE = 'pane_preview';
const TICKET_PARAM = 'pane-ticket';
const MAX_TICKETS = 256;
const MAX_SESSIONS = 1_024;

interface Ticket { hash: Buffer; host: string; clientId: string; expiresAt: number }
interface Session { hash: Buffer; host: string; clientId: string; expiresAt: number }

export interface RelayPreviewOptions {
  id(): string | null;
  domain(): string | null;
  /** Whether a dev-server port may be opened (Pane's forwarded ports). */
  isForwardedPort(port: number): boolean;
  /** Whether the paired client that asked for a ticket still has access. */
  clientActive(clientId: string): boolean;
  now?: () => number;
}

function sha256(value: string): Buffer {
  return createHash('sha256').update(value).digest();
}

/**
 * Previews under a computer's own names (`p<port>.<id>.<D>`, `files.<id>.<D>`). A paired app asks
 * for an address with its token and gets a one-time ticket in the URL; the first request trades it
 * for a cookie on that one name. Without a ticket or cookie every request is refused with 403.
 */
export class RelayPreviews {
  private tickets: Ticket[] = [];
  private sessions: Session[] = [];
  private readonly now: () => number;

  constructor(private readonly options: RelayPreviewOptions) {
    this.now = options.now ?? Date.now;
  }

  /** The address a paired client opens: a dev server's port, or `files` and a path. */
  address(target: { port: number } | { files: string }, clientId: string): string {
    const id = this.options.id();
    const domain = this.options.domain();
    if (!id || !domain) {
      throw new PaneError('ERR_RELAY_NOT_READY', 'Phone access is not ready on this computer yet, so the preview did not open.', 'Try again in a moment.');
    }
    if ('port' in target && !this.options.isForwardedPort(target.port)) {
      throw new PaneError('ERR_RELAY_PREVIEW_PORT', `Nothing on this computer is listening on port ${target.port}, so there is nothing to preview.`, 'Start the dev server, then open the preview again.');
    }
    const host = 'port' in target ? portHost(target.port, id, domain) : filesHost(id, domain);
    const ticket = randomBytes(24).toString('base64url');
    this.prune();
    if (this.tickets.length >= MAX_TICKETS) this.tickets.shift();
    this.tickets.push({ hash: sha256(ticket), host, clientId, expiresAt: this.now() + TICKET_TTL_MS });
    const pathname = 'files' in target ? `/${target.files.replace(/^\/+/u, '')}` : '/';
    return `https://${host}${pathname}${pathname.includes('?') ? '&' : '?'}${TICKET_PARAM}=${ticket}`;
  }

  /** Drops every preview session a removed client opened. */
  revokeClient(clientId: string): void {
    this.sessions = this.sessions.filter((session) => session.clientId !== clientId);
    this.tickets = this.tickets.filter((ticket) => ticket.clientId !== clientId);
  }

  route = (request: http.IncomingMessage): PreviewRoute => {
    const forbidden: PreviewRoute = { kind: 'refused', status: 403, body: 'Forbidden' };
    const id = this.options.id();
    const domain = this.options.domain();
    const forwardedHost = singleHeader(request.headers.host);
    const host = hostnameOf(forwardedHost);
    const name = id && domain ? parseComputerName(host, id, domain) : null;
    if (!name || name.kind === 'server') return forbidden;
    this.prune();
    const url = new URL(request.url ?? '/', `https://${host}`);
    const ticket = url.searchParams.get(TICKET_PARAM);
    if (ticket) {
      const presented = sha256(ticket);
      const index = this.tickets.findIndex((candidate) => candidate.host === host && timingSafeEqual(candidate.hash, presented));
      if (index === -1) return forbidden;
      const [used] = this.tickets.splice(index, 1);
      if (!this.options.clientActive(used.clientId)) return forbidden;
      const session = randomBytes(24).toString('base64url');
      if (this.sessions.length >= MAX_SESSIONS) this.sessions.shift();
      this.sessions.push({ hash: sha256(session), host, clientId: used.clientId, expiresAt: this.now() + SESSION_TTL_MS });
      url.searchParams.delete(TICKET_PARAM);
      return {
        kind: 'redirect',
        location: `${url.pathname}${url.search}`,
        // SameSite=None: the browser app shows previews in an iframe on its own origin, a third-party context.
        setCookie: `${COOKIE}=${session}; Path=/; Secure; HttpOnly; SameSite=None; Max-Age=${SESSION_TTL_MS / 1000}`,
      };
    }
    // Until the domain is on the Public Suffix List, a sibling name can set a parent-domain cookie of
    // the same name, which the browser may send first; any matching value counts.
    const presented = readCookies(singleHeader(request.headers.cookie), COOKIE).map(sha256);
    const session = this.sessions.find((candidate) => candidate.host === host && presented.some((hash) => timingSafeEqual(candidate.hash, hash)));
    if (!session || !this.options.clientActive(session.clientId)) return forbidden;
    const path = `${url.pathname}${url.search}`;
    if (name.kind === 'files') return { kind: 'files', path };
    if (!this.options.isForwardedPort(name.port)) return { kind: 'refused', status: 404, body: 'Not found' };
    return { kind: 'port', port: name.port, path, forwardedHost };
  };

  private prune(): void {
    const now = this.now();
    this.tickets = this.tickets.filter((ticket) => ticket.expiresAt > now);
    this.sessions = this.sessions.filter((session) => session.expiresAt > now);
  }
}

function readCookies(header: string, name: string): string[] {
  return header.split(';').flatMap((part) => {
    const [key, ...value] = part.trim().split('=');
    return key === name ? [value.join('=')] : [];
  });
}
