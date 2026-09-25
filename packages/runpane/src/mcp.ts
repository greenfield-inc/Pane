import { spawn } from 'node:child_process';
import { boundary, decodeBoundary, type JsonObject, type JsonValue } from './boundaryDecoder';
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

const INSTRUCTIONS = [
  RUNPANE_CONTRACT.agentContext.brief.summary,
  'Each tool runs the matching `runpane` command against the running Pane app and returns the same JSON as `runpane <command> --json`.',
  'Start with `doctor`, then `agent_context` for rules and workflow. Tools with a `yes` input change Pane state and need `yes: true`, like the CLI\'s --yes.',
  'Tools have no stdin: send exact terminal bytes (newlines, Ctrl-C as \\u0003) in `text` instead of `inputFile: "-"`.',
].join('\n');

// The tool list only changes with a new runpane version, which restarts this server.
const TOOLS_LIST_CACHE = { ttlMs: 3_600_000, cacheScope: 'public' } as const;

/**
 * Serves every contract command that has a JSON result as an MCP tool over stdio. Speaks the
 * 2026-07-28 revision and the 2025 `initialize` handshake that current clients still use.
 * Only JSON-RPC goes to stdout; the child CLI's output is captured, never passed through.
 */
export async function runMcpServer(): Promise<number> {
  const tools = buildMcpTools();
  const toolsByName = new Map(tools.map((tool) => [tool.name, tool]));
  const listResult = {
    tools: tools.map((tool) => ({
      name: tool.name,
      title: tool.title,
      description: tool.description,
      inputSchema: tool.inputSchema,
      outputSchema: tool.outputSchema,
      annotations: tool.annotations,
    })),
  };

  const createServer = () => {
    const server = new Server(
      { name: 'pane', title: 'Pane', version: getWrapperVersion() },
      { capabilities: { tools: {} }, instructions: INSTRUCTIONS, cacheHints: { 'tools/list': TOOLS_LIST_CACHE } },
    );
    server.setRequestHandler('tools/list', () => listResult);
    server.setRequestHandler('tools/call', (request, ctx) => {
      const tool = toolsByName.get(request.params.name);
      if (!tool) throw new ProtocolError(ProtocolErrorCode.InvalidParams, `Unknown tool: ${request.params.name}`);
      let input: JsonObject;
      try {
        input = decodeBoundary(request.params.arguments ?? {}, boundary.jsonObject);
      } catch (error) {
        return errorResult(`Invalid arguments for ${tool.name}: ${error instanceof Error ? error.message : String(error)}`);
      }
      return callTool(tool, input, ctx.mcpReq.signal);
    });
    return server;
  };

  const handle = serveStdio(createServer, { onerror: (error) => process.stderr.write(`runpane mcp: ${error.message}\n`) });
  await new Promise<void>((resolve) => process.stdin.once('close', resolve).once('end', resolve));
  await handle.close();
  return 0;
}

async function callTool(tool: McpTool, input: JsonObject, signal: AbortSignal): Promise<ToolResult> {
  let argv: string[];
  try {
    argv = buildToolArgv(tool, input);
  } catch (error) {
    // Bad arguments are tool execution errors, so the model can correct them and retry.
    return errorResult(`Invalid arguments for ${tool.name}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const { code, stdout, stderr } = await runCli(argv, signal);
  const text = stdout.trim() || stderr.trim() || `runpane ${tool.command} exited with code ${code}`;
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
