import type { Database } from 'better-sqlite3-multiple-ciphers';
import type { LoopAgent, LoopGithubEvent, LoopGithubTriggers, LoopRun, LoopRunStatus, LoopRunTrigger } from '../../../../shared/types/loop';

/**
 * Loops and their runs in SQLite, through the raw better-sqlite3 handle (the
 * same escape hatch the usage index uses) rather than the `DatabaseService` facade.
 */

/** A loop as stored; what is derived from it is added by `LoopManager`. */
export interface StoredLoop {
  id: string;
  name: string;
  /** Exactly one target is set. */
  projectId?: number;
  orchestrationSessionId?: string;
  cron: string;
  agent?: LoopAgent;
  toolCommand?: string;
  initialInput?: string;
  worktreeTemplate?: string;
  enabled: boolean;
  /** Only slots, and GitHub events, after this count. */
  scheduleFromMs: number;
  createdAtMs: number;
  github?: LoopGithubTriggers;
}

interface LoopRow {
  id: string;
  name: string;
  project_id: number | null;
  orchestration_session_id: string | null;
  cron: string;
  agent: string | null;
  tool_command: string | null;
  initial_input: string | null;
  worktree_template: string | null;
  enabled: number;
  schedule_from_ms: number;
  created_at_ms: number;
  github_triggers: string | null;
}

interface LoopRunRow {
  id: string;
  loop_id: string;
  slot_at_ms: number;
  trigger: string;
  status: string;
  error: string | null;
  session_id: string | null;
  event: string | null;
}

function toLoop(row: LoopRow): StoredLoop {
  const loop: StoredLoop = {
    id: row.id,
    name: row.name,
    cron: row.cron,
    enabled: row.enabled === 1,
    scheduleFromMs: row.schedule_from_ms,
    createdAtMs: row.created_at_ms,
  };
  // SAFETY: Loop writes persist only LoopAgent values.
  const agent = row.agent as LoopAgent | null;
  if (row.project_id !== null) loop.projectId = row.project_id;
  if (row.orchestration_session_id !== null) loop.orchestrationSessionId = row.orchestration_session_id;
  if (agent !== null) loop.agent = agent;
  if (row.tool_command !== null) loop.toolCommand = row.tool_command;
  if (row.initial_input !== null) loop.initialInput = row.initial_input;
  if (row.worktree_template !== null) loop.worktreeTemplate = row.worktree_template;
  // SAFETY: Loop writes persist github_triggers only as JSON of a decoded LoopGithubTriggers.
  if (row.github_triggers !== null) loop.github = JSON.parse(row.github_triggers) as LoopGithubTriggers;
  return loop;
}

function toRun(row: LoopRunRow): LoopRun {
  const run: LoopRun = {
    id: row.id,
    loopId: row.loop_id,
    slotAtMs: row.slot_at_ms,
    // SAFETY: Run writes persist only LoopRunTrigger values.
    trigger: row.trigger as LoopRunTrigger,
    // SAFETY: Run writes persist only LoopRunStatus values.
    status: row.status as LoopRunStatus,
    error: row.error,
    sessionId: row.session_id,
  };
  // SAFETY: Run writes persist event only as JSON of a LoopGithubEvent.
  if (row.event !== null) run.event = JSON.parse(row.event) as LoopGithubEvent;
  return run;
}

export class LoopRepository {
  /** A getter: the database opens during start-up, after this is constructed. */
  constructor(private getDb: () => Database) {}

  private get db(): Database {
    return this.getDb();
  }

  list(): StoredLoop[] {
    // SAFETY: This SELECT reads rows of the loops table, represented by LoopRow.
    const rows = this.db.prepare('SELECT * FROM loops ORDER BY created_at_ms ASC').all() as LoopRow[];
    return rows.map(toLoop);
  }

  get(id: string): StoredLoop | null {
    // SAFETY: This SELECT reads one row of the loops table, represented by LoopRow.
    const row = this.db.prepare('SELECT * FROM loops WHERE id = ?').get(id) as LoopRow | undefined;
    return row ? toLoop(row) : null;
  }

