import fs from 'fs';
import { PaneError, reasonOf } from '../../../shared/paneError';
import path from 'path';
import { randomUUID } from 'crypto';
import { boundary, decodeBoundary, decodeOptionalBoundary } from '../../../shared/validation/boundaryDecoder';
import type { WorkspaceJournal } from './workspaceJournal';
import type { RunpaneWorkspaceEntry } from '../../../shared/types/runpaneOrchestration';
import type { TerminalExpectedReport } from '../../../shared/types/panels';

/**
 * Expected reports (`--expect-report`): work sent to an agent panel can say its sender waits for a
 * `runpane report`. When that agent goes ready or exits without reporting, the tracker journals an
 * `agent.report.missing` entry carrying what the agent said last, so a worker that finished silently
 * still reaches its orchestrator.
 *
 * An agent that went ready while its screen shows background work (a Claude shell or subagent, a
 * Codex background terminal) has not finished: the tracker waits, re-reading the screen every
 * `recheckMs` while the panel stays ready, and raises once nothing runs or the panel exits.
 *
 * Expectations live in their own file (`expected-reports.json`), written only here. Panel state is
 * rewritten from snapshots elsewhere, so a cleared expectation kept there could come back.
 */

/** An `agent.report.missing` entry carries at most this much of the agent's last output. */
export const MAX_MISSING_REPORT_OUTPUT_LENGTH = 2_000;
const TRUNCATION_MARKER = '[earlier output cut]\n';
/** How often a ready panel with background work is looked at again. */
const BACKGROUND_RECHECK_MS = 10_000;
const STATE_CHANGES: ReadonlySet<RunpaneWorkspaceEntry['kind']> = new Set([
  'agent.ready', 'agent.busy', 'agent.blocked', 'agent.unknown', 'agent.report', 'panel.exited', 'panel.stopped',
]);

const expectationsFileSchema = boundary.object({
  version: boundary.literal(1),
  expectations: boundary.jsonObject,
});
const expectationSchema = boundary.object({ since: boundary.nonEmptyString, pending: boundary.optional(boundary.boolean) });
type Expectation = TerminalExpectedReport & { pending?: boolean };

export interface PanelLastOutput {
  text: string;
  source: 'transcript' | 'screen';
}

export interface ExpectedReportTrackerOptions {
  journal: WorkspaceJournal;
  /** Where expectations are saved; omitted, they live in memory only. */
  filePath?: string;
  /** When the panel last ran `runpane report`. */
  lastReportAt(panelId: string): string | undefined;
  /** The agent's last reply, or else the last lines on its screen. */
  lastOutput(panelId: string): Promise<PanelLastOutput | undefined>;
  /** What the panel's agent still runs in the background (from its screen), if anything. */
  backgroundWork?: (panelId: string) => string | undefined;
  recheckMs?: number;
  subscribeDelivery?: (listener: (panelId: string) => void) => () => void;
  /** False for a panel that no longer exists; its saved expectation is dropped on load. */
  panelExists?: (panelId: string) => boolean;
  log?: (message: string, error: Error) => void;
}

export class ExpectedReportTracker {
  private readonly expectations = new Map<string, Expectation>();
  private readonly raising = new Set<string>();
  /** Ready panels waiting for their background work to end, with the READY that started the wait. */
  private readonly waiting = new Map<string, { entry: RunpaneWorkspaceEntry; timer: ReturnType<typeof setTimeout> }>();
  private readonly unsubscribe: () => void;
  private loaded = false;
  private disposed = false;
  private readonly unsubscribeDelivery?: () => void;

  constructor(private readonly options: ExpectedReportTrackerOptions) {
    this.unsubscribe = options.journal.subscribe(entry => this.observe(entry));
    this.ensureLoaded();
    this.unsubscribeDelivery = options.subscribeDelivery?.(panelId => this.delivered(panelId));
  }

  dispose(): void {
    this.disposed = true;
    this.unsubscribe();
    this.unsubscribeDelivery?.();
    for (const panelId of [...this.waiting.keys()]) this.stopWaiting(panelId);
  }

