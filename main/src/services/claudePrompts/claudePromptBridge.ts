import { randomBytes, randomUUID } from 'crypto';
import { promises as fs, readFileSync } from 'fs';
import http from 'http';
import type { AddressInfo } from 'net';
import path from 'path';
import { isDeepStrictEqual } from 'util';
import type { AgentState } from '../../../../shared/types/agentStatus';
import type { NotifyQuestion, NotifyResult, NotifySource } from '../../../../shared/types/notify';
import type { JsonObject } from '../../../../shared/validation/boundaryDecoder';
import { parseClaudeHookEvent, transcriptBlocks, type ClaudeHookEvent } from './claudeHookEvent';
import type { ClaudeSettings } from './claudeLaunchSettings';
import { claudePromptQuestion, type ClaudePermissionDecision } from './claudePromptQuestion';

const HOOK_PATH = '/claude/hook';
const TOKEN_HEADER = 'X-Pane-Hook-Token';
const MAX_BODY_BYTES = 4 * 1024 * 1024;
/** Events that only tell Pane a prompt is over; Claude waits at most this long for each. */
const RELEASE_HOOK_TIMEOUT_SECONDS = 5;
/** How often Pane reads the transcript for an answer the hooks don't report (Esc in the dialog). */
const TRANSCRIPT_POLL_MS = 1_000;
const TRANSCRIPT_TAIL_BYTES = 1024 * 1024;

export const ANSWERED_IN_TERMINAL = 'Answered in the terminal';

/** What the bridge needs from Notify (NotifyQueue). */
interface ClaudePromptQueue {
  ask(request: { id: string; question: NotifyQuestion; source: NotifySource }, signal: AbortSignal): Promise<NotifyResult>;
  handOver(id: string): void;
  settle(id: string, summary: string): void;
}

export interface ClaudePromptBridgeOptions {
  queue: ClaudePromptQueue;
  /** Who asked, as Notify names it; undefined when the tab is gone. */
  source(panelId: string): NotifySource | undefined;
  /** Settings → AI agents → Answer prompts from Pane. */
  enabled(): boolean;
  /** How long Claude holds a prompt's hook open before it stops waiting on Pane. */
  hookTimeoutSeconds: number;
  /** Each prompt Pane shows, before it shows. */
  onPrompt?(): void;
}

interface WaitingPrompt {
  id: string;
  panelId: string;
  sessionId: string;
  toolName: string;
  toolInput: JsonObject;
  transcriptPath?: string;
  /** Matching tool calls the transcript already answered when the prompt arrived. */
  answeredBefore?: Set<string>;
  /** The tab's screen showed the dialog (agent status `blocked`). */
  shownBlocked?: boolean;
  abort: AbortController;
  poll?: ReturnType<typeof setInterval>;
}

/** What the endpoint answers a hook: a decision for a prompt, nothing otherwise. */
type HookOutput = { hookSpecificOutput: { hookEventName: 'PermissionRequest'; decision: ClaudePermissionDecision } } | Record<string, never>;

/**
 * Asks Claude's terminal prompts in Notify too. Each Claude tab Pane starts gets an http
 * PermissionRequest hook aimed at this loopback endpoint with a per-launch token; the hook is
 * held open as a Notify question until someone answers. Claude keeps its own dialog live
 * meanwhile, and applies whichever answer comes first: when the terminal wins, Pane closes the
 * question as answered there and lets the hook go with no decision.
 */
export class ClaudePromptBridge {
  private server?: http.Server;
  private url?: string;
  private readonly tokens = new Map<string, string>();
  private readonly waiting = new Map<string, WaitingPrompt>();

  constructor(private readonly options: ClaudePromptBridgeOptions) {}

