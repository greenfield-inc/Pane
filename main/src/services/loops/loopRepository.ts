import type { Database } from 'better-sqlite3-multiple-ciphers';
import type { LoopAgent, LoopRun, LoopRunStatus, LoopRunTrigger } from '../../../../shared/types/loop';

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
  /** Only slots after this count. */
  scheduleFromMs: number;
  createdAtMs: number;
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
}

interface LoopRunRow {
  id: string;
  loop_id: string;
  slot_at_ms: number;
  trigger: string;
  status: string;
  error: string | null;
  session_id: string | null;
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
  return loop;
}

function toRun(row: LoopRunRow): LoopRun {
  return {
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
        initial_input, worktree_template, enabled, schedule_from_ms, created_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
        schedule_from_ms = excluded.schedule_from_ms
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
      INSERT INTO loop_runs (id, loop_id, slot_at_ms, trigger, status, error, session_id)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(run.id, run.loopId, run.slotAtMs, run.trigger, run.status, run.error, run.sessionId);
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
