import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import { randomUUID } from 'crypto';
import { promisify } from 'util';
import { boundary, decodeOptionalBoundary, type JsonObject, type JsonValue } from '../../../../shared/validation/boundaryDecoder';
import type { ComputerUseEngine, EngineImage, EngineResult, EngineStatus } from './engine';
import { codexLaunchEnv, locateCodexRuntime, type CodexRuntime, type CodexRuntimeLookup } from './codexRuntime';

const execFileAsync = promisify(execFile);

const START_TIMEOUT_MS = 30_000;
/** The runtime's own `js` default is 30 s; settling and approvals can add to it. */
const CELL_TIMEOUT_MS = 60_000;
const CALL_TIMEOUT_MS = CELL_TIMEOUT_MS + 15_000;

/**
 * The Codex engine's raw tools, one `js` cell each. Apps are named by `app` (name, bundle id or
 * path) on macOS and by `window_id` on Linux and Windows. Points are `element_index`, or `x` and `y`.
 * Each body runs with `a` (the args), `target()` and `point()` in scope and returns the result data.
 */
const VERBS = new Map(Object.entries({
  list_apps: 'return { apps: await cua.listApps({ emit: false }) };',
  list_windows: 'return { windows: cua.listWindows ? await cua.listWindows({ emit: false }) : [] };',
  launch_app: 'if (!cua.computer.launch_app) throw new Error("This Codex runtime can\'t launch apps; open the app first."); await cua.computer.launch_app({ app: a.app }); return {};',
  get_app_state: 'return { state: await (await target()).getAXState({ emit: false, disableDiffing: a.disable_diff === true }) };',
  screenshot: 'await nodeRepl.emitImage(await (await target()).getScreenshot({ emit: false })); return {};',
  // One read for both: a screenshot alone also moves the runtime's diff baseline.
  state_and_screenshot: 'const r = await (await target()).getAXStateAndScreenshot({ emit: false }); if (r.screenshot) await nodeRepl.emitImage(r.screenshot); return { state: r.state };',
  click: 'await (await target()).click(point(), { mouseButton: a.mouse_button, clickCount: a.click_count }); return {};',
  drag: 'await (await target()).drag(a.from, a.to); return {};',
  scroll: 'await (await target()).scroll(point(), a.direction, a.pixels !== undefined ? { pixels: a.pixels } : a.pages); return {};',
  type_text: 'await (await target()).typeText(a.text); return {};',
  press_key: 'await (await target()).pressKey(a.key); return {};',
  paste: 'await (await target()).paste(a.text, { format: a.format }); return {};',
  set_value: 'await (await target()).setValue(a.element_index, a.value); return {};',
  select_text: 'await (await target()).selectText(a.element_index, a.text, { prefix: a.prefix, suffix: a.suffix, selectionType: a.selection_type }); return {};',
  perform_secondary_action: 'await (await target()).performSecondaryAction(a.element_index, a.action); return {};',
}));

/** On Windows the runtime brings a window to the front to send it input. */
const INPUT_VERBS = new Set(['click', 'drag', 'scroll', 'type_text', 'press_key', 'paste', 'set_value', 'select_text', 'perform_secondary_action']);

function cellFor(tool: string, args: JsonObject, marker: string): string | null {
  const body = VERBS.get(tool);
  if (!body) return null;
  // An async wrapper keeps every name local, so cells never collide in the runtime's persistent scope.
  return `await (async () => {
  const a = ${JSON.stringify(args)};
  const pane = (globalThis.__pane ??= { targets: new Map() });
  const target = async () => {
    const ref = a.window_id !== undefined ? { windowId: a.window_id } : a.app;
    const key = JSON.stringify(ref);
    if (!pane.targets.has(key)) pane.targets.set(key, await cua.getApp(ref));
    return pane.targets.get(key);
  };
  const point = () => a.element_index ?? [a.x, a.y];
  let outcome;
  try {
    outcome = { ok: true, data: (await (async () => { ${body} })()) ?? {} };
  } catch (error) {
    outcome = { ok: false, message: String(error?.message ?? error) };
  }
  nodeRepl.write(${JSON.stringify(marker)} + JSON.stringify(outcome));
})();`;
}

interface CodexEngineOptions {
  locate?: () => Promise<CodexRuntimeLookup>;
  env?: NodeJS.ProcessEnv;
}

const contentSchema = boundary.array(boundary.object({
  type: boundary.string,
  text: boundary.optional(boundary.string),
  data: boundary.optional(boundary.string),
  mimeType: boundary.optional(boundary.string),
}));
const toolResultSchema = boundary.object({ content: contentSchema, isError: boundary.optional(boundary.boolean) });
const elicitationSchema = boundary.object({ _meta: boundary.optional(boundary.object({ connector_id: boundary.optional(boundary.string) })) });

const rpcMessageSchema = boundary.object({
  id: boundary.optional(boundary.union(boundary.number, boundary.string)),
  method: boundary.optional(boundary.string),
  params: boundary.optional(boundary.json),
  result: boundary.optional(boundary.json),
  error: boundary.optional(boundary.object({ message: boundary.optional(boundary.string) })),
});

