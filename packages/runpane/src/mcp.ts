import { spawn } from 'node:child_process';
import { boundary, decodeBoundary, type JsonObject } from './boundaryDecoder';
import { RUNPANE_CONTRACT } from './generated/contract';
import { buildMcpTools, buildToolArgv, CONFIRM_FLAG, type McpTool } from './mcpTools';
import { CallToolRequestSchema, ListToolsRequestSchema, Server, StdioServerTransport } from './mcpSdk';
import { getWrapperVersion } from './version';

// A type alias, unlike an interface, is assignable to the SDK's open result type.
type ToolResult = {
  content: { type: 'text'; text: string }[];
  isError?: boolean;
};

const INSTRUCTIONS = [
  RUNPANE_CONTRACT.agentContext.brief.summary,
  'Each tool runs the matching `runpane` command against the running Pane app and returns the same JSON as `runpane <command> --json`.',
  'Start with `doctor`, then `agent_context` for rules and workflow. Tools with a `yes` input change Pane state and need `yes: true`, like the CLI\'s --yes.',
  'Tools have no stdin: send exact terminal bytes (newlines, Ctrl-C as \\u0003) in `text` instead of `inputFile: "-"`.',
].join('\n');

/** Serves every contract command that has a JSON result as an MCP tool over stdio. */
export async function runMcpServer(): Promise<number> {
  const tools = buildMcpTools();
  const toolsByName = new Map(tools.map((tool) => [tool.name, tool]));
  const server = new Server(
    { name: 'pane', version: getWrapperVersion() },
    { capabilities: { tools: {} }, instructions: INSTRUCTIONS },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
      annotations: { title: `runpane ${tool.command}`, readOnlyHint: !tool.mutates },
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const tool = toolsByName.get(request.params.name);
    if (!tool) {
      return errorResult(`Unknown tool: ${request.params.name}`);
    }
    let input: JsonObject;
    try {
      input = decodeBoundary(request.params.arguments ?? {}, boundary.jsonObject);
    } catch (error) {
      return errorResult(`Invalid arguments for ${tool.name}: ${error instanceof Error ? error.message : String(error)}`);
    }
    return callTool(tool, input);
  });

  const closed = new Promise<number>((resolve) => {
    server.onclose = () => resolve(0);
    process.stdin.once('end', () => resolve(0));
  });
  await server.connect(new StdioServerTransport());
  return closed;
}

async function callTool(tool: McpTool, input: JsonObject): Promise<ToolResult> {
  let argv: string[];
  try {
    argv = buildToolArgv(tool, input);
  } catch (error) {
    return errorResult(error instanceof Error ? error.message : String(error));
  }
  const { code, stdout, stderr } = await runCli(argv);
  const text = stdout.trim() || stderr.trim() || `runpane ${tool.command} exited with code ${code}`;
  if (code === 0) return { content: [{ type: 'text', text }] };
  const unconfirmed = input.yes !== true && tool.parameters.some((parameter) => parameter.flag === CONFIRM_FLAG);
  return errorResult(unconfirmed ? `${text}\nIf Pane refused the change, pass \`yes: true\` to confirm it.` : text);
}

/** Runs this same runpane entrypoint in a child so each call gets the CLI's exact behavior and output. */
function runCli(argv: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [process.argv[1], ...argv], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
      windowsHide: true,
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
