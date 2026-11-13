import { randomBytes } from 'crypto';
import http from 'http';
import type { AddressInfo } from 'net';

/** What a tab's token lets it reach: its Claude prompt hooks, or Pane's MCP tools. */
export type TabTokenKind = 'claude-hook' | 'mcp';

/** Serves the requests whose path starts with its prefix; the listener answers 404 to the rest. */
export type TabRoute = (request: http.IncomingMessage, response: http.ServerResponse, path: string) => Promise<void>;

const TOKEN_BYTES = 32;

/**
 * The one loopback listener for the tabs Pane starts (127.0.0.1, a random port), and the tokens
 * that say which tab a request comes from. Tokens live only in memory; `forget` ends all of a
 * tab's tokens at once when the tab closes. Features mount their routes on it.
 */
export class TabListener {
  private server?: http.Server;
  private listening?: Promise<void>;
  private readonly routes = new Map<string, TabRoute>();
  private readonly tokens = new Map<string, { panelId: string; kind: TabTokenKind }>();
  private readonly forgetListeners = new Set<(panelId: string) => void>();
  origin?: string;

  /** Listens once; later calls wait for the same listen. */
  start(): Promise<void> {
    this.listening ??= new Promise<void>((resolve, reject) => {
      const server = http.createServer((request, response) => void this.serve(request, response));
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        server.unref();
        this.server = server;
        // SAFETY: a server listening on a TCP port reports an AddressInfo, not a pipe name.
        this.origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
        resolve();
      });
    });
    return this.listening;
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    this.listening = undefined;
    this.origin = undefined;
    this.tokens.clear();
    if (server) {
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  }

  /** Serves `prefix` (for example `/mcp`) with `route` until the returned function is called. */
  mount(prefix: string, route: TabRoute): () => void {
    this.routes.set(prefix, route);
    return () => { if (this.routes.get(prefix) === route) this.routes.delete(prefix); };
  }

  /** A fresh random token for the tab; undefined while the listener isn't listening. */
  mint(panelId: string, kind: TabTokenKind): string | undefined {
    if (!this.origin) return undefined;
    const token = randomBytes(TOKEN_BYTES).toString('base64url');
    this.tokens.set(token, { panelId, kind });
    return token;
  }

  /** The tab a token belongs to, when it is a live token of this kind. */
  owner(token: string | undefined, kind: TabTokenKind): string | undefined {
    const entry = token ? this.tokens.get(token) : undefined;
    return entry?.kind === kind ? entry.panelId : undefined;
  }

  hasToken(panelId: string, kind: TabTokenKind): boolean {
    for (const entry of this.tokens.values()) if (entry.panelId === panelId && entry.kind === kind) return true;
    return false;
  }

  /** Ends the tab's tokens of one kind. */
  revoke(panelId: string, kind: TabTokenKind): void {
    for (const [token, entry] of this.tokens) if (entry.panelId === panelId && entry.kind === kind) this.tokens.delete(token);
  }

  /** The tab closed or its process ended: every token it had stops working, and each feature lets go of it. */
  forget(panelId: string): void {
    for (const [token, entry] of this.tokens) if (entry.panelId === panelId) this.tokens.delete(token);
    for (const listener of this.forgetListeners) listener(panelId);
  }

  onForget(listener: (panelId: string) => void): () => void {
    this.forgetListeners.add(listener);
    return () => this.forgetListeners.delete(listener);
  }

  private async serve(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
    // Only the path matters, and a malformed target is just an unknown path.
    const path = (request.url ?? '/').split('?')[0];
    const prefix = [...this.routes.keys()].find(candidate => path === candidate || path.startsWith(`${candidate}/`));
    const route = prefix === undefined ? undefined : this.routes.get(prefix);
    try {
      if (route) await route(request, response, path);
      else sendError(response, 404, { code: 'NOT_FOUND', message: `Pane serves nothing at ${path} here.`, next: 'Use the URL Pane put in the tab\'s environment.' });
    } catch (error) {
      console.warn('[TabListener] A request failed:', error instanceof Error ? error.message : String(error));
      if (!response.headersSent) sendError(response, 500, { code: 'INTERNAL', message: 'Pane could not answer this request.', next: 'Try again; Pane logged the cause.' });
      else response.end();
    }
  }
}

/** What Pane's HTTP errors say: what happened, and the next step. */
export interface TabRequestError {
  code: string;
  message: string;
  next: string;
}

/** An error answer in the `{code, message, next}` shape Pane's HTTP errors use. */
export function sendError(response: http.ServerResponse, status: number, body: TabRequestError, headers: Record<string, string> = {}): void {
  if (response.writableEnded || response.destroyed) return;
  response.writeHead(status, { 'content-type': 'application/json', ...headers });
  response.end(JSON.stringify(body));
}

/** Reads a request body, refusing more than `maxBytes`. */
export function readBody(request: http.IncomingMessage, maxBytes: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new Error('body too large'));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => resolve(Buffer.concat(chunks)));
    request.on('error', reject);
  });
}

/** The listener every tab feature shares; bootstrap starts it, Pane's quit stops it. */
export const tabListener = new TabListener();

/** The tab closed or its process ended: all of its tokens stop working. */
export function forgetTab(panelId: string): void {
  tabListener.forget(panelId);
}
