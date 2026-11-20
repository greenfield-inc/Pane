import fs from 'fs';
import path from 'path';
import { PaneError, reasonOf } from '../../../../shared/paneError';
import { boundary, decodeOptionalBoundary, type JsonObject } from '../../../../shared/validation/boundaryDecoder';

/**
 * The target's durable record of each move, so the move's outcome survives a lost message or a
 * restart on either machine. A move has one decision, made once and never undone:
 *
 *   building ──▶ built ──▶ committed ──▶ started
 *      └──────────┴──▶ rolledBack
 *
 * `committed` is written before the first step that can't be undone (the start), and `rolledBack`
 * before the first undo, so the source can trust either: it retires its copy only once the move
 * started, and releases it only on rolledBack. A move this machine has no entry for was never
 * committed here (every build writes its entry first); asking to roll one back records that too,
 * so it can never start later. A record that exists but can't be read proves nothing: every read
 * of it throws, so the move stays undecided rather than being guessed.
 *
 * The entry also holds the build's undo journal: each step that changes something here is written
 * as data before (or, for a synchronous database step, right after) it runs, so a roll-back after
 * a restart undoes exactly what was made, and a roll-back cut short resumes where it stopped.
 */

export type LedgerDecision = 'building' | 'built' | 'committed' | 'started' | 'rolledBack';

/** One arriving tab, as the start needs it after a restart. */
export interface LedgerTab {
  id: string;
  type: string;
  title: string;
  /** An agent tab (or chat) starts on its conversation; a plain shell only if it was running. */
  agent: boolean;
  running: boolean;
  working: boolean;
  interrupted: boolean;
  /** The conversation the tab should be on once it starts, when it has one. */
  conversationId?: string;
}

/** Everything the start does, written when the build ends so a restarted Pane can still do it. */
export interface CommitPlan {
  sessionId: string;
  source: string;
  tabs: LedgerTab[];
  /** Tabs that hear the moved line: the orchestrator and each that was working. */
  told: string[];
  movedLine: string;
  /** Archived Panes a move back set aside, deleted for good once the move commits. */
  setAside: string[];
  /** Previous conversation copies kept for undo, removed once the move commits. */
  leftovers: string[];
  approvals: number;
  leftBehind: string[];
  missingEnv: string[];
  /** File preview tabs the build didn't carry, each with why; absent in a ledger from before T-42. */
  previewsNotCarried?: string[];
  /** The approvals the move carries, with this machine's paths, taken in at the commit (T-44). */
  approvalItems?: JsonObject[];
}

/** A conversation filed here, as its undo needs it: each file's target, staged and previous copy. */
export interface ConversationUndoPlan {
  placements: Array<{ target: string; staged: string; previous: string; hadPrevious: boolean }>;
  /** Folders the placement creates, removed again on undo. */
  created: string[];
}

/** How to undo one build step, as data. Each is safe to run when its step never ran, or twice. */
export type UndoStep =
  | { kind: 'deleteRefs'; repo: string; prefix: string }
  | { kind: 'restoreRef'; repo: string; ref: string; previous: string | null }
  | { kind: 'restoreBranch'; repo: string; branch: string; before: string | null }
  | { kind: 'removeWorktree'; repo: string; path: string }
  | { kind: 'removePane'; paneId: string }
  | { kind: 'restoreAside'; id: string; asideId: string; panelIds: Record<string, string>; hidden: number }
  | { kind: 'restoreFolder'; target: string; backup: string | null }
  | { kind: 'removeArriving'; sessionId: string; replaced: JsonObject | null }
  /** A tab that gave way to an arriving one; its saved panel is in the entry's side folder. */
  | { kind: 'putBackPanel'; panelId: string }
  | { kind: 'deletePanel'; panelId: string }
  | { kind: 'undoConversation'; plan: ConversationUndoPlan };

export interface JournalRecord {
  /** What the person would call it: "Pane “api”", "worktree /…", for the notice. */
  label: string;
  step: UndoStep;
  undone?: boolean;
  failures?: number;
  lastError?: string;
}

