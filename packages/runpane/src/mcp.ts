import { spawn } from 'node:child_process';
import { boundary, decodeBoundary, type JsonObject, type JsonValue } from './boundaryDecoder';
import { loadDocs } from './docs';
import { RUNPANE_CONTRACT } from './generated/contract';
import { buildMcpTools, buildToolArgv, CONFIRM_FLAG, type McpTool } from './mcpTools';
import { ProtocolError, ProtocolErrorCode, Server, serveStdio } from './mcpSdk';
import { getWrapperVersion } from './version';

// A type alias, unlike an interface, is assignable to the SDK's open result type.
type ToolResult = {
  content: { type: 'text'; text: string }[];
  structuredContent?: JsonObject;
  isError?: boolean;
};

const DEFAULT_TOOLSETS = ['core'];
const DOCS_URI_PREFIX = 'runpane-docs:';

const INSTRUCTIONS = [
  RUNPANE_CONTRACT.agentContext.brief.summary,
  'Each tool runs the matching `runpane` command against the running Pane app and returns the same JSON as `runpane <command> --json`.',
  'How the tools fit together:',
  '- For the common jobs, prefer the composite tools: `agents_start` starts an agent on a task in a repo and returns its pane and panel ids and a pane:// link; `agents_status` checks on it; `agents_send` sends it a follow-up message.',
  '- `agents_send` types text and presses Enter. To answer a menu or prompt in an agent\'s terminal, send exact keys with `panels_input` (Down arrow \\u001b[B, Enter \\r, Escape \\u001b) and check the screen with `agents_status` afterwards. Ask the user before answering trust or permission prompts.',
  '- Discover before you change anything. Repo selectors come from `repos_list` (or `active`); pane ids come from `panes_list`, `workspace_state`, or `agents_start`; panel ids from `agents_start` or `panels_list`.',
  '- Tools with a `yes` input change Pane state. Pass `yes: true` only when the user asked for that change; without it the call is refused and nothing happens.',
  '- `panes_archive` removes a Pane\'s worktree; `panes_restore` undoes it. `links_create` returns a pane:// link the user can click to see any Pane, panel, repo, or Session.',
  '- Before guessing how Pane works, call `docs_search`, then `docs_read` on a path it returns. The same docs are available as `runpane-docs:` resources.',
  '- Tools have no stdin: send exact terminal bytes (newlines, Ctrl-C as \\u0003) as text instead of a file.',
].join('\n');

// The lists only change with a new runpane version, which restarts this server.
const LIST_CACHE = { ttlMs: 3_600_000, cacheScope: 'public' } as const;

interface McpServerOptions {
  toolsets?: readonly string[];
  readOnly?: boolean;
}

/** The tools a `--toolsets` / `--read-only` selection serves. `all` and `read` are built in. */
function selectTools(tools: readonly McpTool[], options: McpServerOptions): McpTool[] {
  const wanted = new Set(options.toolsets && options.toolsets.length > 0 ? options.toolsets : DEFAULT_TOOLSETS);
  const known = new Set(['all', 'read', ...tools.flatMap((tool) => tool.toolsets)]);
  const unknown = [...wanted].filter((name) => !known.has(name));
  if (unknown.length > 0) {
    throw new Error(`Unknown toolset(s): ${unknown.join(', ')}. Choose from: ${[...known].sort().join(', ')}.`);
  }
  return tools.filter((tool) => {
    const readOnly = tool.annotations.readOnlyHint;
    if (options.readOnly && !readOnly) return false;
    return wanted.has('all') || (wanted.has('read') && readOnly) || tool.toolsets.some((name) => wanted.has(name));
  });
}

/**
 * Serves the selected contract commands as MCP tools, and Pane's docs as resources, over stdio.
 * Speaks the 2026-07-28 revision and the 2025 `initialize` handshake current clients still use.
 * Only JSON-RPC goes to stdout; the child CLI's output is captured, never passed through.
 */
