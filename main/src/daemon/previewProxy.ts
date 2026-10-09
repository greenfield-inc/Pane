import http from 'http';
import net, { type AddressInfo } from 'net';
import { Readable } from 'stream';
import { pipeline } from 'stream/promises';
import type { ReadableStream as WebReadableStream } from 'stream/web';
import { timingSafeEqual } from 'crypto';
import { dirname, join } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { streamMediaFile } from '../services/mediaStream';
import { readBrowserPanelFile } from '../services/browserPanelFiles';
import type { BrowserPanelState, ToolPanel } from '../../../shared/types/panels';
import { hasFileProtocol } from '../../../shared/utils/browserUrl';

/** Who may open phone pages right now, read on every request. */
export interface PreviewGate {
  /** This machine's tailnet name; requests for any other Host are refused. */
  dnsName: string;
  machineName: string;
  ownerLogin: string;
  /** Whether a Serve-signed `Tailscale-User-Login` passes "Who can connect". */
  admits(login: string): boolean;
  /** Ports with a Serve handler; nothing else is forwarded. */
  ports: ReadonlySet<number>;
  /** Shown to a refused login instead of naming the device to use, when no device can open pages. */
  refusal?: string;
}

export interface PreviewFiles {
  /** A file inside a browser panel's host HTML bundle, by its path relative to the entry page's folder. */
  readBundleFile(panelId: string, relativePath: string): Promise<{ data: Buffer; contentType: string }>;
  /** The absolute path of a worktree file, checked like `file:getPath`. */
  resolveMediaPath(sessionId: string, filePath: string): Promise<string>;
}

export interface PreviewProxyOptions {
  /** `/pane-<instance>/<secret>`: the start of every Serve target path. */
  basePath: string;
  /** Null while phone pages are off: everyone is refused. */
  gate(): PreviewGate | null;
  files: PreviewFiles;
}

export interface PreviewProxy {
  port: number;
  close(): Promise<void>;
}

/**
 * Files for phones: a browser panel's HTML bundle, held to the folder of its host entry page,
 * and worktree media, held to the worktree by `resolvePath` (the `file:getPath` check).
 */
export function createPreviewFiles(deps: {
  getPanel(panelId: string): ToolPanel | undefined;
  resolvePath(sessionId: string, filePath: string): Promise<string>;
}): PreviewFiles {
  return {
    async readBundleFile(panelId, relativePath) {
      const panel = deps.getPanel(panelId);
      // SAFETY: Only browser panels carry BrowserPanelState; readBrowserPanelFile checks the type.
      const entryUrl = (panel?.state.customState as BrowserPanelState | undefined)?.currentUrl;
      if (!entryUrl || !hasFileProtocol(entryUrl)) throw new Error('No host file is open in this browser panel');
      const requested = pathToFileURL(join(dirname(fileURLToPath(entryUrl)), relativePath)).href;
      const file = await readBrowserPanelFile(panel, requested);
      return { data: Buffer.from(file.data, 'base64'), contentType: file.contentType };
    },
    resolveMediaPath: (sessionId, filePath) => deps.resolvePath(sessionId, filePath),
  };
}

type Route =
  | { kind: 'refused'; status: number; body: string; html?: boolean }
  | { kind: 'port'; port: number; path: string; forwardedHost: string }
  | { kind: 'files'; path: string };

/**
 * The loopback listener behind every phone page's Serve handler. Serve targets carry
 * `<basePath>/<port>` (a dev server) or `<basePath>/files` (HTML bundles and media), and sign
 * each request with the visitor's Tailscale login, which must pass "Who can connect".
 */
