import fs from 'fs';
import path from 'path';
import { randomBytes } from 'crypto';
import type { AutopilotAgentState, AutopilotRunInfo, AutopilotStack } from '../../../../shared/types/autopilot';
import { boundary, decodeOptionalBoundary, type BoundarySchema } from '../../../../shared/validation/boundaryDecoder';

/** What state.json keeps: the last agent state and where the walk is. */
export interface AutopilotRunState {
  state: AutopilotAgentState;
  walkSessionId?: string;
  /** Sentinel was on (it is off again after a Pane restart, D-57). */
  sentinel?: boolean;
}

const RUN_ID = /^[A-Za-z0-9-]{1,80}$/;
/** The log is for people reading the run folder; it rolls over past this size. */
const LOG_LIMIT_BYTES = 2 * 1024 * 1024;

const tabSchema = boundary.union(
  boundary.object({ kind: boundary.literal('item'), label: boundary.string, notifyId: boundary.nonEmptyString }),
  boundary.object({ kind: boundary.literal('file'), label: boundary.string, path: boundary.nonEmptyString }),
  boundary.object({ kind: boundary.literal('url'), label: boundary.string, url: boundary.nonEmptyString }),
  boundary.object({ kind: boundary.literal('session'), label: boundary.string, sessionId: boundary.nonEmptyString }),
);
const refSchema = boundary.union(
  boundary.object({ kind: boundary.literal('item'), notifyId: boundary.nonEmptyString }),
  boundary.object({ kind: boundary.literal('file'), path: boundary.nonEmptyString }),
  boundary.object({ kind: boundary.literal('url'), url: boundary.nonEmptyString }),
  boundary.object({ kind: boundary.literal('session'), sessionId: boundary.nonEmptyString }),
);
const stackSchema: BoundarySchema<AutopilotStack> = boundary.object({
  entries: boundary.array(boundary.object({
    id: boundary.nonEmptyString,
    ref: refSchema,
    title: boundary.string,
    sessionId: boundary.optional(boundary.string),
    sessionName: boundary.optional(boundary.string),
    tabs: boundary.array(tabSchema),
    note: boundary.optional(boundary.string),
    addedAt: boundary.number,
    byAutopilot: boundary.optional(boundary.boolean),
    doneAt: boundary.optional(boundary.number),
  })),
  shownId: boundary.nullable(boundary.string),
});
const stateSchema: BoundarySchema<AutopilotRunState> = boundary.object({
  state: boundary.enumeration('stopped', 'running', 'paused'),
  walkSessionId: boundary.optional(boundary.string),
  sentinel: boundary.optional(boundary.boolean),
});
const runMetaSchema = boundary.object({ createdAt: boundary.nonEmptyString });

const EMPTY_STACK: AutopilotStack = { entries: [], shownId: null };

/**
 * Autopilot's own store (D-69), apart from Sessions: `<root>/runs/<run-id>/` holds AGENTS.md,
 * docs/, stack.json, state.json, run.json and log; `<root>/current` names the active run.
 * Session cleanup never reads or touches it.
 */
export class AutopilotStore {
  constructor(readonly root: string) {}

  current(): AutopilotRunInfo | null {
    let id: string;
    try { id = fs.readFileSync(path.join(this.root, 'current'), 'utf8').trim(); } catch { return null; }
    return this.run(id);
  }

  run(id: string): AutopilotRunInfo | null {
    if (!RUN_ID.test(id)) return null;
    const folder = this.folder(id);
    if (!fs.existsSync(folder)) return null;
    const meta = this.readJson(path.join(folder, 'run.json'), runMetaSchema);
    return { id, folder, docsFolder: path.join(folder, 'docs'), createdAt: meta?.createdAt ?? fs.statSync(folder).birthtime.toISOString() };
  }

  /** A new run: its folder, an empty stack, and `current` pointing at it. Earlier runs stay. */
  createRun(now = new Date()): AutopilotRunInfo {
    const id = `${now.toISOString().replace(/[:.]/g, '-').replace(/Z$/, '')}-${randomBytes(3).toString('hex')}`;
    const folder = this.folder(id);
    fs.mkdirSync(path.join(folder, 'docs'), { recursive: true, mode: 0o700 });
    this.writeJson(path.join(folder, 'run.json'), { createdAt: now.toISOString() });
    this.writeStack(id, EMPTY_STACK);
    this.writeState(id, { state: 'stopped' });
    fs.writeFileSync(path.join(folder, 'log'), `${now.toISOString()} run created\n`, { mode: 0o600 });
    this.atomicWrite(path.join(this.root, 'current'), `${id}\n`);
    return { id, folder, docsFolder: path.join(folder, 'docs'), createdAt: now.toISOString() };
  }

  readStack(id: string): AutopilotStack {
    const file = path.join(this.folder(id), 'stack.json');
    if (!fs.existsSync(file)) return EMPTY_STACK;
    const stack = this.readJson(file, stackSchema);
    if (!stack) {
      this.log(id, 'stack.json could not be read; showing an empty stack (the file is kept as stack.json.damaged)');
      try { fs.copyFileSync(file, `${file}.damaged`); } catch { /* best effort */ }
      return EMPTY_STACK;
    }
    return stack;
  }

  writeStack(id: string, stack: AutopilotStack): void {
    this.writeJson(path.join(this.folder(id), 'stack.json'), stack);
  }

  readState(id: string): AutopilotRunState {
    return this.readJson(path.join(this.folder(id), 'state.json'), stateSchema) ?? { state: 'stopped' };
  }

  writeState(id: string, state: AutopilotRunState): void {
    this.writeJson(path.join(this.folder(id), 'state.json'), state);
  }

  log(id: string, line: string, now = new Date()): void {
    const file = path.join(this.folder(id), 'log');
    try {
      if (fs.existsSync(file) && fs.statSync(file).size > LOG_LIMIT_BYTES) fs.renameSync(file, `${file}.1`);
      fs.appendFileSync(file, `${now.toISOString()} ${line.replace(/\s*\n\s*/g, ' ')}\n`, { mode: 0o600 });
    } catch { /* The log is a convenience; it never fails an action. */ }
  }

  private folder(id: string): string {
    return path.join(this.root, 'runs', id);
  }

  private readJson<T>(file: string, schema: BoundarySchema<T>): T | undefined {
    try { return decodeOptionalBoundary(JSON.parse(fs.readFileSync(file, 'utf8')), schema); } catch { return undefined; }
  }

  private writeJson(file: string, value: AutopilotStack | AutopilotRunState | { createdAt: string }): void {
    this.atomicWrite(file, `${JSON.stringify(value, null, 2)}\n`);
  }

  private atomicWrite(file: string, content: string): void {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const temp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
    fs.writeFileSync(temp, content, { mode: 0o600 });
    fs.renameSync(temp, file);
  }
}