  /** Records that the sender of the panel's work, sent at `since`, waits for a report. */
  arm(panelId: string, since: string, pending = false): TerminalExpectedReport {
    this.ensureLoaded();
    if (this.expectations.has(panelId) || this.raising.has(panelId)) {
      throw new PaneError('ERR_RUNPANE_REPORT_OUTSTANDING',
        `Panel ${panelId} still owes a report or is collecting its missing report. No new work was sent. Wait for the current result.`,
        'Wait for the current result before submitting more report-expected work.');
    }
    const expected: Expectation = pending ? { since, pending: true } : { since };
    this.expectations.set(panelId, expected);
    try { this.persist(true); }
    catch (error) { this.expectations.delete(panelId); throw error; }
    return expected;
  }

  /** The report the panel's sender waits for, if any. */
  expectation(panelId: string): TerminalExpectedReport | undefined {
    this.ensureLoaded();
    const expected = this.expectations.get(panelId);
    return expected ? { since: expected.since } : undefined;
  }

  /** Activate reserved work immediately before its submit/launch write, never at startup readiness. */
  delivered(panelId: string): void {
    this.ensureLoaded();
    const expected = this.expectations.get(panelId);
    if (expected?.pending) {
      delete expected.pending;
      try { this.persist(true); }
      catch (error) {
        // Activation failed before submit/launch; the caller must inspect and retry.
        this.clear(panelId);
        throw error;
      }
    }
  }

  /** Release a reservation only when the caller sent nothing. */
  cancelPending(panelId: string, reservation: TerminalExpectedReport): void {
    const current = this.expectations.get(panelId);
    if (current === reservation && current.pending) this.clear(panelId);
  }

  private observe(entry: RunpaneWorkspaceEntry): void {
    this.ensureLoaded();
    const panelId = entry.panelId;
    if (!panelId || entry.replay) return;
    // A new state ends a wait for background work: busy means the agent took a new turn, and its
    // next READY looks again. IDLE reminders change nothing.
    if (STATE_CHANGES.has(entry.kind)) this.stopWaiting(panelId);
    if (entry.kind === 'agent.report') {
      if (this.expectations.get(panelId)?.pending) return;
      this.clear(panelId);
      return;
    }
    if (entry.kind !== 'agent.ready' && entry.kind !== 'panel.exited') return;
    const expected = this.expectations.get(panelId);
    if (!expected || this.raising.has(panelId) || (expected.pending && entry.kind !== 'panel.exited')) return;
    if (entry.kind === 'agent.ready' && this.options.backgroundWork?.(panelId)) {
      this.waitForBackground(panelId, entry);
      return;
    }
    this.raiseNow(entry, panelId, expected);
  }

  private raiseNow(entry: RunpaneWorkspaceEntry, panelId: string, expected: TerminalExpectedReport): void {
    // One missing report per expectation: the next dispatch arms it again.
    if (this.fulfilled(panelId, expected)) { this.clear(panelId); return; }
    this.raising.add(panelId);
    void this.raise(entry, panelId, expected)
      .catch(error => {
        this.options.log?.('[ExpectedReports] Could not journal a missing report', asError(error));
        if (!this.disposed && this.expectations.get(panelId) === expected) this.waitForBackground(panelId, entry);
      })
      .finally(() => this.raising.delete(panelId));
  }

  private async raise(entry: RunpaneWorkspaceEntry, panelId: string, expected: TerminalExpectedReport): Promise<void> {
    const output = await this.options.lastOutput(panelId).catch(() => undefined);
    // A report that landed while the output was read wins.
    if (this.disposed || this.expectations.get(panelId) !== expected) return;
    if (this.fulfilled(panelId, expected)) { this.clear(panelId); return; }
    const missing: Parameters<WorkspaceJournal['appendPaneEntry']>[1] = {
      kind: 'agent.report.missing',
      panelId,
      panelTitle: entry.panelTitle,
      agentType: entry.agentType,
      source: 'agent',
      reason: entry.kind === 'panel.exited' ? 'exited' : 'ready',
      expectedSince: expected.since,
    };
    const text = output?.text.trim();
    if (output && text) {
      missing.lastOutput = boundOutput(text);
      missing.lastOutputSource = output.source;
    }
    this.options.journal.appendPaneEntry(entry.paneId, missing);
    if (this.expectations.get(panelId) === expected) this.clear(panelId);
  }

