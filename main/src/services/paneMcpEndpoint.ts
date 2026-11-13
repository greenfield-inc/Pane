import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import type http from 'http';
import path from 'path';
import { Readable } from 'stream';
import type { McpServer } from '@agentclientprotocol/sdk';
import type { AuthInfo, PaneMcpHttpHandler, RunCli } from '../../../packages/runpane/src/mcpHttp';
import { agentConfig } from '../../../shared/agents';
import { getAppDirectory, getAppSubdirectory } from '../utils/appDirectory';
import { tokenizeShellCommand } from './agents/agentIdentity';
import { quoteShellWord } from './agents/shellWord';
import { PANE_MCP_SERVER_NAME, PANE_MCP_TOKEN_ENV, PANE_MCP_URL_ENV, PANE_MCP_PLUGIN_DENY_SETTINGS } from './paneMcpNames';
import { bundledRunpanePath } from './runpaneShim';
import { readBody, sendError, tabListener, type TabListener } from './tabListener';

/** The bundled runpane HTTP module (packages/runpane/src/mcpHttp.ts). */
export type PaneMcpHttpModule = typeof import('../../../packages/runpane/src/mcpHttp');

/** Where `pnpm build:main` puts that module (main/build-runpane-cli.js). */
export const BUNDLED_MCP_HTTP_MODULE = bundledRunpanePath('mcp-http.cjs');

const MCP_PATH = '/mcp';
const BEARER = /^Bearer\s+(\S+)$/i;
/** MCP requests are small JSON-RPC messages; anything bigger is refused. */
const MAX_BODY_BYTES = 4 * 1024 * 1024;
/** The handler takes about 0.2 s to build, so Pane builds it this long after startup, not on a tab's spawn. */
const WARM_UP_DELAY_MS = 10_000;
/** The URL and header a launch's MCP config names: the agent reads both from its environment, so no token is ever in argv or on disk. */
const URL_REFERENCE = `\${${PANE_MCP_URL_ENV}}`;
const AUTHORIZATION_REFERENCE = `Bearer \${${PANE_MCP_TOKEN_ENV}}`;
/** A launch's MCP config file: Pane's `pane` server over HTTP, in place of the user-level stdio entry. Every tab shares it. */
const MCP_CONFIG = { mcpServers: { [PANE_MCP_SERVER_NAME]: { type: 'http', url: URL_REFERENCE, headers: { Authorization: AUTHORIZATION_REFERENCE } } } };

/** Who a tool call runs as: the tab's own environment and folder, as its stdio server would have, and its agent's name. */
export interface PaneMcpTab {
  panelId: string;
  env: Record<string, string>;
  cwd: string;
  agentLabel: string;
}

export interface PaneMcpEndpointOptions {
  /** Loads runpane's MCP HTTP module, the same tools `runpane mcp` serves. */
  load(): Promise<PaneMcpHttpModule>;
  /** The runpane CLI a tool call runs (the one on the tab's PATH), or undefined when this Pane has none. */
  cli(): { executable: string; script: string } | undefined;
  /** Settings > AI & Agents: Register Pane tools, and the toolsets agents get. */
  settings(): { enabled: boolean; toolsets?: string[] };
  /** This Pane's data folder, so a tool call reaches this Pane and not another. */
  paneDir?(): string;
  listener?: TabListener;
}

/**
 * Serves Pane's MCP tools over streamable HTTP at `/mcp` on the tab listener, to the tabs Pane
 * starts whose agent replaces its user-level `pane` server for one launch. The tab's token says
 * which tab a call comes from; tool calls run the runpane CLI with that tab's environment and
 * folder, exactly as the tab's own `runpane mcp` would.
 */
export class PaneMcpEndpoint {
  private readonly listener: TabListener;
  private readonly tabs = new Map<string, PaneMcpTab>();
  /** One handler per toolsets setting, built once; a failed build stays failed until the setting changes. */
  private readonly handlers = new Map<string, Promise<PaneMcpHttpHandler | Error>>();
  /** Toolsets values whose handler failed to build: tabs started meanwhile keep stdio. */
  private readonly failedBuilds = new Set<string>();
  private module?: Promise<PaneMcpHttpModule>;
  private detach: Array<() => void> = [];
  private warmUp?: ReturnType<typeof setTimeout>;

  constructor(private readonly options: PaneMcpEndpointOptions) {
    this.listener = options.listener ?? tabListener;
  }

  /** Mounts `/mcp` on the listener. Nothing heavy happens here: the handler is built later, off the startup path. */
  attach(): void {
    if (this.detach.length > 0) return;
    this.detach = [
      this.listener.mount(MCP_PATH, (request, response) => this.serve(request, response)),
      this.listener.onForget(panelId => this.forgetPanel(panelId)),
    ];
    this.warmUp = setTimeout(() => void this.handler(), WARM_UP_DELAY_MS);
    this.warmUp.unref();
  }

  detachAll(): void {
    clearTimeout(this.warmUp);
    for (const undo of this.detach) undo();
    this.detach = [];
    this.tabs.clear();
  }

