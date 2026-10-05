import os from 'node:os';
import { boundary, decodeBoundary, type JsonObject } from './boundaryDecoder';
import { invokeDaemon } from './daemonClient';

/**
 * The hand-written `js` and `js_reset` tools. Unlike the generated tools they keep state: the
 * daemon holds one script host per agent connection, keyed by the id this MCP server sends.
 */
export interface ComputerUseTool {
  name: 'js' | 'js_reset';
  title: string;
  toolsets: readonly string[];
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, { type: 'string'; description: string }>;
    required?: string[];
    additionalProperties: false;
  };
  annotations: {
    title: string;
    readOnlyHint: boolean;
    destructiveHint: boolean;
    idempotentHint: boolean;
    openWorldHint: boolean;
  };
}

export type ComputerUseContent =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string };

// A type alias, unlike an interface, is assignable to the SDK's open result type.
export type ComputerUseToolResult = {
  content: ComputerUseContent[];
  isError?: boolean;
};

const TOOLSETS = ['core', 'computer-use'] as const;
// The daemon stops a script after 300 s; leave room for the reply.
const RUN_TIMEOUT_MS = 330_000;
const MACHINE_DESCRIPTION = 'The Pane machine to run on. Defaults to this machine, the only one supported yet.';
const OTHER_MACHINE_REFUSAL = 'Only this machine is supported yet.';

export const COMPUTER_USE_TOOLS: readonly ComputerUseTool[] = [
  {
    name: 'js',
    title: 'Run a desktop script',
    toolsets: TOOLSETS,
    description: [
      'Run a JavaScript script that sees and operates desktop apps on a Pane machine, in the background.',
      '`code` is the body of an async function: top-level await works. Reads such as `getAXState()` show their own result; `return` and `console.log` add text, and `image(...)` adds a picture.',
      'Start with `globalThis.app = await cua.getApp("<name or bundle id>")`, which shows the tree; act by element id (`await app.click(12)`); then `await app.getAXState()` shows what changed.',
      'Only `globalThis` values persist to the next call. Scripts stop after 300 s; output is capped at about 25k tokens.',
      'Background is the default. A `needs_foreground` result means retry that action with `{ foreground: true }`, which shows the user a notice first.',
      'Each run saves step screenshots and a replay; on a public repo, ask the user before attaching them to a PR.',
      '`machine` defaults to this machine. For the full API and rules, load the pane-computer-use skill or call `docs_read` on docs/COMPUTER_USE.md.',
    ].join('\n'),
    inputSchema: {
      type: 'object',
      properties: {
        code: { type: 'string', description: 'The script: the body of an async function.' },
        machine: { type: 'string', description: MACHINE_DESCRIPTION },
      },
      required: ['code'],
      additionalProperties: false,
    },
    annotations: { title: 'Run a desktop script', readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  },
  {
    name: 'js_reset',
    title: 'Reset desktop script state',
    toolsets: TOOLSETS,
    description: 'Discard your `js` script state on a Pane machine. Use when state is confusing or a script hangs; the next `js` call starts fresh.',
    inputSchema: {
      type: 'object',
      properties: { machine: { type: 'string', description: MACHINE_DESCRIPTION } },
      additionalProperties: false,
    },
    annotations: { title: 'Reset desktop script state', readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  },
];

const jsInputSchema = boundary.object({ code: boundary.string, machine: boundary.optional(boundary.string) });
const resetInputSchema = boundary.object({ machine: boundary.optional(boundary.string) });
const runResultSchema = boundary.object({
  ok: boundary.boolean,
  text: boundary.string,
  images: boundary.array(boundary.object({ mime: boundary.string, base64: boundary.string })),
});
const resetResultSchema = boundary.object({ ok: boundary.boolean, reset: boundary.boolean });

/** Names that mean this machine. M2 resolves other Pane machines here. */
function isThisMachine(machine: string | undefined): boolean {
  if (machine === undefined) return true;
  const wanted = machine.trim().toLowerCase();
  const host = os.hostname().toLowerCase();
  return ['', 'local', 'localhost', 'this', host, host.replace(/\.local$/, '')].includes(wanted);
}

/** A reset sent after a cancelled or failed run; the next call waits so the reset can't land on it. */
let pendingReset: Promise<void> | undefined;

/** The name the user knows an MCP client by, for the foreground notice. */
export function agentName(clientName: string | undefined): string | undefined {
  if (!clientName) return undefined;
  if (/^claude/i.test(clientName)) return 'Claude Code';
  if (/^codex/i.test(clientName)) return 'Codex';
  if (/^cursor/i.test(clientName)) return 'Cursor';
  return clientName;
}

export async function callComputerUseTool(
  tool: ComputerUseTool,
  input: JsonObject,
  { connectionId, agent }: { connectionId: string; agent?: string },
  signal: AbortSignal,
): Promise<ComputerUseToolResult> {
  await pendingReset;
  let runStarted = false;
  try {
    if (tool.name === 'js_reset') {
      const { machine } = decodeBoundary(input, resetInputSchema);
      if (!isThisMachine(machine)) return errorText(OTHER_MACHINE_REFUSAL);
      const { reset } = await invokeDaemon('computer-use:reset', [{ connectionId }], resetResultSchema);
      return { content: [{ type: 'text', text: reset ? 'Script state discarded.' : 'There was no script state to discard.' }] };
    }
    const { code, machine } = decodeBoundary(input, jsInputSchema);
    if (!isThisMachine(machine)) return errorText(OTHER_MACHINE_REFUSAL);
    runStarted = true;
    // Inside a Pane terminal, the run's steps and replay land in that Pane.
    const sessionId = process.env.PANE_SESSION_ID?.trim() || undefined;
    const run = invokeDaemon('computer-use:run', [{ connectionId, code, sessionId, agent }], runResultSchema, { timeoutMs: RUN_TIMEOUT_MS });
    const result = await abortable(run, signal);
    const toolResult: ComputerUseToolResult = {
      content: [
        { type: 'text', text: result.text || '(no output)' },
        ...result.images.map((image): ComputerUseContent => ({ type: 'image', data: image.base64, mimeType: image.mime })),
      ],
    };
    if (!result.ok) toolResult.isError = true;
    return toolResult;
  } catch (error) {
    if (runStarted) {
      // A cancelled or timed-out run may still be going; ending its host is the only way to stop it.
      pendingReset = releaseComputerUseConnection(connectionId);
      await pendingReset;
    }
    return errorText(error instanceof Error ? error.message : String(error));
  }
}

/** Ends this connection's script host when the agent disconnects, so it does not wait out the idle timeout. */
export async function releaseComputerUseConnection(connectionId: string): Promise<void> {
  await invokeDaemon('computer-use:reset', [{ connectionId }], resetResultSchema, { timeoutMs: 2_000 }).then(() => undefined, () => undefined);
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new Error('Cancelled.'));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new Error('Cancelled.'));
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}

function errorText(text: string): ComputerUseToolResult {
  return { content: [{ type: 'text', text }], isError: true };
}