  private waitForBackground(panelId: string, entry: RunpaneWorkspaceEntry): void {
    const timer = setTimeout(() => {
      this.waiting.delete(panelId);
      const expected = this.expectations.get(panelId);
      if (!expected || this.raising.has(panelId)) return;
      if (entry.kind === 'agent.ready' && this.options.backgroundWork?.(panelId)) {
        this.waitForBackground(panelId, entry);
        return;
      }
      this.raiseNow(entry, panelId, expected);
    }, this.options.recheckMs ?? BACKGROUND_RECHECK_MS);
    timer.unref?.();
    this.waiting.set(panelId, { entry, timer });
  }

  private stopWaiting(panelId: string): void {
    const waiting = this.waiting.get(panelId);
    if (!waiting) return;
    clearTimeout(waiting.timer);
    this.waiting.delete(panelId);
  }

  private fulfilled(panelId: string, expected: TerminalExpectedReport): boolean {
    const reportedAt = this.options.lastReportAt(panelId);
    return reportedAt !== undefined && Date.parse(reportedAt) >= Date.parse(expected.since);
  }

  private clear(panelId: string): void {
    this.ensureLoaded();
    if (this.expectations.delete(panelId)) this.persist();
  }

  private ensureLoaded(): void {
    if (this.loaded) return;
    this.loaded = true;
    if (!this.options.filePath) return;
    try {
      const parsed = decodeBoundary(JSON.parse(fs.readFileSync(this.options.filePath, 'utf8')), expectationsFileSchema);
      for (const [panelId, value] of Object.entries(parsed.expectations)) {
        const expected = decodeOptionalBoundary(value, expectationSchema);
        if (expected && this.options.panelExists?.(panelId) !== false) this.expectations.set(panelId, expected);
      }
    } catch (error) {
      const details = decodeOptionalBoundary(error, boundary.object({ code: boundary.optional(boundary.string) }));
      if (details?.code !== 'ENOENT') this.options.log?.('[ExpectedReports] Ignoring an unreadable expectations file', error instanceof Error ? error : new Error(String(error)));
    }
    // Reconcile a crash after committing an outcome or while collecting output.
    for (const [panelId, expected] of this.expectations) {
      const entries = this.options.journal.readAfter(0, {
        kinds: [...STATE_CHANGES, 'agent.report.missing'],
      }, Number.MAX_SAFE_INTEGER).entries.filter(entry => entry.panelId === panelId && entry.at >= expected.since);
      const outcome = entries.find(entry => entry.kind === 'agent.report'
        || entry.kind === 'agent.report.missing' && entry.expectedSince === expected.since);
      if (outcome) this.clear(panelId);
      else {
        const last = entries.at(-1);
        if (last) this.observe(last);
      }
    }
  }

  private persist(required = false): void {
    const filePath = this.options.filePath;
    if (!filePath) return;
    const temporaryPath = `${filePath}.tmp-${process.pid}-${randomUUID()}`;
    try {
      fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
      const payload = { version: 1, expectations: Object.fromEntries(this.expectations) };
      fs.writeFileSync(temporaryPath, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
      fs.renameSync(temporaryPath, filePath);
    } catch (error) {
      if (required) throw new PaneError('ERR_RUNPANE_EXPECTATION_WRITE',
        `Pane could not save the report expectation (${reasonOf(error)}), so the work was not delivered.`,
        'Check permissions and available space in PANE_DIR, then retry.');
      this.options.log?.('[ExpectedReports] Could not save expectations; they stay in memory', error instanceof Error ? error : new Error(String(error)));
    } finally {
      if (fs.existsSync(temporaryPath)) fs.unlinkSync(temporaryPath);
    }
  }
}

function asError(error: Error | string): Error {
  return error instanceof Error ? error : new Error(error);
}

/** Keeps the end of the output, where the agent's conclusion is. */
function boundOutput(text: string): string {
  if (text.length <= MAX_MISSING_REPORT_OUTPUT_LENGTH) return text;
  return `${TRUNCATION_MARKER}${text.slice(text.length - (MAX_MISSING_REPORT_OUTPUT_LENGTH - TRUNCATION_MARKER.length))}`;
}
