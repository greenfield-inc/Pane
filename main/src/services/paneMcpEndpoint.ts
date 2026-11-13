import { randomBytes } from 'crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import http from 'http';
import type { AddressInfo } from 'net';
import path from 'path';
import { Readable } from 'stream';
import type { AuthInfo, PaneMcpHttpHandler, RunCli } from '../../../packages/runpane/src/mcpHttp';
import { getAppSubdirectory } from '../utils/appDirectory';
import { tokenizeShellCommand } from './agents/agentIdentity';
import { quoteShellWord } from './agents/shellWord';
import { CLAUDE_EXECUTABLE } from './claudePrompts/claudeLaunchSettings';

/** The bundled runpane HTTP module (packages/runpane/src/mcpHttp.ts). */
export type PaneMcpHttpModule = typeof import('../../../packages/runpane/src/mcpHttp');

/** The name agents know Pane's MCP server by, over stdio and HTTP alike. */
export const PANE_MCP_SERVER_NAME = 'pane';
/** The tab's environment carries the endpoint and its token under these names. */
export const PANE_MCP_URL_ENV = 'PANE_MCP_URL';
export const PANE_MCP_TOKEN_ENV = 'PANE_MCP_TOKEN';

const MCP_PATH = '/mcp';
const TOKEN_BYTES = 32;
const BEARER = /^Bearer\s+(\S+)$/i;
/**
 * Claude Code's per-launch MCP config: Pane's `pane` server over HTTP, in place of the user-level
 * stdio entry of the same name. Claude expands the variables from the tab's environment, so the
 * file holds no token and every tab shares it.
 */
const CLAUDE_MCP_CONFIG = {
  mcpServers: {
    [PANE_MCP_SERVER_NAME]: { type: 'http', url: `\${${PANE_MCP_URL_ENV}}`, headers: { Authorization: `Bearer \${${PANE_MCP_TOKEN_ENV}}` } },
  },
};

/** Who a tool call runs as: the tab's own environment and folder, as its stdio server would have. */
export interface PaneMcpTab {
  panelId: string;
  env: Record<string, string>;
  cwd: string;
}

export interface PaneMcpGrant {
  url: string;
  token: string;
}

export interface PaneMcpEndpointOptions {
  /** Loads runpane's MCP HTTP module, the same tools `runpane mcp` serves. */
  load(): Promise<PaneMcpHttpModule>;
  /** The runpane CLI a tool call runs (the one on the tab's PATH), or undefined when this Pane has none. */
  cli(): { executable: string; script: string } | undefined;
  /** Settings > AI & Agents: Register Pane tools, and the toolsets agents get. */
  settings(): { enabled: boolean; toolsets?: string[] };
}

/**
 * Serves Pane's MCP tools over streamable HTTP on loopback, to the agents Pane starts. Each tab
 * gets a random token, held only in memory and in that tab's environment; the token alone says
 * which tab a call comes from, and closing the tab revokes it. Tool calls run the runpane CLI
 * with the tab's environment and folder, exactly as the tab's own `runpane mcp` would.
 */
export class PaneMcpEndpoint {
  private server?: http.Server;
  private url?: string;
  private module?: PaneMcpHttpModule;
  /** The handler for the toolsets it was built for; rebuilt when the setting changes. */
  private handler?: { toolsets: string; serve: PaneMcpHttpHandler };
  private readonly tabs = new Map<string, PaneMcpTab>();

  constructor(private readonly options: PaneMcpEndpointOptions) {}

