import type { Database } from 'better-sqlite3-multiple-ciphers';
import type { ScheduledRun, ScheduleKind, ScheduleRunStatus } from '../../../shared/types/schedule';

/**
 * Persistence for scheduled runs.
 *
 * Uses the raw better-sqlite3 handle rather than growing the ~5,000-line
 * `DatabaseService` facade — the same escape hatch the usage index and the
 * scrollback sweeper use.
 */

interface ScheduleRow {
  id: string;
  name: string;
  project_id: number;
  prompt: string;
  tool_type: string;
  worktree_template: string | null;
  enabled: number;
  kind: string;
  interval_minutes: number | null;
  time_of_day: string | null;
  weekday: number | null;
  last_run_at_ms: number | null;
  last_run_status: string | null;
  last_run_error: string | null;
  last_session_id: string | null;
  next_run_at_ms: number | null;
  created_at_ms: number;
}

function toSchedule(row: ScheduleRow): ScheduledRun {
  // SAFETY: Schedule writes persist only ScheduleKind values.
  const kind = row.kind as ScheduleKind;
  // SAFETY: Schedule writes persist only ScheduleRunStatus values or null.
  const lastRunStatus = row.last_run_status as ScheduleRunStatus | null;
  const schedule: ScheduledRun = {
    id: row.id,
    name: row.name,
    projectId: row.project_id,
    prompt: row.prompt,
    toolType: row.tool_type === 'none' ? 'none' : 'claude',
    enabled: row.enabled === 1,
    kind,
    lastRunAtMs: row.last_run_at_ms,
    lastRunStatus,
    lastRunError: row.last_run_error,
    lastSessionId: row.last_session_id,
    nextRunAtMs: row.next_run_at_ms,
    createdAtMs: row.created_at_ms,
  };

  if (row.worktree_template) schedule.worktreeTemplate = row.worktree_template;
  if (row.interval_minutes !== null) schedule.intervalMinutes = row.interval_minutes;
  if (row.time_of_day !== null) schedule.timeOfDay = row.time_of_day;
  if (row.weekday !== null) schedule.weekday = row.weekday;
  return schedule;
}

export class ScheduleRepository {
  /**
   * Takes a getter rather than a handle: the database is opened during app
   * start-up, and this is constructed while IPC handlers are being registered.
   */
  constructor(private getDb: () => Database) {}

  private get db(): Database {
    return this.getDb();
  }

  list(projectId?: number): ScheduledRun[] {
    const rows = projectId === undefined
      ? this.db.prepare('SELECT * FROM scheduled_runs ORDER BY created_at_ms DESC').all()
      : this.db.prepare('SELECT * FROM scheduled_runs WHERE project_id = ? ORDER BY created_at_ms DESC').all(projectId);
    // SAFETY: Both SELECT statements enumerate rows from the scheduled_runs schema represented by ScheduleRow.
    return (rows as ScheduleRow[]).map(toSchedule);
  }

  get(id: string): ScheduledRun | null {
    // SAFETY: This SELECT reads one row from the scheduled_runs schema represented by ScheduleRow.
    const row = this.db.prepare('SELECT * FROM scheduled_runs WHERE id = ?').get(id) as ScheduleRow | undefined;
    return row ? toSchedule(row) : null;
  }

  /** Everything enabled with a due time, newest deadline last. */
  listRunnable(nowMs: number): ScheduledRun[] {
    // SAFETY: This SELECT reads rows from the scheduled_runs schema represented by ScheduleRow.
    const rows = this.db.prepare(
      'SELECT * FROM scheduled_runs WHERE enabled = 1 AND next_run_at_ms <= ? ORDER BY next_run_at_ms ASC'
    ).all(nowMs) as ScheduleRow[];
    return rows.map(toSchedule);
  }

  upsert(schedule: ScheduledRun): void {
    this.db.prepare(`
      INSERT INTO scheduled_runs (
        id, name, project_id, prompt, tool_type, worktree_template, enabled,
        kind, interval_minutes, time_of_day, weekday,
        last_run_at_ms, last_run_status, last_run_error, last_session_id,
        next_run_at_ms, created_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        project_id = excluded.project_id,
        prompt = excluded.prompt,
        tool_type = excluded.tool_type,
        worktree_template = excluded.worktree_template,
        enabled = excluded.enabled,
        kind = excluded.kind,
        interval_minutes = excluded.interval_minutes,
        time_of_day = excluded.time_of_day,
        weekday = excluded.weekday,
        last_run_at_ms = excluded.last_run_at_ms,
        last_run_status = excluded.last_run_status,
        last_run_error = excluded.last_run_error,
        last_session_id = excluded.last_session_id,
        next_run_at_ms = excluded.next_run_at_ms
    `).run(
      schedule.id,
      schedule.name,
      schedule.projectId,
      schedule.prompt,
      schedule.toolType,
      schedule.worktreeTemplate ?? null,
      schedule.enabled ? 1 : 0,
      schedule.kind,
      schedule.intervalMinutes ?? null,
      schedule.timeOfDay ?? null,
      schedule.weekday ?? null,
      schedule.lastRunAtMs,
      schedule.lastRunStatus,
      schedule.lastRunError,
      schedule.lastSessionId,
      schedule.nextRunAtMs,
      schedule.createdAtMs,
    );
  }

  delete(id: string): void {
    this.db.prepare('DELETE FROM scheduled_runs WHERE id = ?').run(id);
  }
}
