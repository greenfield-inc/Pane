import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { boundary, decodeBoundary } from './boundaryDecoder';
import { RunpaneError } from './errors';

const UPDATE_STEPS = ['stage', 'checkpoint', 'stop', 'snapshot', 'install', 'launch', 'health', 'restore'] as const;
type UpdateStep = typeof UPDATE_STEPS[number];
const phaseSchema = boundary.enumeration('accepted', ...UPDATE_STEPS, 'complete', 'needs-attention', 'failed');
const journalSchema = boundary.object({
  id: boundary.nonEmptyString,
  host: boundary.nonEmptyString,
  scope: boundary.enumeration('both', 'pane', 'cli'),
  version: boundary.nonEmptyString,
  phase: phaseSchema,
  completed: boundary.array(boundary.enumeration(...UPDATE_STEPS)),
  helperPid: boundary.optional(boundary.number),
  setupPid: boundary.optional(boundary.number),
  setupExpiresAt: boundary.optional(boundary.number),
  updatedAt: boundary.nonEmptyString,
  appUpdated: boundary.boolean,
  cliUpdated: boundary.boolean,
  hostReachable: boundary.boolean,
  restored: boundary.array(boundary.object({ panelId: boundary.string, outcome: boundary.string, reason: boundary.string })),
  error: boundary.optional(boundary.string),
});
export type UpdateJournal = ReturnType<typeof journalSchema.decode>;