  async start(): Promise<void> {
    if (this.server) return;
    this.module = await this.options.load();
    const server = http.createServer((request, response) => void this.serve(request, response));
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => resolve());
    });
    server.unref();
    this.server = server;
    // SAFETY: a server listening on a TCP port reports an AddressInfo, not a pipe name.
    this.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}${MCP_PATH}`;
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    this.url = undefined;
    this.tabs.clear();
    if (server) {
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  }

  /**
   * A fresh token for a tab Pane is starting, replacing any the tab had. Undefined while the
   * endpoint isn't listening or Pane tools are off; the tab's agent then keeps its stdio server.
   */
  grant(tab: PaneMcpTab): PaneMcpGrant | undefined {
    this.revoke(tab.panelId);
    if (!this.url || !this.currentHandler()) return undefined;
    const token = randomBytes(TOKEN_BYTES).toString('base64url');
    this.tabs.set(token, tab);
    return { url: this.url, token };
  }

  /** Whether a tab Pane starts now gets a token. */
  serving(): boolean {
    return Boolean(this.url && this.currentHandler());
  }

  /** The tab closed: its tokens stop working. */
  revoke(panelId: string): void {
    for (const [token, tab] of this.tabs) if (tab.panelId === panelId) this.tabs.delete(token);
  }

  /** The handler for the current settings; undefined when Pane tools are off or the toolsets are invalid. */
  private currentHandler(): PaneMcpHttpHandler | undefined {
    const { enabled, toolsets = [] } = this.options.settings();
    if (!enabled || !this.module) return undefined;
    const key = toolsets.join(',');
    if (this.handler?.toolsets !== key) {
      try {
        const serve = this.module.createPaneMcpHttpHandler({
          toolsets,
          runCli: (argv, signal, env, auth) => this.runCli(argv, signal, env, auth),
          onerror: (error) => console.warn('[PaneMcp]', error.message),
        });
        this.handler = { toolsets: key, serve };
      } catch (error) {
        console.warn('[PaneMcp] Agents keep their stdio Pane tools:', error instanceof Error ? error.message : String(error));
        return undefined;
      }
    }
    return this.handler.serve;
  }

  private async serve(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
    const handler = this.currentHandler();
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    if (!handler || url.pathname !== MCP_PATH) {
      response.writeHead(404).end();
      return;
    }
    const token = BEARER.exec(String(request.headers.authorization ?? ''))?.[1];
    if (!token || !this.tabs.has(token)) {
      response.writeHead(401, { 'content-type': 'application/json', 'www-authenticate': 'Bearer' })
        .end(JSON.stringify({ error: 'This request has no valid Pane tab token. Only agents Pane starts can use this endpoint; others use `runpane mcp`.' }));
      return;
    }
    const closed = new AbortController();
    response.on('close', () => closed.abort());
    try {
      const reply = await handler(await toFetchRequest(request, url, closed.signal), { token, clientId: this.tabs.get(token)?.panelId ?? '', scopes: [] });
      const replyHeaders: Record<string, string> = {};
      reply.headers.forEach((value, name) => { replyHeaders[name] = value; });
      response.writeHead(reply.status, replyHeaders);
      if (reply.body) {
        // SAFETY: a fetch Response body is a web ReadableStream of bytes.
        Readable.fromWeb(reply.body as import('stream/web').ReadableStream<Uint8Array>).on('error', () => response.destroy()).pipe(response);
      } else {
        response.end();
      }
    } catch (error) {
      console.warn('[PaneMcp] An MCP request failed:', error instanceof Error ? error.message : String(error));
      if (!response.headersSent) response.writeHead(500);
      response.end();
    }
  }

  /** Runs one tool's runpane command as the token's tab; a revoked token runs nothing. */
  private async runCli(argv: string[], signal: AbortSignal, env: NodeJS.ProcessEnv, auth: AuthInfo | undefined): ReturnType<RunCli> {
    const tab = auth && this.tabs.get(auth.token);
    if (!tab || !this.module) return failure('PANE_MCP_TAB_CLOSED', 'This tab\'s Pane tools stopped working because the tab closed or Pane restarted.', 'Restart the agent in a Pane tab.');
    const cli = this.options.cli();
    if (!cli) return failure('PANE_MCP_CLI_MISSING', 'This Pane has no runpane CLI to run the tool.', 'Reinstall Pane from runpane.com.');
    return this.module.runCliProcess(cli.executable, [cli.script, ...argv], {
      env: { ...tab.env, ...env, ELECTRON_RUN_AS_NODE: '1' },
      cwd: tab.cwd,
      signal,
    });
  }
}

/** A runpane `--json` failure, as the CLI itself prints one. */
function failure(code: string, message: string, next: string): Awaited<ReturnType<RunCli>> {
  return { code: 1, stdout: JSON.stringify({ ok: false, error: { code, message, next } }), stderr: '' };
}

async function toFetchRequest(request: http.IncomingMessage, url: URL, signal: AbortSignal): Promise<Request> {
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (Array.isArray(value)) for (const item of value) headers.append(name, item);
    else if (value !== undefined) headers.set(name, value);
  }
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  const hasBody = request.method !== 'GET' && request.method !== 'HEAD';
  return new Request(`http://${request.headers.host ?? '127.0.0.1'}${url.pathname}${url.search}`, {
    method: request.method,
    headers,
    signal,
    body: hasBody ? Buffer.concat(chunks) : undefined,
  });
}

/** Where `pnpm build:main` puts the bundled HTTP handler (main/build-runpane-cli.js). */
export const BUNDLED_MCP_HTTP_MODULE = path.resolve(__dirname, '..', '..', '..', 'runpane', 'mcp-http.cjs');

let current: PaneMcpEndpoint | undefined;

/** Set once the endpoint listens; tabs started before then keep their stdio server. */
export function setPaneMcpEndpoint(endpoint: PaneMcpEndpoint | undefined): void {
  current = endpoint;
}

/** A token for a tab Pane is starting, or undefined when its agent should use stdio. */
export function grantPaneMcp(tab: PaneMcpTab): PaneMcpGrant | undefined {
  return current?.grant(tab);
}

/** The tab closed: its token stops working. */
export function revokePaneMcp(panelId: string): void {
  current?.revoke(panelId);
}

/**
 * A direct Claude launch that reaches Pane's tools over HTTP: `--mcp-config=<file>` right after the
 * executable. The `=` form takes exactly one value, so a prompt argument after it stays the prompt.
 * Returns the command unchanged when the endpoint isn't serving, the command doesn't start with
 * `claude`, it already names the file, or the file can't be written; Claude then uses stdio.
 */
export function withPaneMcpConfig(command: string, shellType: string | undefined): string {
  if (!current?.serving()) return command;
  const file = path.join(getAppSubdirectory('mcp'), 'claude-http.json');
  if (command.includes(file)) return command;
  const spans: Array<{ start: number; end: number }> = [];
  const tokens = tokenizeShellCommand(command, process.platform, spans);
  const word = quoteShellWord(`--mcp-config=${file}`, shellType);
  if (!tokens || !CLAUDE_EXECUTABLE.test(tokens[0] ?? '') || !word) return command;
  const content = `${JSON.stringify(CLAUDE_MCP_CONFIG, null, 2)}\n`;
  try {
    mkdirSync(path.dirname(file), { recursive: true });
    if (!existsSync(file) || readFileSync(file, 'utf8') !== content) writeFileSync(file, content);
  } catch (error) {
    console.warn(`[PaneMcp] Claude keeps its stdio Pane tools: ${file} could not be written (${error instanceof Error ? error.message : String(error)}).`);
    return command;
  }
  return `${command.slice(0, spans[0].end)} ${word}${command.slice(spans[0].end)}`;
}