export interface LedgerEntry {
  moveId: string;
  decision: LedgerDecision;
  at: string;
  plan?: CommitPlan;
  /** Tabs the start already handled, so a resumed start doesn't run them twice. */
  done: Record<string, 'resumed' | 'failed' | 'skipped'>;
  journal: JournalRecord[];
  /** Every journal step was undone: nothing this move made is left here. */
  rollbackDone?: boolean;
  /** The person was told about steps that kept failing. */
  noticed?: boolean;
  /** The commit took in the move's approvals (T-44): a resumed commit doesn't take them in again. */
  approvalsTaken?: boolean;
}

const NEXT = {
  building: ['built', 'rolledBack'],
  built: ['committed', 'rolledBack'],
  committed: ['started'],
  started: [],
  rolledBack: [],
} satisfies Record<LedgerDecision, readonly LedgerDecision[]>;

const tabSchema = boundary.object({
  id: boundary.string, type: boundary.string, title: boundary.string, agent: boundary.boolean, running: boundary.boolean,
  working: boundary.boolean, interrupted: boundary.boolean, conversationId: boundary.optional(boundary.string),
});
const conversationPlanSchema = boundary.object({
  placements: boundary.array(boundary.object({ target: boundary.string, staged: boundary.string, previous: boundary.string, hadPrevious: boundary.boolean })),
  created: boundary.array(boundary.string),
});
const stepSchema = boundary.union(
  boundary.object({ kind: boundary.literal('deleteRefs'), repo: boundary.string, prefix: boundary.string }),
  boundary.object({ kind: boundary.literal('restoreRef'), repo: boundary.string, ref: boundary.string, previous: boundary.nullable(boundary.string) }),
  boundary.object({ kind: boundary.literal('restoreBranch'), repo: boundary.string, branch: boundary.string, before: boundary.nullable(boundary.string) }),
  boundary.object({ kind: boundary.literal('removeWorktree'), repo: boundary.string, path: boundary.string }),
  boundary.object({ kind: boundary.literal('removePane'), paneId: boundary.string }),
  boundary.object({ kind: boundary.literal('restoreAside'), id: boundary.string, asideId: boundary.string, panelIds: boundary.record(boundary.string), hidden: boundary.number }),
  boundary.object({ kind: boundary.literal('restoreFolder'), target: boundary.string, backup: boundary.nullable(boundary.string) }),
  boundary.object({ kind: boundary.literal('removeArriving'), sessionId: boundary.string, replaced: boundary.nullable(boundary.jsonObject) }),
  boundary.object({ kind: boundary.literal('putBackPanel'), panelId: boundary.string }),
  boundary.object({ kind: boundary.literal('deletePanel'), panelId: boundary.string }),
  boundary.object({ kind: boundary.literal('undoConversation'), plan: conversationPlanSchema }),
);
const entrySchema = boundary.object({
  moveId: boundary.string,
  decision: boundary.enumeration('building', 'built', 'committed', 'started', 'rolledBack'),
  at: boundary.string,
  plan: boundary.optional(boundary.object({
    sessionId: boundary.string, source: boundary.string, tabs: boundary.array(tabSchema), told: boundary.array(boundary.string),
    movedLine: boundary.string, setAside: boundary.array(boundary.string), leftovers: boundary.array(boundary.string),
    approvals: boundary.number, leftBehind: boundary.array(boundary.string), missingEnv: boundary.array(boundary.string),
    previewsNotCarried: boundary.optional(boundary.array(boundary.string)),
    approvalItems: boundary.optional(boundary.array(boundary.jsonObject)),
  })),
  done: boundary.record(boundary.enumeration('resumed', 'failed', 'skipped')),
  journal: boundary.array(boundary.object({
    label: boundary.string, step: stepSchema, undone: boundary.optional(boundary.boolean),
    failures: boundary.optional(boundary.number), lastError: boundary.optional(boundary.string),
  })),
  rollbackDone: boundary.optional(boundary.boolean),
  noticed: boundary.optional(boundary.boolean),
  approvalsTaken: boundary.optional(boundary.boolean),
});

/** Finished moves are kept this long, so a source that comes back late still gets its answer. */
const KEEP_FINISHED_MS = 60 * 24 * 60 * 60_000;
const SAFE_ID = /^[A-Za-z0-9._-]+$/;

function parseJson(text: string) {
  try { return JSON.parse(text); } catch { return null; }
}