/** Commit one complete journal image; a crash leaves either the old or new image. */
export function writeUpdateJson<T extends object>(file: string, value: T): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.tmp`;
  const fd = fs.openSync(temporary, 'w', 0o600);
  try { fs.writeFileSync(fd, JSON.stringify(value, null, 2)); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
  fs.renameSync(temporary, file);
  if (process.platform !== 'win32') {
    const directory = fs.openSync(path.dirname(file), 'r');
    try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
  }
}

export function readUpdateJournal(file: string): UpdateJournal {
  return decodeBoundary(JSON.parse(fs.readFileSync(file, 'utf8')), journalSchema);
}

export interface UpdateSteps {
  /** Each step reconciles its recorded effect before repeating after a crash. */
  run(step: UpdateStep, journal: UpdateJournal): Promise<Partial<UpdateJournal>>;
}

export async function executeUpdate(file: string, steps: UpdateSteps): Promise<UpdateJournal> {
  let journal = readUpdateJournal(file);
  if (['complete', 'needs-attention', 'failed'].includes(journal.phase)) return journal;
  const canceled = () => fs.existsSync(path.join(path.dirname(file), 'canceled.json'));
  if (canceled()) { journal = { ...journal, phase: 'failed', error: 'Operation setup was canceled before shutdown.' }; writeUpdateJson(file, journal); return journal; }
  journal = { ...journal, helperPid: process.pid, updatedAt: new Date().toISOString() };
  writeUpdateJson(file, journal); // This helper's durable acknowledgement, not the supervisor launch result.
  try {
    for (const step of UPDATE_STEPS) {
      if (canceled()) throw new Error('Operation canceled before this stage.');
      const persisted = readUpdateJournal(file);
      if (['complete', 'needs-attention', 'failed'].includes(persisted.phase)) return persisted;
      if (journal.completed.includes(step)) continue;
      journal = { ...journal, phase: step, updatedAt: new Date().toISOString() };
      writeUpdateJson(file, journal);
      const outcome = await steps.run(step, journal);
      const after = readUpdateJournal(file);
      if (['complete', 'needs-attention', 'failed'].includes(after.phase)) return after;
      journal = { ...journal, ...outcome, completed: [...journal.completed, step], updatedAt: new Date().toISOString() };
      writeUpdateJson(file, journal);
    }
    const attention = journal.restored.some(item => item.outcome === 'needs-attention');
    journal = { ...journal, phase: attention ? 'needs-attention' : 'complete' };
  } catch (error) {
    journal = { ...journal, ...readUpdateJournal(file), phase: journal.phase === 'stop' || journal.completed.includes('stop') ? 'needs-attention' : 'failed',
      error: error instanceof Error ? error.message : String(error) };
  }
  writeUpdateJson(file, journal);
  return journal;
}

/** No owned installer can still be writing. A needs-attention operation that
 *  stopped before finishing install may have a surviving installer child. */
export function updateLockReleasable(journal: UpdateJournal): boolean {
  return journal.phase === 'complete' || journal.phase === 'failed' || (journal.phase === 'needs-attention' && journal.completed.includes('install'));
}

/** Publish a fully durable owner directory atomically; never expose an empty lock. */
export function claimUpdateLock(directory: string, id: string, statusFile: string) {
  const candidate = fs.mkdtempSync(`${directory}.${id}.`);
  try {
    writeUpdateJson(path.join(candidate, 'owner.json'), { id, statusFile });
    try { fs.renameSync(candidate, directory); return { id, statusFile, acquired: true }; }
    catch (error) { if (!fs.existsSync(directory)) throw error; }
    const file = path.join(directory, 'owner.json');
    if (!fs.existsSync(file)) throw new RunpaneError('ERR_UPDATE_LOCK_INVALID', `An incomplete update lock requires inspection: ${directory}. Nothing was changed.`, 'Verify no update supervisor owns this target, then move this orphan lock aside and retry.');
    const owner = decodeBoundary(JSON.parse(fs.readFileSync(file, 'utf8')), boundary.object({ id: boundary.nonEmptyString, statusFile: boundary.nonEmptyString }));
    // A terminal journal is durable proof that this owner cannot run more work.
    // Reconcile cleanup interrupted after the journal committed.
    let journal = readUpdateJournal(owner.statusFile);
    if (journal.phase === 'accepted' && !journal.helperPid && journal.setupPid && journal.setupExpiresAt && Date.now() > journal.setupExpiresAt) {
      let setupExited = false;
      try { process.kill(journal.setupPid, 0); } catch (error) { setupExited = decodeBoundary(error, boundary.object({ code: boundary.string })).code === 'ESRCH'; }
      if (setupExited) {
        // Cancellation is separate from the mutable journal, so a late queued
        // helper cannot overwrite it with an acknowledgment and then stop Pane.
        writeUpdateJson(path.join(path.dirname(owner.statusFile), 'canceled.json'), { id: owner.id });
        journal = { ...journal, phase: 'failed', error: 'The caller exited before publishing an independent helper acknowledgment.' };
        writeUpdateJson(owner.statusFile, journal);
      }
    }
    if (journal.id === owner.id && updateLockReleasable(journal)) {
      releaseUpdateLock(directory, owner.id);
      if (!fs.existsSync(directory)) return claimUpdateLock(directory, id, statusFile);
      const current = decodeBoundary(JSON.parse(fs.readFileSync(file, 'utf8')), boundary.object({ id: boundary.string }));
      if (current.id !== owner.id) return claimUpdateLock(directory, id, statusFile);
      throw new RunpaneError('ERR_UPDATE_LOCK_RECOVERY', `Update ${owner.id} finished, but its lock cleanup requires inspection: ${directory}. No new update was started.`, 'Wait for any active cleanup to finish. If it remains blocked, verify that no operation helper or installer is running, then follow docs/UPDATE_RECOVERY.md before moving this exact owner’s lock aside.');
    }
    return { ...owner, acquired: false };
  } finally { fs.rmSync(candidate, { recursive: true, force: true }); }
}

/** Elect one releaser. A terminal journal plus a dead recorded releaser repairs a crashed cleanup. */
export function releaseUpdateLock(directory: string, id: string): void {
  const marker = path.join(directory, 'releasing');
  const candidate = path.join(directory, `.releasing-${randomUUID()}`);
  try {
    const owner = decodeBoundary(JSON.parse(fs.readFileSync(path.join(directory, 'owner.json'), 'utf8')), boundary.object({ id: boundary.nonEmptyString, statusFile: boundary.nonEmptyString }));
    if (owner.id !== id) return;
    if (fs.existsSync(marker)) {
      const journal = readUpdateJournal(owner.statusFile);
      const releasing = decodeBoundary(JSON.parse(fs.readFileSync(marker, 'utf8')), boundary.object({ id: boundary.string, pid: boundary.number }));
      if (journal.id !== id || !updateLockReleasable(journal) || releasing.id !== id || releasing.pid <= 0) return;
      try { process.kill(releasing.pid, 0); return; } catch (error) {
        if (decodeBoundary(error, boundary.object({ code: boundary.string })).code !== 'ESRCH') return;
      }
      // Keep this election outside the removable lock directory. Two callers
      // can both observe the same dead releaser; only one may remove its marker.
      // Never remove the claim: a delayed observer must not act on a newer lock.
      // An interrupted recovery election remains a manual inspection boundary.
      const recovery = createHash('sha256').update(fs.realpathSync(directory)).update(JSON.stringify(releasing)).digest('hex');
      fs.mkdirSync(path.join(path.dirname(owner.statusFile), `lock-recovery-${recovery}`), { mode: 0o700 });
      fs.unlinkSync(marker);
    }
    // Publish fully written contents exclusively, without a crash window that
    // exposes an empty releasing marker to another caller.
    writeUpdateJson(candidate, { id, pid: process.pid });
    fs.linkSync(candidate, marker);
    const current = decodeBoundary(JSON.parse(fs.readFileSync(path.join(directory, 'owner.json'), 'utf8')), boundary.object({ id: boundary.nonEmptyString }));
    if (current.id === id) fs.rmSync(directory, { recursive: true });
    else fs.unlinkSync(marker);
  } catch {
    // Ambiguous ownership remains inspectable; it is never permission to steal.
  } finally { fs.rmSync(candidate, { force: true }); }
}

/** Process disappearance is not proof of a clean shutdown. */
export function assertUpdateQuiescence(directory: string, expected: { id: string; bootId: string; pid: number }): void {
  const file = path.join(directory, 'quiesced.json');
  if (!fs.existsSync(file)) throw new Error('Pane exited without acknowledging clean shutdown. No installer was started; inspect the shutdown log and recovery checkpoint.');
  const stopped = decodeBoundary(JSON.parse(fs.readFileSync(file, 'utf8')), boundary.object({ id: boundary.string, bootId: boundary.string, pid: boundary.number }));
  if (stopped.id !== expected.id || stopped.bootId !== expected.bootId || stopped.pid !== expected.pid) throw new Error('Shutdown acknowledgment belongs to another operation or host. No installer was started.');
}
