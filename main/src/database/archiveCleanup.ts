import type Database from 'better-sqlite3-multiple-ciphers';
import { boundary, decodeBoundary } from '../../../shared/validation/boundaryDecoder';

const jobSchema = boundary.object({
  id: boundary.string,
  sessionId: boundary.string,
  sessionName: boundary.string,
  worktreeName: boundary.string,
  projectName: boundary.string,
  projectId: boundary.optional(boundary.number),
  projectPath: boundary.string,
  source: boundary.string,
  quarantine: boundary.string,
  repository: boundary.string,
  gitDirectory: boundary.string,
  identity: boundary.string,
  removeWorktree: boundary.boolean,
  externalRemovalApproved: boundary.boolean,
  status: boundary.enumeration('queued', 'running', 'failed', 'completed'),
  phase: boundary.enumeration('script', 'detach', 'purge', 'artifacts'),
  scriptStarted: boundary.boolean,
  scriptFinished: boundary.boolean,
  attempts: boundary.number,
  nextAttempt: boundary.number,
  startTime: boundary.string,
  endTime: boundary.optional(boundary.string),
  error: boundary.optional(boundary.string),
  processes: boundary.optional(boundary.array(boundary.object({
    pid: boundary.number, parent: boundary.number, started: boundary.string,
  }))),
});

type DecodedJob = ReturnType<typeof jobSchema.decode>;
export type ArchiveCleanupJob = { -readonly [Key in keyof DecodedJob]: DecodedJob[Key] };

/** No session FK: deleting archive history must not erase deletion intent. */
export function ensureArchiveCleanup(db: Database.Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS archive_cleanup_jobs (
    session_id TEXT PRIMARY KEY, job TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS archive_cleanup_status
    ON archive_cleanup_jobs(json_extract(job, '$.status'), json_extract(job, '$.endTime'));`);
}

export function readArchiveCleanupJob(db: Database.Database, sessionId: string): ArchiveCleanupJob | undefined {
  const row = db.prepare('SELECT job FROM archive_cleanup_jobs WHERE session_id = ?').get(sessionId);
  if (!row) return undefined;
  const { job } = decodeBoundary(row, boundary.object({ job: boundary.string }));
  return decodeBoundary(JSON.parse(job), jobSchema);
}

export function readArchiveCleanupJobs(db: Database.Database): ArchiveCleanupJob[] {
  return db.prepare('SELECT job FROM archive_cleanup_jobs').all().map(row => {
    const { job } = decodeBoundary(row, boundary.object({ job: boundary.string }));
    return decodeBoundary(JSON.parse(job), jobSchema);
  });
}

export function writeArchiveCleanupJob(db: Database.Database, job: ArchiveCleanupJob): void {
  db.prepare('INSERT INTO archive_cleanup_jobs(session_id, job) VALUES (?, ?) ON CONFLICT(session_id) DO UPDATE SET job = excluded.job')
    .run(job.sessionId, JSON.stringify(job));
  if (job.status === 'completed') {
    db.prepare(`DELETE FROM archive_cleanup_jobs WHERE session_id IN (
      SELECT session_id FROM archive_cleanup_jobs WHERE json_extract(job, '$.status') = 'completed'
      ORDER BY json_extract(job, '$.endTime') DESC LIMIT -1 OFFSET 10
    )`).run();
  }
}
