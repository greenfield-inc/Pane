import fs from 'node:fs';
import path from 'node:path';
import type { ToolPanel, TerminalPanelState } from '../../../shared/types/panels';
import { boundary, decodeBoundary } from '../../../shared/validation/boundaryDecoder';
import { readUpdateJournal, writeUpdateJson } from '../../../packages/runpane/src/updateOperation';
import { isProcessAlive } from '../utils/processTree';
import { checkpointSchema } from './updateContinuation';

/** A hold guards its panel only while the update's helper can still restore it. */
export function updateHoldIsLive(directory: string): boolean {
  try {
    const journal = readUpdateJournal(path.join(directory, 'status.json'));
    return !['complete', 'needs-attention', 'failed'].includes(journal.phase) && journal.helperPid !== undefined && isProcessAlive(journal.helperPid);
  } catch {
    return false;
  }
}

interface RestorationDependencies {
  getPanel(id: string): ToolPanel | undefined;
  updatePanel(id: string, update: Pick<ToolPanel, 'state'>): Promise<void>;
  isInitialized(id: string): boolean;
  initialize(panel: ToolPanel, cwd: string, operationId: string): Promise<void>;
  verify(panelId: string, resumeId: string): Promise<{ pid: number }>;
}

/** Durable claims own each launch independently of the polling caller's lifetime. */
export class UpdatePanelRestorer {
  private readonly jobs = new Map<string, Promise<void>>();
  constructor(private readonly directory: (id: string) => string, private readonly bootId: string, private readonly dependencies: RestorationDependencies) {}

  restore(id: string) {
    const checkpoint = decodeBoundary(JSON.parse(fs.readFileSync(path.join(this.directory(id), 'checkpoint.json'), 'utf8')), checkpointSchema);
    const progressFile = path.join(this.directory(id), 'restoration.json');
    const progressSchema = boundary.array(boundary.object({ panelId: boundary.string, sessionId: boundary.string, resumeId: boundary.optional(boundary.string), bootId: boundary.string, phase: boundary.enumeration('claimed', 'finished'), pid: boundary.optional(boundary.number), outcome: boundary.string, reason: boundary.string }));
    const readProgress = () => fs.existsSync(progressFile) ? decodeBoundary(JSON.parse(fs.readFileSync(progressFile, 'utf8')), progressSchema) : [];
    if (!this.jobs.has(id)) {
      const progress = readProgress().map(record => ({ ...record }));
      const job = (async () => {
        for (const item of checkpoint.panels) {
          const panel = this.dependencies.getPanel(item.panelId);
          const previous = progress.find(record => record.panelId === item.panelId);
          if (previous?.phase === 'finished') {
            if (previous.outcome === 'resumed' && previous.bootId !== this.bootId) {
              previous.outcome = 'needs-attention';
              previous.reason = 'Pane restarted after this conversation was verified. The old launch was not replayed; inspect the current panel before resuming manually.';
              writeUpdateJson(progressFile, progress);
            }
            continue;
          }
          const record: (typeof progress)[number] = previous ?? { pid: undefined, panelId: item.panelId, sessionId: item.sessionId, resumeId: item.resumeId, bootId: this.bootId, phase: 'claimed' as const, outcome: 'pending', reason: 'Restoration claimed; no launch acknowledgment yet.' };
          if (!previous) { progress.push(record); writeUpdateJson(progressFile, progress); }
          try {
            if (!panel || panel.type !== 'terminal' || panel.sessionId !== item.sessionId) throw new Error('The checkpoint panel no longer exists.');
            // SAFETY: checkpoint enumeration and restoration only accept terminal panels.
            const state = panel.state.customState as TerminalPanelState;
            if (record.bootId !== this.bootId || record.resumeId !== item.resumeId) throw new Error('Pane restarted during restoration; inspect the previous launch before resuming manually.');
            if (!item.eligible) {
              await this.dependencies.updatePanel(panel.id, { state: { ...panel.state, customState: { ...item.priorState, updateResumeHold: id, isInitialized: false, initialInput: undefined, initialInputFile: undefined } } });
              record.outcome = item.requiresAttention ? 'needs-attention' : 'preserved'; record.reason = item.reason;
            } else {
              if (state.agentSessionId !== item.resumeId || !item.resumeId || !item.cwd) throw new Error('The conversation identity or working directory changed after checkpoint.');
              for (const field of ['initialCommand', 'launchCommand', 'launchMode', 'customResume', 'orchestrationProfile', 'orchestrationWorkspace', 'preserveLaunchCommand'] as const) {
                if (JSON.stringify(state[field]) !== JSON.stringify(item.priorState[field])) throw new Error('The saved launch profile changed after checkpoint; review it manually.');
              }
              if (!this.dependencies.isInitialized(panel.id)) {
                if (previous) throw new Error('A previous launch claim has no live terminal. It was not replayed; inspect the panel before resuming manually.');
                if (state.updateResumeHold !== id) throw new Error('The update no longer owns this stopped panel.');
                await this.dependencies.updatePanel(panel.id, { state: { ...panel.state, customState: { ...state, updateResumeId: item.resumeId, wasInterrupted: true, initialInput: undefined, initialInputFile: undefined } } });
                await this.dependencies.initialize(this.dependencies.getPanel(panel.id)!, item.cwd, id);
              } else if (!previous) throw new Error('The panel was started outside this operation; no input was sent.');
              const verified = await this.dependencies.verify(panel.id, item.resumeId);
              record.pid = verified.pid; record.outcome = 'resumed';
              record.reason = 'The harness confirmed the recorded conversation and readiness. No prompt or pending mutation was submitted.';
              await this.dependencies.updatePanel(panel.id, { state: { ...panel.state, customState: { ...state, updateResumeHold: undefined, updateResumeId: undefined } } });
            }
          } catch (error) {
            record.outcome = 'needs-attention'; record.reason = error instanceof Error ? error.message : String(error);
          }
          record.phase = 'finished';
          writeUpdateJson(progressFile, progress);

        }
      })();
      this.jobs.set(id, job);
      void job.catch(error => console.error('[Update] Restoration progress could not be persisted:', error)).finally(() => this.jobs.delete(id));
    }
    const progress = readProgress();
    return { complete: checkpoint.panels.every(item => progress.some(record => record.panelId === item.panelId && record.phase === 'finished')),
      restored: progress.filter(record => record.phase === 'finished').map(({ panelId, outcome, reason }) => ({ panelId, outcome, reason })) };
  }
}
