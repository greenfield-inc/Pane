import { appendFileSync, closeSync, existsSync, openSync, readSync, statSync } from 'fs';
import { boundary, decodeBoundary, decodeOptionalBoundary } from '../../../../shared/validation/boundaryDecoder';
import { NativeInput } from './nativeInput';
import { NativeCheckpoint, type NativeCheckpointState } from './nativeCheckpoint';

const MAX_JOURNAL_BYTES = 16 * 1024 * 1024;
const eventSchema = boundary.object({
  session_id: boundary.string,
  hook_event_name: boundary.string,
  cwd: boundary.optional(boundary.string),
  source: boundary.optional(boundary.string),
  permission_mode: boundary.optional(boundary.string),
  effort: boundary.optional(boundary.object({ level: boundary.optional(boundary.string) })),
  background_tasks: boundary.optional(boundary.array(boundary.jsonObject)),
  session_crons: boundary.optional(boundary.array(boundary.jsonObject)),
  user_submission: boundary.optional(boundary.boolean),
});

/** Only lifecycle facts cross this boundary; prompts, credentials and tool inputs
 * are deliberately excluded. This file belongs to one native runtime generation. */
// oxlint-disable-next-line anti-slop/no-unknown-parameters -- Native hook payloads are decoded with eventSchema before anything is recorded.
export function recordNativeHook(file: string, payload: unknown): void {
  const event = decodeOptionalBoundary(payload, eventSchema);
  if (existsSync(file) && statSync(file).size > MAX_JOURNAL_BYTES) return;
  const safe = event ? {
    ...event,
    user_submission: event.hook_event_name === 'UserPromptSubmit'
      && (() => {
        const prompt = decodeOptionalBoundary(payload, boundary.object({ prompt: boundary.string }))?.prompt;
        return prompt !== undefined && !prompt.trimStart().startsWith('<task-notification>');
      })(),
    background_tasks: event.background_tasks?.map(() => ({})),
    session_crons: event.session_crons?.map(() => ({})),
  } : { invalid: true };
  appendFileSync(file, `${JSON.stringify(safe)}\n`, { encoding: 'utf8', mode: 0o600 });
}

export class NativeHookJournal {
  private offset = 0;
  private partial = '';
  private fault?: string;
  private started = false;
  private source?: string;
  private finished = false;
  private permissionMode?: string;
  private effort?: string;
  private directory?: string;
  private pendingSubmissions = 0;
  private composerDirty = false;
  private readonly terminalInput = new NativeInput();
  private awaitingPermission = false;
  private readonly observer: NativeCheckpoint;

  constructor(readonly file: string, readonly conversationId: string) {
    this.observer = new NativeCheckpoint(conversationId);
  }

  private drain(): void {
    if (this.fault || !existsSync(this.file)) return;
    try {
      const size = statSync(this.file).size;
      if (size > MAX_JOURNAL_BYTES || size < this.offset) throw new Error('Native lifecycle journal is incomplete or exceeds its limit');
      if (size === this.offset) return;
      const fd = openSync(this.file, 'r');
      let bytes: Buffer;
      try {
        bytes = Buffer.alloc(size - this.offset);
        const length = readSync(fd, bytes, 0, bytes.length, this.offset);
        bytes = bytes.subarray(0, length);
        this.offset += length;
      } finally { closeSync(fd); }
      const lines = `${this.partial}${bytes.toString('utf8')}`.split('\n');
      this.partial = lines.pop() ?? '';
      for (const line of lines) {
        const event = decodeBoundary(JSON.parse(line), eventSchema);
        if (event.session_id !== this.conversationId) {
          this.observer.input();
          continue;
        }
        this.observer.observe(event);
        if (event.hook_event_name === 'UserPromptSubmit' && event.user_submission && this.pendingSubmissions > 0) this.pendingSubmissions--;
        if (event.hook_event_name === 'PermissionRequest') this.awaitingPermission = true;
        if (event.hook_event_name === 'PostToolUse') this.awaitingPermission = false;
        if (event.hook_event_name === 'SessionStart') { this.started = true; this.source = event.source; }
        if (event.hook_event_name === 'SessionEnd') this.finished = true;
        if (event.permission_mode) this.permissionMode = event.permission_mode;
        if (event.effort?.level) this.effort = event.effort.level;
        if (event.cwd) this.directory = event.cwd;
      }
    } catch (error) { this.fault = error instanceof Error ? error.message : String(error); }
  }

  input(data: string): void {
    this.drain();
    const userInput = this.terminalInput.take(data);
    if (!userInput) return;
    // First-run trust navigation precedes SessionStart and is not a prompt.
    // Typed startup prompts still enter the same queue accounting as usual.
    if (!this.started && !this.composerDirty && !this.pendingSubmissions && userInput.replace(/[\r\t]/g, '').split('\x1b').every((part, index) => index === 0 ? part === '' : /^\[[ABCD]$/.test(part))) return;
    this.observer.input();
    if (this.awaitingPermission) return;
    const submissions = userInput.split('\r').length - 1;
    this.pendingSubmissions += submissions;
    this.composerDirty = !userInput.endsWith('\r');
  }
  ended(): boolean { this.drain(); return this.finished && !this.fault; }
  initialized(): boolean { this.drain(); return this.started && !this.fault; }
  resumed(): boolean { this.drain(); return this.initialized() && this.source === 'resume'; }
  config() {
    this.drain();
    return { permissionMode: this.permissionMode, effort: this.effort, cwd: this.directory };
  }
  checkpoint(): NativeCheckpointState {
    this.drain();
    if (this.fault) return { ready: false, reason: `${this.fault}. Keep using Terminal; this runtime cannot safely switch.` };
    if (this.pendingSubmissions || this.composerDirty || this.terminalInput.incomplete()) return { ready: false, reason: 'Terminal input has not reached a confirmed turn. Submit the draft and wait for queued prompts to finish before switching.' };
    return this.observer.read();
  }
}