  /**
   * A fresh token for a tab Pane is starting, replacing any it had: what goes into the tab's
   * environment. Undefined while the listener isn't listening or Pane tools are off; the agent
   * then keeps its stdio server.
   */
  grant(tab: PaneMcpTab): Record<string, string> | undefined {
    this.forgetPanel(tab.panelId);
    const origin = this.listener.origin;
    const settings = this.options.settings();
    if (!origin || this.detach.length === 0 || !settings.enabled || this.failedBuilds.has(toolsetsKey(settings.toolsets))) return undefined;
    const token = this.listener.mint(tab.panelId, 'mcp');
    if (!token) return undefined;
    this.tabs.set(token, tab);
    return { [PANE_MCP_URL_ENV]: `${origin}${MCP_PATH}`, [PANE_MCP_TOKEN_ENV]: token };
  }

  /** Whether the tab holds a live token, which is the one condition for pointing its agent here. */
  granted(panelId: string): boolean {
    return this.listener.hasToken(panelId, 'mcp');
  }

  private forgetPanel(panelId: string): void {
    this.listener.revoke(panelId, 'mcp');
    for (const [token, tab] of this.tabs) if (tab.panelId === panelId) this.tabs.delete(token);
  }

  private loadModule(): Promise<PaneMcpHttpModule> {
    this.module ??= this.options.load();
    return this.module;
  }

  /** The handler for the current toolsets, or why it can't be built. */
  private handler(): Promise<PaneMcpHttpHandler | Error> {
    const toolsets = this.options.settings().toolsets ?? [];
    const key = toolsetsKey(toolsets);
    let built = this.handlers.get(key);
    if (!built) {
      built = this.loadModule().then(
        (module) => module.createPaneMcpHttpHandler({
          toolsets,
          runCli: (argv, signal, env, auth) => this.runCli(argv, signal, env, auth),
          // Pane points only agents it measured holding a call open (Claude: 40 minutes over HTTP) at this endpoint.
          clientFor: (auth) => {
            const tab = auth && this.tabs.get(auth.token);
            return tab ? { name: tab.agentLabel, waitsLong: true } : undefined;
          },
          onerror: (error) => console.warn('[PaneMcp]', error.message),
        }),
      ).catch(error => {
        const failure = error instanceof Error ? error : new Error(String(error));
        console.warn('[PaneMcp] Pane tools over HTTP are unavailable; new tabs keep stdio:', failure.message);
        this.failedBuilds.add(key);
        return failure;
      });
      this.handlers.set(key, built);
    }
    return built;
  }

  private async serve(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
    const token = BEARER.exec(String(request.headers.authorization ?? ''))?.[1];
    if (!token || !this.tabs.has(token) || !this.listener.owner(token, 'mcp')) {
      return sendError(response, 401, {
        code: 'PANE_MCP_TOKEN_INVALID',
        message: 'This request has no live Pane tab token.',
        next: 'Only agents Pane starts can use this endpoint, until their tab closes; others use `runpane mcp`.',
      }, { 'www-authenticate': 'Bearer' });
    }
    if (!this.options.settings().enabled) {
      return sendError(response, 403, {
        code: 'PANE_MCP_DISABLED',
        message: 'Pane tools are turned off in Settings > AI & Agents.',
        next: 'Turn on Register Pane tools, then restart the agent.',
      });
    }
    const handler = await this.handler();
    if (handler instanceof Error) {
      return sendError(response, 503, { code: 'PANE_MCP_UNAVAILABLE', message: `Pane's MCP tools could not start: ${handler.message}`, next: 'Check Settings > AI & Agents toolsets, then restart the agent.' });
    }
    const closed = new AbortController();
    response.on('close', () => closed.abort());
    const body = request.method === 'GET' || request.method === 'HEAD' ? undefined : await readBody(request, MAX_BODY_BYTES);
    const headers = new Headers();
    for (const [name, value] of Object.entries(request.headers)) {
      if (Array.isArray(value)) for (const item of value) headers.append(name, item);
      else if (value !== undefined) headers.set(name, value);
    }
    const reply = await handler(
      new Request(`http://${request.headers.host ?? '127.0.0.1'}${MCP_PATH}`, { method: request.method, headers, body, signal: closed.signal }),
      { token, clientId: this.tabs.get(token)?.panelId ?? '', scopes: [] },
    );
    const replyHeaders: Record<string, string> = {};
    reply.headers.forEach((value, name) => { replyHeaders[name] = value; });
    response.writeHead(reply.status, replyHeaders);
    if (!reply.body) {
      response.end();
      return;
    }
    // SAFETY: a fetch Response body is a web ReadableStream of bytes.
    const replyBody = reply.body as import('stream/web').ReadableStream<Uint8Array>;
    Readable.fromWeb(replyBody).on('error', () => response.destroy()).pipe(response);
  }