interface RpcMessage {
  id?: number | string;
  method?: string;
  params?: JsonValue;
  result?: JsonValue;
  error?: { message?: string };
}

/**
 * The user's installed Codex runtime, driven through OpenAI's own signed launcher. Pane is the
 * launcher's MCP client: it sends one `js` cell per raw verb and answers the runtime's per-app
 * approval itself, so runs never prompt.
 */
class CodexEngine implements ComputerUseEngine {
  readonly id = 'codex' as const;
  private server: Promise<CodexServer> | null = null;

  constructor(private readonly options: CodexEngineOptions) {}

  async status(): Promise<EngineStatus> {
    const lookup = await this.locate();
    if (!lookup.found) return { installed: false, permissions: {}, desktopSession: this.desktopSession(), detail: lookup.reason };
    // ChatGPT's own service holds the macOS grants; the self-test shows whether they are in place.
    return { installed: true, version: lookup.runtime.version, permissions: {}, desktopSession: this.desktopSession(lookup.runtime.platform) };
  }

  async call(tool: string, args: JsonObject): Promise<EngineResult> {
    // A fresh marker per call, so no text an app shows can pass for the result.
    const marker = `@@pane-result-${randomUUID()}@@`;
    const cell = cellFor(tool, args, marker);
    if (!cell) return { ok: false, error: { code: 'unknown_tool', message: `The Codex runtime has no tool named ${tool}.` } };
    let server: CodexServer;
    try {
      server = await this.ensureServer();
    } catch (error) {
      return { ok: false, error: { code: 'engine_unavailable', message: error instanceof Error ? error.message : String(error) } };
    }
    const result = await server.runCell(cell, marker);
    if (result.ok && server.platform === 'win32' && INPUT_VERBS.has(tool)) {
      return { ...result, data: { ...asObject(result.data), broughtForward: true } };
    }
    return result;
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = null;
    (await server?.catch(() => null))?.close();
  }

  private locate(): Promise<CodexRuntimeLookup> {
    return (this.options.locate ?? locateCodexRuntime)();
  }

  private desktopSession(platform: NodeJS.Platform = process.platform): boolean {
    const env = this.options.env ?? process.env;
    return platform !== 'linux' || Boolean(env.DISPLAY || env.WAYLAND_DISPLAY);
  }

  private ensureServer(): Promise<CodexServer> {
    const existing = this.server;
    if (existing) return existing;
    const started = this.startServer();
    this.server = started;
    started.then((server) => server.onExit(() => {
      if (this.server === started) this.server = null;
    }), () => {
      if (this.server === started) this.server = null;
    });
    return started;
  }

  private async startServer(): Promise<CodexServer> {
    const lookup = await this.locate();
    if (!lookup.found) throw new Error(lookup.reason);
    if (lookup.runtime.platform === 'darwin') await allowForbiddenTargets();
    const env = codexLaunchEnv(lookup.runtime, this.options.env ?? process.env, `pane-${randomUUID()}`);
    return CodexServer.start(lookup.runtime, env);
  }
}

/**
 * Lets the runtime operate apps it refuses by default, such as terminals (plan decision, 4 Oct).
 * The runtime reads this user-wide default live.
 */
async function allowForbiddenTargets(): Promise<void> {
  const { stdout } = await execFileAsync('defaults', ['read', '-g', 'ComputerUseAllowForbiddenTargets']).catch(() => ({ stdout: '' }));
  if (stdout.trim() === '1') return;
  await execFileAsync('defaults', ['write', '-g', 'ComputerUseAllowForbiddenTargets', '-bool', 'YES']);
}

/** One running launcher and its MCP session. */
class CodexServer {
  private nextId = 1;
  private buffer = '';
  private readonly pending = new Map<number, (message: RpcMessage) => void>();
  private readonly exitHandlers: Array<() => void> = [];
  private exited = false;
  private stderrTail = '';