  async start(): Promise<void> {
    if (this.server) return;
    const server = http.createServer((request, response) => void this.serve(request, response));
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => resolve());
    });
    server.unref();
    this.server = server;
    // SAFETY: a server listening on a TCP port reports an AddressInfo, not a pipe name.
    this.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}${HOOK_PATH}`;
  }

  async stop(): Promise<void> {
    for (const prompt of this.waiting.values()) prompt.abort.abort();
    const server = this.server;
    this.server = undefined;
    this.url = undefined;
    if (server) await new Promise<void>(resolve => server.close(() => resolve()));
  }

  /**
   * The hooks for one Claude launch in `panelId`, under a fresh token; undefined while the
   * setting is off or the endpoint isn't listening, so the tab launches without them.
   */
  hookSettings(panelId: string): ClaudeSettings | undefined {
    const url = this.url;
    if (!url || !this.options.enabled()) return undefined;
    const token = randomBytes(24).toString('hex');
    this.tokens.set(token, panelId);
    const hook = (timeout: number) => [{ hooks: [{ type: 'http', url, timeout, headers: { [TOKEN_HEADER]: token } }] }];
    const release = hook(RELEASE_HOOK_TIMEOUT_SECONDS);
    return {
      hooks: {
        PermissionRequest: hook(this.options.hookTimeoutSeconds),
        PostToolUse: release,
        PostToolUseFailure: release,
        UserPromptSubmit: release,
        Stop: release,
        SessionEnd: release,
      },
    };
  }

  /**
   * The tab's agent status, read from its screen. A tab that showed the dialog (`blocked`) and
   * then works or idles again was answered in its terminal; this is the first sign of it, before
   * any hook fires for a long command.
   */
  panelStatus(panelId: string, state: AgentState): void {
    for (const prompt of this.waiting.values()) {
      if (prompt.panelId !== panelId) continue;
      if (state === 'blocked') prompt.shownBlocked = true;
      else if (prompt.shownBlocked && (state === 'working' || state === 'idle')) this.answeredInTerminal(prompt);
    }
  }

  /** The tab closed: its tokens stop working and its questions expire. */
  forgetPanel(panelId: string): void {
    for (const [token, owner] of this.tokens) if (owner === panelId) this.tokens.delete(token);
    for (const prompt of this.waiting.values()) if (prompt.panelId === panelId) prompt.abort.abort();
  }

  private async serve(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
    const reply = (status: number, body: HookOutput) => {
      if (response.writableEnded || response.destroyed) return;
      response.writeHead(status, { 'content-type': 'application/json' });
      response.end(JSON.stringify(body));
    };
    if (request.method !== 'POST' || request.url !== HOOK_PATH) return reply(404, {});
    const panelId = this.tokens.get(String(request.headers[TOKEN_HEADER.toLowerCase()] ?? ''));
    if (!panelId) return reply(403, {});
    // Claude closes the request when the hook times out or Claude exits.
    const closed = new AbortController();
    response.on('close', () => { if (!response.writableEnded) closed.abort(); });
    const event = parseClaudeHookEvent(await readBody(request).catch(() => ''));
    if (!event) return reply(400, {});
    try {
      reply(200, await this.handle(panelId, event, closed.signal));
    } catch (error) {
      console.warn('[Claude prompts] A hook request failed; Claude falls back to its own dialog:', error);
      reply(200, {});
    }
  }

  private async handle(panelId: string, event: ClaudeHookEvent, closed: AbortSignal): Promise<HookOutput> {
    switch (event.hook_event_name) {
      case 'PermissionRequest':
        return this.ask(panelId, event, closed);
      case 'PostToolUse':
      case 'PostToolUseFailure':
        for (const prompt of this.prompts(panelId, event.session_id)) {
          if (sameCall(prompt, event.tool_name, event.tool_input)) this.answeredInTerminal(prompt);
        }
        return {};
      case 'UserPromptSubmit':
      case 'Stop':
        for (const prompt of this.prompts(panelId, event.session_id)) this.answeredInTerminal(prompt);
        return {};
      case 'SessionEnd':
        for (const prompt of this.prompts(panelId, event.session_id)) prompt.abort.abort();
        return {};
      default:
        return {};
    }
  }

  private async ask(panelId: string, event: ClaudeHookEvent, closed: AbortSignal): Promise<HookOutput> {
    // Questions are answered by typing into the terminal (a later package); a held hook would hide them.
    if (!this.options.enabled() || event.tool_name === 'AskUserQuestion') return {};
    const source = this.options.source(panelId);
    if (!source) return {};
    const { question, decide } = claudePromptQuestion(event, event.cwd ? repositoryName(event.cwd) : undefined);
    const prompt: WaitingPrompt = {
      id: randomUUID(),
      panelId,
      sessionId: event.session_id,
      toolName: event.tool_name ?? '',
      toolInput: event.tool_input ?? {},
      transcriptPath: event.transcript_path,
      abort: new AbortController(),
    };
    this.waiting.set(prompt.id, prompt);
    closed.addEventListener('abort', () => this.options.queue.handOver(prompt.id), { once: true });
    void this.watchTranscript(prompt);
    this.options.onPrompt?.();
    try {
      const result = await this.options.queue.ask({ id: prompt.id, question, source }, prompt.abort.signal);
      if (!('answer' in result)) return {};
      return { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: decide(result.answer, result.note) } };
    } finally {
      clearInterval(prompt.poll);
      this.waiting.delete(prompt.id);
    }
  }

  private answeredInTerminal(prompt: WaitingPrompt): void {
    this.options.queue.settle(prompt.id, ANSWERED_IN_TERMINAL);
  }

  private prompts(panelId: string, sessionId: string): WaitingPrompt[] {
    return [...this.waiting.values()].filter(prompt => prompt.panelId === panelId && prompt.sessionId === sessionId);
  }

  /**
   * Esc or No in the dialog fires no hook; Claude records it as the tool call's result. Pane
   * notes the matching calls already answered, then watches for a new one.
   */
  private async watchTranscript(prompt: WaitingPrompt): Promise<void> {
    if (!prompt.transcriptPath) return;
    prompt.answeredBefore = await answeredCalls(prompt);
    if (!this.waiting.has(prompt.id)) return;
    prompt.poll = setInterval(() => {
      void answeredCalls(prompt).then((answered) => {
        if ([...answered].some(id => !prompt.answeredBefore?.has(id))) this.answeredInTerminal(prompt);
      });
    }, TRANSCRIPT_POLL_MS);
    prompt.poll.unref();
  }
}

/**
 * The repository a folder belongs to, as Claude scopes project settings: a worktree's `.git` file
 * points into its repository's `.git/worktrees`, so the worktree shares its repository's name.
 */
function repositoryName(cwd: string): string {
  try {
    const gitdir = /^gitdir:\s*(.+)$/m.exec(readFileSync(path.join(cwd, '.git'), 'utf8'))?.[1]?.trim();
    const repository = gitdir && /^(.*)[\\/]\.git[\\/]worktrees[\\/][^\\/]+$/.exec(gitdir)?.[1];
    if (repository) return path.basename(repository);
  } catch {
    // A plain checkout has a .git folder, not a file.
  }
  return path.basename(cwd);
}

/** Ids of the transcript's calls to the prompt's tool, with its input, that already have a result. */
async function answeredCalls(prompt: WaitingPrompt): Promise<Set<string>> {
  const calls = new Set<string>();
  const answered = new Set<string>();
  for (const line of (await readTail(prompt.transcriptPath ?? '')).split('\n')) {
    for (const block of transcriptBlocks(line)) {
      if (block.type === 'tool_use' && sameCall(prompt, block.name, block.input)) calls.add(block.id);
      if (block.type === 'tool_result') answered.add(block.tool_use_id);
    }
  }
  return new Set([...calls].filter(id => answered.has(id)));
}

async function readTail(file: string): Promise<string> {
  try {
    const handle = await fs.open(file, 'r');
    try {
      const { size } = await handle.stat();
      const length = Math.min(size, TRANSCRIPT_TAIL_BYTES);
      const buffer = Buffer.alloc(length);
      await handle.read(buffer, 0, length, size - length);
      return buffer.toString('utf8');
    } finally {
      await handle.close();
    }
  } catch {
    return '';
  }
}

/** Claude adds the plan to ExitPlanMode's input for hooks, so plan approvals match by tool alone. */
function sameCall(prompt: WaitingPrompt, toolName: string | undefined, toolInput: JsonObject | undefined): boolean {
  return toolName === prompt.toolName && (prompt.toolName === 'ExitPlanMode' || isDeepStrictEqual(toolInput, prompt.toolInput));
}

function readBody(request: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('body too large'));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    request.on('error', reject);
  });
}