  /** Runs one tool's runpane command as the token's tab; a revoked token runs nothing. */
  private async runCli(argv: string[], signal: AbortSignal, env: NodeJS.ProcessEnv, auth: AuthInfo | undefined): ReturnType<RunCli> {
    const module = await this.loadModule();
    const tab = auth && this.tabs.get(auth.token);
    const failure = (code: string, message: string, next: string) => ({ code: 1, stdout: module.failureJson({ code, message, next }), stderr: '' });
    if (!tab) return failure('PANE_MCP_TAB_CLOSED', 'This tab\'s Pane tools stopped working because the tab closed or Pane restarted.', 'Restart the agent in a Pane tab.');
    const cli = this.options.cli();
    if (!cli) return failure('PANE_MCP_CLI_MISSING', 'This Pane has no runpane CLI to run the tool.', 'Reinstall Pane from runpane.com.');
    return module.runCliProcess(cli.executable, [cli.script, ...argv], {
      // PANE_DIR as the tab's own shim sets it: a --pane-dir or dev Pane reaches itself, not ~/.pane.
      env: { ...tab.env, ...env, ELECTRON_RUN_AS_NODE: '1', PANE_DIR: (this.options.paneDir ?? getAppDirectory)() },
      cwd: tab.cwd,
      signal,
    });
  }
}

function toolsetsKey(toolsets: string[] | undefined): string {
  return (toolsets ?? []).join(',');
}

let current: PaneMcpEndpoint | undefined;

/** Set once the endpoint is attached; tabs started before then keep their stdio server. */
export function setPaneMcpEndpoint(endpoint: PaneMcpEndpoint | undefined): void {
  current = endpoint;
}

/** Whether the agent reaches Pane's tools over HTTP in a terminal tab (its config names a per-launch MCP config flag). */
export function terminalUsesPaneMcp(agentType: string | undefined): boolean {
  return Boolean(agentType && agentConfig(agentType)?.terminal.paneMcpConfigFlag);
}

/** The environment that points a tab's agent at Pane's tools, or undefined when it should use stdio. */
export function grantPaneMcp(tab: PaneMcpTab): Record<string, string> | undefined {
  return current?.grant(tab);
}

/**
 * A terminal launch that reaches Pane's tools over HTTP: `<flag>=<file>` right after the
 * executable, for an agent whose config names the flag and a tab that holds a live token. The
 * `=` form takes exactly one value, so a prompt argument after it stays the prompt. A command
 * that already names the file, keeps MCP servers out (`--strict-mcp-config`), or doesn't start
 * with the agent's executable runs unchanged, on stdio.
 */
export function withPaneMcpConfig(panelId: string, agentType: string | undefined, command: string, shellType: string | undefined): string {
  const agent = agentType ? agentConfig(agentType) : undefined;
  const flag = agent?.terminal.paneMcpConfigFlag;
  if (!agent || !flag || !current?.granted(panelId)) return command;
  const file = path.join(getAppSubdirectory('mcp'), 'pane-http.json');
  const spans: Array<{ start: number; end: number }> = [];
  const tokens = tokenizeShellCommand(command, process.platform, spans);
  const word = quoteShellWord(`${flag}=${file}`, shellType);
  const executable = path.basename(tokens?.[0] ?? '').replace(/\.(exe|cmd)$/i, '').toLowerCase();
  if (!tokens || !word || !agent.executables.some(name => name.toLowerCase() === executable) || tokens.includes('--strict-mcp-config') || command.includes(file)) return command;
  const content = `${JSON.stringify(MCP_CONFIG, null, 2)}\n`;
  try {
    mkdirSync(path.dirname(file), { recursive: true });
    if (!existsSync(file) || readFileSync(file, 'utf8') !== content) writeFileSync(file, content);
  } catch (error) {
    console.warn(`[PaneMcp] ${agent.label} keeps its stdio Pane tools: ${file} could not be written (${error instanceof Error ? error.message : String(error)}).`);
    return command;
  }
  return `${command.slice(0, spans[0].end)} ${word}${command.slice(spans[0].end)}`;
}

/**
 * Claude settings for a tab that reaches Pane's tools over HTTP: they hide the `pane` server Pane's
 * Claude plugin brings, so the tab sees one Pane server. Claude keeps only the last `--settings`,
 * so these go into the one settings file the launch names (withClaudePromptHooks).
 */
export function paneMcpTabSettings(panelId: string, agentType: string | undefined): typeof PANE_MCP_PLUGIN_DENY_SETTINGS | undefined {
  const agent = agentType ? agentConfig(agentType) : undefined;
  return agent?.terminal.paneMcpConfigFlag && current?.granted(panelId) ? PANE_MCP_PLUGIN_DENY_SETTINGS : undefined;
}

/**
 * Pane's MCP server for a chat tab's ACP `session/new`. Its URL and header name variables the
 * agent reads from its own environment (from the grant), because the Claude Agent SDK passes MCP
 * servers on the `claude` command line, where any local user could read a token.
 */
export function paneMcpChatServer(): McpServer {
  return { type: 'http', name: PANE_MCP_SERVER_NAME, url: URL_REFERENCE, headers: [{ name: 'Authorization', value: AUTHORIZATION_REFERENCE }] };
}