  private constructor(private readonly child: ChildProcessWithoutNullStreams, readonly platform: NodeJS.Platform) {
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => this.onData(chunk));
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
      this.stderrTail = (this.stderrTail + chunk).slice(-2000);
    });
    // A failed spawn reports only 'error'; a crash reports 'exit'.
    child.on('error', (error) => this.finish(error.message));
    // Writing after the runtime closed its stdin raises EPIPE here; unhandled, it would take down the daemon.
    child.stdin.on('error', (error) => this.finish(error.message));
    child.on('exit', () => this.finish(this.stderrTail.trim().split('\n').pop() ?? ''));
  }

  private finish(reason: string): void {
    if (this.exited) return;
    this.exited = true;
    for (const resolve of this.pending.values()) resolve({ error: { message: `The Codex runtime exited${reason ? `: ${reason}` : '.'}` } });
    this.pending.clear();
    for (const handler of this.exitHandlers) handler();
  }

  static async start(runtime: CodexRuntime, env: NodeJS.ProcessEnv): Promise<CodexServer> {
    const child = spawn(runtime.node, [runtime.launcher], { env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    const server = new CodexServer(child, runtime.platform);
    const init = await server.request('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: { elicitation: {} },
      clientInfo: { name: 'pane', version: '1' },
    }, START_TIMEOUT_MS);
    if (init.error || init.result === undefined) {
      server.close();
      throw new Error(`The Codex runtime didn't start: ${init.error?.message ?? 'no answer'}`);
    }
    server.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    return server;
  }

  onExit(handler: () => void): void {
    if (this.exited) handler();
    else this.exitHandlers.push(handler);
  }

  close(): void {
    this.child.kill();
  }

  async runCell(code: string, marker: string): Promise<EngineResult> {
    const reply = await this.request('tools/call', { name: 'js', arguments: { code, timeout_ms: CELL_TIMEOUT_MS } }, CALL_TIMEOUT_MS);
    if (reply.error) return { ok: false, error: { code: 'engine_error', message: reply.error.message ?? 'The Codex runtime failed.' } };
    const result = decodeOptionalBoundary(reply.result, toolResultSchema);
    if (!result) return { ok: false, error: { code: 'engine_error', message: 'The Codex runtime sent an unreadable result.' } };

    const text = result.content.flatMap((item) => (item.type === 'text' && item.text ? [item.text] : [])).join('\n');
    const images: EngineImage[] = result.content.flatMap((item) => (item.type === 'image' && item.data ? [{ mime: item.mimeType ?? 'image/png', base64: item.data }] : []));
    const at = text.indexOf(marker);
    const outcome = at === -1 ? undefined : parseOutcome(text.slice(at + marker.length).split('\n', 1)[0]);
    if (!outcome) {
      return { ok: false, error: { code: 'codex_error', message: firstLine(text) || 'The Codex runtime returned no result.' } };
    }
    if (!outcome.ok) return { ok: false, error: { code: 'codex_error', message: outcome.message ?? 'The Codex runtime failed.' } };
    const ok: EngineResult = { ok: true, data: outcome.data };
    if (images.length > 0) ok.images = images;
    return ok;
  }

  private request(method: string, params: JsonObject, timeoutMs: number): Promise<RpcMessage> {
    if (this.exited) return Promise.resolve({ error: { message: 'The Codex runtime is not running.' } });
    const id = this.nextId++;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve({ error: { message: `The Codex runtime didn't answer within ${Math.round(timeoutMs / 1000)} s.` } });
      }, timeoutMs);
      this.pending.set(id, (message) => {
        clearTimeout(timer);
        resolve(message);
      });
      this.send({ jsonrpc: '2.0', id, method, params });
    });
  }

  private send(message: JsonObject): void {
    if (!this.exited) this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    for (let newline = this.buffer.indexOf('\n'); newline !== -1; newline = this.buffer.indexOf('\n')) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (!line) continue;
      const message = parseMessage(line);
      if (!message) continue;
      if (message.method !== undefined) {
        if (message.id !== undefined) this.answerServerRequest(message);
        continue;
      }
      const id = decodeOptionalBoundary(message.id, boundary.number);
      if (id !== undefined) {
        this.pending.get(id)?.(message);
        this.pending.delete(id);
      }
    }
  }

  /** Pre-answers the runtime's per-app approval; Pane's own setting already decided computer use is on. */
  private answerServerRequest(message: RpcMessage): void {
    if (message.method === 'elicitation/create') {
      const isComputerUse = decodeOptionalBoundary(message.params, elicitationSchema)?._meta?.connector_id === 'computer-use';
      this.send({ jsonrpc: '2.0', id: message.id ?? null, result: isComputerUse ? { action: 'accept', content: {} } : { action: 'decline' } });
      return;
    }
    if (message.method === 'ping') {
      this.send({ jsonrpc: '2.0', id: message.id ?? null, result: {} });
      return;
    }
    this.send({ jsonrpc: '2.0', id: message.id ?? null, error: { code: -32601, message: 'Method not found' } });
  }
}

const outcomeSchema = boundary.object({ ok: boundary.boolean, data: boundary.optional(boundary.json), message: boundary.optional(boundary.string) });

function parseMessage(line: string): RpcMessage | undefined {
  try {
    return decodeOptionalBoundary(JSON.parse(line), rpcMessageSchema);
  } catch {
    return undefined;
  }
}

function parseOutcome(json: string) {
  try {
    return decodeOptionalBoundary(JSON.parse(json), outcomeSchema);
  } catch {
    return undefined;
  }
}

function asObject(value: JsonValue | undefined): JsonObject {
  return decodeOptionalBoundary(value, boundary.jsonObject) ?? {};
}

function firstLine(text: string): string {
  return text.trim().split('\n', 1)[0] ?? '';
}

export function createCodexEngine(options: CodexEngineOptions = {}): ComputerUseEngine {
  return new CodexEngine(options);
}