  upsert(loop: StoredLoop): void {
    this.db.prepare(`
      INSERT INTO loops (
        id, name, project_id, orchestration_session_id, cron, agent, tool_command,
        initial_input, worktree_template, enabled, schedule_from_ms, created_at_ms, github_triggers
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        project_id = excluded.project_id,
        orchestration_session_id = excluded.orchestration_session_id,
        cron = excluded.cron,
        agent = excluded.agent,
        tool_command = excluded.tool_command,
        initial_input = excluded.initial_input,
        worktree_template = excluded.worktree_template,
        enabled = excluded.enabled,
        schedule_from_ms = excluded.schedule_from_ms,
        github_triggers = excluded.github_triggers
    `).run(
      loop.id,
      loop.name,
      loop.projectId ?? null,
      loop.orchestrationSessionId ?? null,
      loop.cron,
      loop.agent ?? null,
      loop.toolCommand ?? null,
      loop.initialInput ?? null,
      loop.worktreeTemplate ?? null,
      loop.enabled ? 1 : 0,
      loop.scheduleFromMs,
      loop.createdAtMs,
      loop.github ? JSON.stringify(loop.github) : null,
    );
  }

  delete(id: string): void {
    this.db.prepare('DELETE FROM loops WHERE id = ?').run(id);
  }

  /** Newest first. Trimming keeps this to the kept runs plus any whose Pane was kept. */
  runs(loopId: string): LoopRun[] {
    // SAFETY: This SELECT reads rows of the loop_runs table, represented by LoopRunRow.
    const rows = this.db.prepare(
      'SELECT * FROM loop_runs WHERE loop_id = ? ORDER BY slot_at_ms DESC, rowid DESC'
    ).all(loopId) as LoopRunRow[];
    return rows.map(toRun);
  }

  /** The latest slot the schedule handled (ran, failed or skipped); manual runs do not count. */
  lastScheduledSlot(loopId: string): number | null {
    // SAFETY: MAX over an INTEGER column returns a number or null.
    const row = this.db.prepare(
      "SELECT MAX(slot_at_ms) AS slot FROM loop_runs WHERE loop_id = ? AND trigger = 'schedule'"
    ).get(loopId) as { slot: number | null };
    return row.slot;
  }

  addRun(run: LoopRun): void {
    this.db.prepare(`
      INSERT INTO loop_runs (id, loop_id, slot_at_ms, trigger, status, error, session_id, event)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(run.id, run.loopId, run.slotAtMs, run.trigger, run.status, run.error, run.sessionId, run.event ? JSON.stringify(run.event) : null);
  }

  getRun(id: string): LoopRun | null {
    // SAFETY: This SELECT reads one row of the loop_runs table, represented by LoopRunRow.
    const row = this.db.prepare('SELECT * FROM loop_runs WHERE id = ?').get(id) as LoopRunRow | undefined;
    return row ? toRun(row) : null;
  }

  /** Record that a loop handled a GitHub event. False when it already had, so the event is never handled twice. */
  claimEvent(loopId: string, eventKey: string, atMs: number): boolean {
    return this.db.prepare('INSERT OR IGNORE INTO loop_github_events (loop_id, event_key, at_ms) VALUES (?, ?, ?)')
      .run(loopId, eventKey, atMs).changes > 0;
  }

  /** Count a started run toward the loop's hourly cap. */
  markEventStarted(loopId: string, eventKey: string, startedAtMs: number): void {
    this.db.prepare('UPDATE loop_github_events SET started_at_ms = ? WHERE loop_id = ? AND event_key = ?').run(startedAtMs, loopId, eventKey);
  }

  /** Runs GitHub events started for a loop since `sinceMs`. */
  eventRunsSince(loopId: string, sinceMs: number): number {
    // SAFETY: COUNT returns one integer column.
    const row = this.db.prepare('SELECT COUNT(*) AS count FROM loop_github_events WHERE loop_id = ? AND started_at_ms >= ?')
      .get(loopId, sinceMs) as { count: number };
    return row.count;
  }

  /** Forget handled events older than `beforeMs`; the event source never lists them again. */
  pruneEvents(beforeMs: number): void {
    this.db.prepare('DELETE FROM loop_github_events WHERE at_ms < ?').run(beforeMs);
  }

  finishRun(id: string, outcome: Pick<LoopRun, 'status' | 'error' | 'sessionId'>): void {
    this.db.prepare('UPDATE loop_runs SET status = ?, error = ?, session_id = ? WHERE id = ?')
      .run(outcome.status, outcome.error, outcome.sessionId, id);
  }

  /** A loop's runs past the newest `keep`, oldest first. */
  oldRuns(loopId: string, keep: number): LoopRun[] {
    // SAFETY: This SELECT reads rows of the loop_runs table, represented by LoopRunRow.
    const rows = this.db.prepare(
      'SELECT * FROM loop_runs WHERE loop_id = ? ORDER BY slot_at_ms DESC, rowid DESC LIMIT -1 OFFSET ?'
    ).all(loopId, keep) as LoopRunRow[];
    return rows.map(toRun).reverse();
  }

  deleteRun(id: string): void {
    this.db.prepare('DELETE FROM loop_runs WHERE id = ?').run(id);
  }
}