/** A read failed because the file isn't there: the only failure that means "no record". */
function isMissing(error: Error): boolean {
  return 'code' in error && error.code === 'ENOENT';
}

export class MoveLedger {
  constructor(private readonly dir: string) {}

  private safe(value: string): string {
    if (!SAFE_ID.test(value) || value.startsWith('.')) throw new PaneError('ERR_MOVE_ID', `${value} isn't a name Pane made.`, 'Start the move again.');
    return value;
  }

  private file(moveId: string): string {
    return path.join(this.dir, `${this.safe(moveId)}.json`);
  }

  /** Side files of an entry (tabs set aside, which can be large). */
  private sideFolder(moveId: string): string {
    return path.join(this.dir, `${this.safe(moveId)}.files`);
  }

  /**
   * The move's entry, or undefined when this machine has none (the file doesn't exist). Any other
   * read failure (permissions, I/O, a damaged file) throws: an unknown record is never absence.
   */
  get(moveId: string): LedgerEntry | undefined {
    const file = this.file(moveId);
    let text: string;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch (error) {
      if (error instanceof Error && isMissing(error)) return undefined;
      throw new PaneError('ERR_MOVE_LEDGER_UNREADABLE', `This machine's record of move ${moveId} can't be read (${reasonOf(error)}), so the move stays undecided here.`, `Check the permissions and disk for ${file}; the move carries on once it can be read.`);
    }
    const entry = decodeOptionalBoundary(parseJson(text), entrySchema);
    if (!entry) {
      throw new PaneError('ERR_MOVE_LEDGER_UNREADABLE', `This machine's record of move ${moveId} is damaged, so the move stays undecided here.`, `Check ${file}; the move carries on once it can be read.`);
    }
    return entry;
  }

  private entries(): LedgerEntry[] {
    let names: string[];
    try {
      names = fs.readdirSync(this.dir);
    } catch (error) {
      if (error instanceof Error && isMissing(error)) return [];
      throw error;
    }
    const entries: LedgerEntry[] = [];
    for (const name of names) {
      if (!name.endsWith('.json')) continue;
      try {
        const entry = this.get(name.slice(0, -'.json'.length));
        if (entry) entries.push(entry);
      } catch (error) {
        console.warn('[SessionMove] A move record was skipped:', error);
      }
    }
    return entries;
  }

  /** Every move a restart has work for: an undecided build, a commit to finish, a roll-back to finish. */
  pending(): LedgerEntry[] {
    return this.entries().filter(entry => entry.decision === 'building' || entry.decision === 'built' || entry.decision === 'committed'
      || (entry.decision === 'rolledBack' && !entry.rollbackDone));
  }

  /** Opens the move's entry as its build starts. Refuses a move already recorded (fenced or decided). */
  begin(moveId: string): LedgerEntry {
    const current = this.get(moveId);
    if (current) throw new PaneError('ERR_MOVE_DECIDED', `Move ${moveId} was already ${current.decision === 'rolledBack' ? 'rolled back' : current.decision} here.`, 'Start the move again.');
    return this.write({ moveId, decision: 'building', at: new Date().toISOString(), done: {}, journal: [] });
  }

  /** Records how to undo the next build step. */
  journal(moveId: string, label: string, step: UndoStep): void {
    const current = this.require(moveId);
    if (current.decision !== 'building') throw new PaneError('ERR_MOVE_DECIDED', `Move ${moveId} is ${current.decision} here, so its build can't go on.`, 'Start the move again.');
    this.write({ ...current, journal: [...current.journal, { label, step }] });
  }

  /** Records the build's plan: the move is built and undecided. */
  built(moveId: string, plan: CommitPlan): LedgerEntry {
    const current = this.require(moveId);
    if (current.decision !== 'building') throw new PaneError('ERR_MOVE_DECIDED', `Move ${moveId} is already ${current.decision} here.`, 'Start the move again.');
    return this.write({ ...current, decision: 'built', at: new Date().toISOString(), plan });
  }