export async function startPreviewProxy(options: PreviewProxyOptions): Promise<PreviewProxy> {
  const route = (request: http.IncomingMessage): Route => {
    const url = request.url ?? '/';
    if (!startsWithSecret(url, options.basePath)) return { kind: 'refused', status: 403, body: 'Forbidden' };
    const gate = options.gate();
    const forwardedHost = singleHeader(request.headers.host);
    if (!gate || hostnameOf(forwardedHost) !== gate.dnsName.toLowerCase()) {
      return { kind: 'refused', status: 403, body: 'Forbidden' };
    }
    // Serve sends exactly one login and strips any the visitor sent.
    const login = singleHeader(request.headers['tailscale-user-login']).trim().toLowerCase();
    if (!login || !gate.admits(login)) {
      return { kind: 'refused', status: 403, body: refusalPage(gate.refusal ?? `This page runs on ${gate.machineName}. Open it from a device signed in as ${gate.ownerLogin}.`), html: true };
    }
    const rest = url.slice(options.basePath.length);
    const match = /^\/(\d+|files)(\/.*|\?.*)?$/u.exec(rest);
    if (!match) return { kind: 'refused', status: 404, body: 'Not found' };
    const path = match[2]?.startsWith('/') ? match[2] : `/${match[2] ?? ''}`;
    if (match[1] === 'files') return { kind: 'files', path };
    const port = Number(match[1]);
    if (!gate.ports.has(port)) return { kind: 'refused', status: 404, body: 'Not found' };
    return { kind: 'port', port, path, forwardedHost };
  };

  const server = http.createServer((request, response) => {
    const target = route(request);
    if (target.kind === 'refused') {
      response.writeHead(target.status, {
        'content-type': target.html ? 'text/html; charset=utf-8' : 'text/plain; charset=utf-8',
        'cache-control': 'no-store',
      }).end(target.body);
      request.resume();
      return;
    }
    if (target.kind === 'files') {
      void serveFile(options.files, target.path, request, response);
      return;
    }
    const upstream = http.request({
      host: 'localhost',
      port: target.port,
      method: request.method,
      path: target.path,
      headers: upstreamHeaders(request.headers, target.port, target.forwardedHost),
    }, upstreamResponse => {
      response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.statusMessage, framableHeaders(upstreamResponse.headers));
      upstreamResponse.pipe(response);
    });
    upstream.on('error', error => {
      if (response.headersSent) response.destroy();
      else response.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' }).end(`localhost:${target.port} did not answer: ${error.message}`);
    });
    response.on('close', () => upstream.destroy());
    request.pipe(upstream);
  });

  server.on('upgrade', (request: http.IncomingMessage, socket: net.Socket, head: Buffer) => {
    const target = route(request);
    if (target.kind !== 'port') {
      const status = target.kind === 'refused' ? target.status : 404;
      socket.end(`HTTP/1.1 ${status} ${http.STATUS_CODES[status]}\r\nConnection: close\r\n\r\n`);
      return;
    }
    const upstream = net.connect({ host: 'localhost', port: target.port, autoSelectFamily: true }, () => {
      const headers = upstreamHeaders(request.headers, target.port, target.forwardedHost);
      let head0 = `${request.method} ${target.path} HTTP/1.1\r\n`;
      for (const [name, value] of Object.entries(headers)) {
        for (const item of Array.isArray(value) ? value : [value]) if (item !== undefined) head0 += `${name}: ${item}\r\n`;
      }
      upstream.write(`${head0}\r\n`);
      if (head.length) upstream.write(head);
      upstream.pipe(socket);
      socket.pipe(upstream);
    });
    upstream.on('error', () => socket.destroy());
    socket.on('error', () => upstream.destroy());
    socket.on('close', () => upstream.destroy());
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const sockets = new Set<net.Socket>();
  server.on('connection', socket => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });

  // SAFETY: a TCP server that is listening reports an AddressInfo.
  const { port } = server.address() as AddressInfo;
  return {
    port,
    close: () => new Promise<void>(resolve => {
      for (const socket of sockets) socket.destroy();
      server.close(() => resolve());
    }),
  };
}