export async function runMcpServer(options: McpServerOptions = {}): Promise<number> {
  const allTools = buildMcpTools();
  let tools: McpTool[];
  try {
    tools = selectTools(allTools, options);
  } catch (error) {
    process.stderr.write(`runpane mcp: ${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }
  const toolsByName = new Map(tools.map((tool) => [tool.name, tool]));
  const rewrite = (text: string) => rewriteCliHints(text, allTools, toolsByName);
  const listResult = {
    tools: tools.map((tool) => ({
      name: tool.name,
      title: tool.title,
      description: rewrite(tool.description),
      inputSchema: tool.inputSchema,
      outputSchema: tool.outputSchema,
      annotations: tool.annotations,
    })),
  };

  const createServer = () => {
    const server = new Server(
      { name: 'pane', title: 'Pane', version: getWrapperVersion() },
      {
        capabilities: { tools: {}, resources: {} },
        instructions: INSTRUCTIONS,
        cacheHints: { 'tools/list': LIST_CACHE, 'resources/list': LIST_CACHE },
      },
    );
    server.setRequestHandler('tools/list', () => listResult);
    server.setRequestHandler('tools/call', (request, ctx) => {
      const tool = toolsByName.get(request.params.name);
      if (!tool) {
        const other = allTools.find((candidate) => candidate.name === request.params.name);
        const set = other?.toolsets[0] ?? 'all';
        const hint = other ? ` It is in the "${set}" toolset: run the server with --toolsets ${set} (or all).` : ' Call tools/list for the available tools.';
        throw new ProtocolError(ProtocolErrorCode.InvalidParams, `Unknown tool: ${request.params.name}.${hint}`);
      }
      let input: JsonObject;
      try {
        input = decodeBoundary(request.params.arguments ?? {}, boundary.jsonObject);
      } catch (error) {
        return errorResult(`Invalid arguments for ${tool.name}: ${error instanceof Error ? error.message : String(error)}`);
      }
      return callTool(tool, input, ctx.mcpReq.signal, rewrite);
    });
    server.setRequestHandler('resources/list', () => ({
      resources: loadDocs(undefined).map((doc) => ({
        uri: docUri(doc.path),
        name: doc.path,
        title: doc.title,
        mimeType: 'text/markdown',
      })),
    }));
    server.setRequestHandler('resources/read', (request) => {
      const doc = loadDocs(undefined).find((entry) => docUri(entry.path) === request.params.uri);
      if (!doc) {
        throw new ProtocolError(ProtocolErrorCode.InvalidParams, `No Pane doc at ${request.params.uri}. List them with resources/list, or search with docs_search.`);
      }
      return { contents: [{ uri: request.params.uri, mimeType: 'text/markdown', text: doc.text }] };
    });
    return server;
  };

  const handle = serveStdio(createServer, { onerror: (error) => process.stderr.write(`runpane mcp: ${error.message}\n`) });
  await new Promise<void>((resolve) => process.stdin.once('close', resolve).once('end', resolve));
  await handle.close();
  return 0;
}

function docUri(docPath: string): string {
  return `${DOCS_URI_PREFIX}${docPath.split('/').map(encodeURIComponent).join('/')}`;
}

/**
 * The CLI names next steps as CLI commands (`runpane repos list`). For an MCP client, name the
 * tool instead, and say which toolset holds it when this server does not serve it.
 */
function rewriteCliHints(text: string, allTools: readonly McpTool[], served: ReadonlyMap<string, McpTool>): string {
  const byLongestCommand = [...allTools].sort((a, b) => b.command.length - a.command.length);
  return text.replace(/`runpane ([^`]+)`/g, (whole, spoken: string) => {
    const tool = byLongestCommand.find((candidate) => spoken === candidate.command || spoken.startsWith(`${candidate.command} `));
    if (!tool) return whole;
    const inputs = [...spoken.slice(tool.command.length).matchAll(/--([a-z][a-z0-9-]*)(?:[ =]("[^"]*"|<[^>]+>|[^\s-]\S*))?/g)]
      .filter(([, flag]) => flag !== 'json')
      .map(([, flag, value]) => `${flag.replace(/-([a-z0-9])/g, (_c, letter: string) => letter.toUpperCase())}: ${value ?? 'true'}`);
    const where = served.has(tool.name) ? '' : ` (in the "${tool.toolsets[0] ?? 'all'}" toolset)`;
    return `\`${tool.name}\`${inputs.length > 0 ? ` with ${inputs.join(', ')}` : ''}${where}`;
  });
}

async function callTool(tool: McpTool, input: JsonObject, signal: AbortSignal, rewrite: (text: string) => string): Promise<ToolResult> {
  let argv: string[];
  try {
    argv = buildToolArgv(tool, input);
  } catch (error) {
    // Bad arguments are tool execution errors, so the model can correct them and retry.
    return errorResult(`Invalid arguments for ${tool.name}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const { code, stdout, stderr } = await runCli(argv, signal);
  // Docs come back as written; everything else speaks in tool names.
  const translate = tool.toolsets.includes('docs') ? (text: string) => text : rewrite;
  const text = translate(stdout.trim() || stderr.trim() || `runpane ${tool.command} exited with code ${code}`);
  if (code !== 0) {
    const unconfirmed = !argv.includes(CONFIRM_FLAG) && tool.parameters.some((parameter) => parameter.flag === CONFIRM_FLAG);
    return errorResult(unconfirmed ? `${text}\nIf Pane refused the change, pass \`yes: true\` to confirm it.` : text);
  }
  const structuredContent = parseJsonObject(text);
  if (!structuredContent) return errorResult(`runpane ${tool.command} did not print JSON:\n${text}`);
  return { content: [{ type: 'text', text }], structuredContent };
}

function parseJsonObject(text: string): JsonObject | undefined {
  try {
    const value: JsonValue = decodeBoundary(JSON.parse(text), boundary.json);
    return decodeBoundary(value, boundary.jsonObject);
  } catch {
    return undefined;
  }
}

/**
 * Runs this same runpane entrypoint in a child so each call gets the CLI's exact behavior and
 * output. A cancelled request (notifications/cancelled) aborts the signal, which kills the child.
 */
function runCli(argv: string[], signal: AbortSignal): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [process.argv[1], ...argv], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
      windowsHide: true,
      signal,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk; });
    child.on('error', (error) => resolve({ code: 1, stdout, stderr: `${stderr}${error.message}` }));
    child.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

function errorResult(text: string): ToolResult {
  return { content: [{ type: 'text', text }], isError: true };
}
