import fs from 'fs';
import path from 'path';
import { PaneError } from '../../../../shared/paneError';
import { boundary, decodeOptionalBoundary } from '../../../../shared/validation/boundaryDecoder';

/**
 * The target's durable record of each move it built, so the move's outcome survives a lost message
 * or a restart on either machine. A move has one decision, made once and never undone:
 *
 *   built ──▶ committed ──▶ started
 *     └────▶ rolledBack
 *
 * `committed` is written before the first step that can't be undone (the start), and `rolledBack`
 * before the first undo, so the source can trust either: it retires its copy only on committed or
 * started, and releases it only on rolledBack. A move this machine has no entry for was never
 * committed here (every commit writes its entry first); asking to roll one back records that too,
 * so it can never start later.
 */

export type LedgerDecision = 'built' | 'committed' | 'started' | 'rolledBack';

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
}

export interface LedgerEntry {
  moveId: string;
  decision: LedgerDecision;
  at: string;
  plan?: CommitPlan;
  /** Tabs the start already handled, so a resumed start doesn't run them twice. */
  done: Record<string, 'resumed' | 'failed' | 'skipped'>;
}

const NEXT = {
  built: ['committed', 'rolledBack'],
  committed: ['started'],
  started: [],
  rolledBack: [],
} satisfies Record<LedgerDecision, readonly LedgerDecision[]>;

const tabSchema = boundary.object({
  id: boundary.string, type: boundary.string, title: boundary.string, agent: boundary.boolean, running: boundary.boolean,
  working: boundary.boolean, interrupted: boundary.boolean, conversationId: boundary.optional(boundary.string),
});
const entrySchema = boundary.object({
  moveId: boundary.string,
  decision: boundary.enumeration('built', 'committed', 'started', 'rolledBack'),
  at: boundary.string,
  plan: boundary.optional(boundary.object({
    sessionId: boundary.string, source: boundary.string, tabs: boundary.array(tabSchema), told: boundary.array(boundary.string),
    movedLine: boundary.string, setAside: boundary.array(boundary.string), leftovers: boundary.array(boundary.string),
    approvals: boundary.number, leftBehind: boundary.array(boundary.string), missingEnv: boundary.array(boundary.string),
  })),
  done: boundary.record(boundary.enumeration('resumed', 'failed', 'skipped')),
});

/** Finished moves are kept this long, so a source that comes back late still gets its answer. */
const KEEP_FINISHED_MS = 60 * 24 * 60 * 60_000;
const SAFE_ID = /^[A-Za-z0-9-]+$/;

function parseJson(text: string) {
  try { return JSON.parse(text); } catch { return null; }
}

export class MoveLedger {
  constructor(private readonly dir: string) {}

  private file(moveId: string): string {
    if (!SAFE_ID.test(moveId)) throw new PaneError('ERR_MOVE_ID', `Move id ${moveId} isn't one Pane made.`, 'Start the move again.');
    return path.join(this.dir, `${moveId}.json`);
  }

  get(moveId: string): LedgerEntry | undefined {
    let text: string;
    try {
      text = fs.readFileSync(this.file(moveId), 'utf8');
    } catch {
      return undefined;
    }
    const entry = decodeOptionalBoundary(parseJson(text), entrySchema);
    if (!entry) {
      // An entry that can't be read is not proof of anything: refuse rather than guess.
      throw new PaneError('ERR_MOVE_LEDGER_UNREADABLE', `This machine's record of move ${moveId} can't be read.`, `Check the disk on this machine; the record is ${this.file(moveId)}.`);
    }
    return entry;
  }

  /** Every move whose decision is still open or committed but not started: what a restart resumes. */
  pending(): LedgerEntry[] {
    let names: string[];
    try { names = fs.readdirSync(this.dir); } catch { return []; }
    const entries: LedgerEntry[] = [];
    for (const name of names) {
      if (!name.endsWith('.json')) continue;
      try {
        const entry = this.get(name.slice(0, -'.json'.length));
        if (entry && (entry.decision === 'built' || entry.decision === 'committed')) entries.push(entry);
      } catch (error) {
        console.warn('[SessionMove] A move record was skipped:', error);
      }
    }
    return entries;
  }

  /** Records the build's plan: the move is built and undecided. */
  built(moveId: string, plan: CommitPlan): LedgerEntry {
    const current = this.get(moveId);
    if (current) throw new PaneError('ERR_MOVE_LEDGER_EXISTS', `Move ${moveId} was already ${current.decision} here.`, 'Start the move again.');
    return this.write({ moveId, decision: 'built', at: new Date().toISOString(), plan, done: {} });
  }

  /**
   * Makes the move's one decision (or the next step after commit). Returns the entry; throws when
   * the move already went the other way. Deciding what it already is returns it unchanged.
   */
  decide(moveId: string, decision: Exclude<LedgerDecision, 'built'>): LedgerEntry {
    const current = this.get(moveId);
    if (!current) {
      // Only a roll-back can be recorded for a move this machine never built: it fences it off.
      if (decision !== 'rolledBack') throw new PaneError('ERR_MOVE_LEDGER_MISSING', `This machine has no record of move ${moveId}.`, 'Start the move again.');
      return this.write({ moveId, decision, at: new Date().toISOString(), done: {} });
    }
    if (current.decision === decision) return current;
    if (!NEXT[current.decision].some((next: LedgerDecision) => next === decision)) {
      throw new PaneError('ERR_MOVE_DECIDED', `Move ${moveId} is already ${current.decision} here, so it can't become ${decision}.`, current.decision === 'rolledBack' ? 'Start the move again.' : 'Use the Session on this machine.');
    }
    return this.write({ ...current, decision, at: new Date().toISOString() });
  }

  /** Notes a tab the start handled, so a resumed start skips it. */
  tabDone(moveId: string, tabId: string, result: LedgerEntry['done'][string]): void {
    const current = this.get(moveId);
    if (!current) return;
    this.write({ ...current, done: { ...current.done, [tabId]: result } });
  }

  /** Drops finished entries old enough that no source still waits on them. */
  prune(now = Date.now()): void {
    let names: string[];
    try { names = fs.readdirSync(this.dir); } catch { return; }
    for (const name of names) {
      if (!name.endsWith('.json')) continue;
      try {
        const entry = this.get(name.slice(0, -'.json'.length));
        if (entry && (entry.decision === 'started' || entry.decision === 'rolledBack') && now - Date.parse(entry.at) > KEEP_FINISHED_MS) {
          fs.rmSync(path.join(this.dir, name), { force: true });
        }
      } catch {
        // Unreadable entries stay for a person to look at.
      }
    }
  }

  /** Writes the entry whole and durably: a temporary file, flushed, then renamed over the old one. */
  private write(entry: LedgerEntry): LedgerEntry {
    fs.mkdirSync(this.dir, { recursive: true });
    const target = this.file(entry.moveId);
    const temporary = `${target}.${process.pid}.tmp`;
    const fd = fs.openSync(temporary, 'w');
    try {
      fs.writeSync(fd, JSON.stringify(entry));
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(temporary, target);
    return entry;
  }
}