async function serveFile(files: PreviewFiles, path: string, request: http.IncomingMessage, response: http.ServerResponse) {
  request.resume();
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    response.writeHead(405).end();
    return;
  }
  const pathname = path.split('?')[0];
  const [, kind, owner, ...segments] = pathname.split('/');
  let relativePath: string;
  try {
    relativePath = segments.map(segment => decodeURIComponent(segment)).join('/');
  } catch {
    relativePath = '';
  }
  if (!owner || !relativePath) {
    response.writeHead(404).end();
    return;
  }
  try {
    if (kind === 'file') {
      const file = await files.readBundleFile(decodeURIComponent(owner), relativePath);
      response.writeHead(200, {
        'content-type': file.contentType,
        'content-length': file.data.length,
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
      }).end(request.method === 'HEAD' ? undefined : file.data);
      return;
    }
    if (kind === 'media') {
      const filePath = await files.resolveMediaPath(decodeURIComponent(owner), relativePath);
      const abort = new AbortController();
      response.on('close', () => abort.abort());
      const range = singleHeader(request.headers.range);
      const result = await streamMediaFile(filePath, new Request('http://preview.invalid/', {
        method: request.method,
        headers: range ? { range } : {},
        signal: abort.signal,
      }));
      result.headers.forEach((value, name) => response.setHeader(name, value));
      response.writeHead(result.status);
      if (!result.body) {
        response.end();
        return;
      }
      // SAFETY: streamMediaFile builds this body with Readable.toWeb, so it is Node's web stream.
      const body = result.body as WebReadableStream<Uint8Array>;
      // A phone that seeks or closes the tab cuts the stream; pipeline ends both sides without an uncaught error.
      await pipeline(Readable.fromWeb(body), response).catch(() => undefined);
      return;
    }
    response.writeHead(404).end();
  } catch {
    // Outside the bundle or worktree, missing, or too large: one answer for all of them.
    if (!response.headersSent) response.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' }).end('Forbidden');
    else response.destroy();
  }
}

function startsWithSecret(url: string, basePath: string): boolean {
  const presented = Buffer.from(url.slice(0, basePath.length));
  const expected = Buffer.from(basePath);
  if (presented.length !== expected.length || !timingSafeEqual(presented, expected)) return false;
  const next = url.charAt(basePath.length);
  return next === '/' || next === '?' || next === '';
}

function singleHeader(value: string | string[] | undefined): string {
  return Array.isArray(value) ? (value.length === 1 ? value[0] : '') : value ?? '';
}

function hostnameOf(host: string): string {
  return host.replace(/:\d+$/u, '').toLowerCase();
}

/** What the dev server sees: a request to localhost, with the phone's address in X-Forwarded-Host. */
function upstreamHeaders(headers: http.IncomingHttpHeaders, port: number, forwardedHost: string): http.OutgoingHttpHeaders {
  const result: http.OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(headers)) {
    if (name.startsWith('tailscale-')) continue;
    result[name] = value;
  }
  result.host = `localhost:${port}`;
  result['x-forwarded-host'] = forwardedHost;
  result['x-forwarded-proto'] = 'https';
  return result;
}

/** Drops what stops a phone tab from framing the page: X-Frame-Options and CSP frame-ancestors. */
function framableHeaders(headers: http.IncomingHttpHeaders): http.OutgoingHttpHeaders {
  const result: http.OutgoingHttpHeaders = { ...headers };
  delete result['x-frame-options'];
  const csp = headers['content-security-policy'];
  if (csp !== undefined) {
    const policies = (Array.isArray(csp) ? csp : [csp])
      .map(policy => policy.split(';').filter(directive => !/^\s*frame-ancestors(\s|$)/iu.test(directive)).join(';').trim())
      .filter(policy => policy.length > 0);
    // Several policies may share one header, separated by commas.
    if (policies.length) result['content-security-policy'] = policies.join(', ');
    else delete result['content-security-policy'];
  }
  return result;
}

/** The Q9 notice: shown in the phone tab's frame when "Who can connect" refuses the visitor. */
function refusalPage(message: string): string {
  const text = escapeHtml(message);
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="light dark"><title>Not available</title><style>body{font:15px/1.5 -apple-system,system-ui,sans-serif;margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px;box-sizing:border-box;text-align:center}</style></head><body><p>${text}</p></body></html>`;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/gu, character => `&#${character.charCodeAt(0)};`);
}