  /**
   * Makes the move's one decision (or the next step after commit). Returns the entry; throws when
   * the move already went the other way. Deciding what it already is returns it unchanged.
   */
  decide(moveId: string, decision: Exclude<LedgerDecision, 'building' | 'built'>): LedgerEntry {
    const current = this.get(moveId);
    if (!current) {
      // Only a roll-back can be recorded for a move this machine never built: it fences it off.
      if (decision !== 'rolledBack') throw new PaneError('ERR_MOVE_LEDGER_MISSING', `This machine has no record of move ${moveId}.`, 'Start the move again.');
      return this.write({ moveId, decision, at: new Date().toISOString(), done: {}, journal: [], rollbackDone: true });
    }
    if (current.decision === decision) return current;
    if (!NEXT[current.decision].some((next: LedgerDecision) => next === decision)) {
      throw new PaneError('ERR_MOVE_DECIDED', `Move ${moveId} is already ${current.decision} here, so it can't become ${decision}.`, current.decision === 'rolledBack' ? 'Start the move again.' : 'Use the Session on this machine.');
    }
    return this.write({ ...current, decision, at: new Date().toISOString() });
  }

  /** Records that the commit took in the move's approvals. */
  approvalsTaken(moveId: string): void {
    this.write({ ...this.require(moveId), approvalsTaken: true });
  }

  /** Notes a tab the start handled, so a resumed start skips it. */
  tabDone(moveId: string, tabId: string, result: LedgerEntry['done'][string]): void {
    const current = this.require(moveId);
    this.write({ ...current, done: { ...current.done, [tabId]: result } });
  }

  /** Notes how a journal step's undo went. */
  undoResult(moveId: string, index: number, error?: string): JournalRecord {
    const current = this.require(moveId);
    const record = current.journal[index];
    const next: JournalRecord = { label: record.label, step: record.step };
    if (error === undefined) {
      next.undone = true;
    } else {
      next.failures = (record.failures ?? 0) + 1;
      next.lastError = error;
    }
    this.write({ ...current, journal: current.journal.map((item, at) => at === index ? next : item) });
    return next;
  }

  /** Marks the roll-back finished (nothing this move made is left), or the person told about what is. */
  mark(moveId: string, field: 'rollbackDone' | 'noticed'): void {
    const current = this.require(moveId);
    this.write({ ...current, [field]: true });
  }

  /** Saves a side file (a tab set aside) before the step it serves. */
  saveSide(moveId: string, name: string, value: JsonObject): void {
    const folder = this.sideFolder(moveId);
    fs.mkdirSync(folder, { recursive: true });
    this.writeAtomic(path.join(folder, `${this.safe(name)}.json`), JSON.stringify(value));
  }

  /** A side file, or undefined when it was never written. */
  readSide(moveId: string, name: string): JsonObject | undefined {
    let text: string;
    try {
      text = fs.readFileSync(path.join(this.sideFolder(moveId), `${this.safe(name)}.json`), 'utf8');
    } catch (error) {
      if (error instanceof Error && isMissing(error)) return undefined;
      throw error;
    }
    return decodeOptionalBoundary(parseJson(text), boundary.jsonObject);
  }

  /** Drops finished entries old enough that no source still waits on them. */
  prune(now = Date.now()): void {
    let entries: LedgerEntry[];
    try { entries = this.entries(); } catch { return; }
    for (const entry of entries) {
      const finished = entry.decision === 'started' || (entry.decision === 'rolledBack' && entry.rollbackDone);
      if (finished && now - Date.parse(entry.at) > KEEP_FINISHED_MS) {
        fs.rmSync(this.file(entry.moveId), { force: true });
        fs.rmSync(this.sideFolder(entry.moveId), { recursive: true, force: true });
      }
    }
  }

  private require(moveId: string): LedgerEntry {
    const current = this.get(moveId);
    if (!current) throw new PaneError('ERR_MOVE_LEDGER_MISSING', `This machine has no record of move ${moveId}.`, 'Start the move again.');
    return current;
  }

  private write(entry: LedgerEntry): LedgerEntry {
    fs.mkdirSync(this.dir, { recursive: true });
    this.writeAtomic(this.file(entry.moveId), JSON.stringify(entry));
    return entry;
  }

  /** Writes a file whole and durably: a temporary file, flushed, then renamed over the old one. */
  private writeAtomic(target: string, text: string): void {
    const temporary = `${target}.${process.pid}.tmp`;
    const fd = fs.openSync(temporary, 'w');
    try {
      fs.writeSync(fd, text);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(temporary, target);
  }
}
