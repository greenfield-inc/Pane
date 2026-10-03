import { build } from 'esbuild';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// Synthetic coordination costs, not measured model billing or task execution.
// Reuse the shipping watcher cadence so its batching is not guessed.
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'pane-token-model-'));
try {
  const bundled = path.join(temporary, 'cadence.mjs');
  await build({ entryPoints: ['main/src/services/workspaceWatchCadence.ts'], outfile: bundled,
    bundle: true, platform: 'node', format: 'esm', logLevel: 'silent' });
  const { WatchCadence } = await import(pathToFileURL(bundled).href);
  const assumptions = {
    panels: 8, hours: 8, tasksPerPanel: 4, modelRoundsPerTask: 12,
    contextTokensPerWake: 16000, workerContextTokens: 16000, screenTokens: 600, eventTokens: 120,
    decisionOutputTokens: 100, receiptAndReplyTokensPerTask: 160,
    pollingIntervalSeconds: 60, cachedFraction: 0.9, cacheReadWeight: 0.1,
  };
  const minute = 60_000;
  const scenarios = [];
  for (const falseStopsPerTask of [0, 2, 6]) {
    for (const correlatedCoverage of [0.5, 1]) for (const extraWorkerRoundsPerTask of [0, 1, 2]) {
      const trace = [];
      let gen = 0;
      const add = (at, panel, kind, meaningful) => trace.push({
        at: new Date(at).toISOString(), time: at, gen: ++gen,
        panelId: `panel-${panel}`, paneId: `pane-${panel}`, paneName: `Task ${panel}`,
        kind, meaningful, source: 'agent',
      });
      for (let panel = 0; panel < assumptions.panels; panel++) {
        for (let task = 0; task < assumptions.tasksPerPanel; task++) {
          const start = task * 120 * minute + panel * 10_000;
          add(start, panel, 'agent.busy', false);
          for (let stop = 0; stop < falseStopsPerTask; stop++) {
            const pause = start + (10 + stop * 12) * minute;
            add(pause, panel, 'agent.ready', false);
            add(pause + 4 * minute, panel, 'agent.busy', false);
          }
          if (task === 1) {
            add(start + 90 * minute, panel, 'agent.blocked', true);
            add(start + 93 * minute, panel, 'agent.busy', false);
          }
          add(start + 110 * minute, panel, 'agent.ready', true);
        }
      }
      trace.sort((a, b) => a.time - b.time);
      trace.forEach((entry, index) => { entry.gen = index + 1; });
      const cadence = new WatchCadence({ settleMs: 180_000, blockedSettleMs: 30_000,
        minIntervalMs: 600_000, key: 'simulation', emitKinds: ['agent.ready', 'agent.blocked'] });
      const emitted = [];
      const flushUntil = until => {
        let deadline = cadence.nextDeadline(until);
        while (deadline !== undefined && deadline <= until) {
          emitted.push(...cadence.flush(deadline));
          const next = cadence.nextDeadline(deadline);
          if (next === deadline) throw new Error('Cadence failed to advance');
          deadline = next;
        }
      };
      for (const entry of trace) {
        flushUntil(entry.time);
        cadence.ingest([entry], entry.time);
        emitted.push(...cadence.flush(entry.time));
      }
      flushUntil(assumptions.hours * 60 * minute + 15 * minute);
      const tasks = assumptions.panels * assumptions.tasksPerPanel;
      const meaningfulEvents = tasks + assumptions.panels;
      const hybridWakes = Math.ceil(meaningfulEvents * correlatedCoverage
        + emitted.length * (1 - correlatedCoverage));
      const estimate = (name, wakes, observationTokens, extraTokens = 0, workerRounds = 0) => {
        const workerInput = workerRounds * assumptions.workerContextTokens;
        const replay = wakes * assumptions.contextTokensPerWake + workerInput;
        const newInput = wakes * observationTokens;
        const output = (wakes + workerRounds) * assumptions.decisionOutputTokens + extraTokens;
        return { name, wakes, extraWorkerRounds: workerRounds, workerCoordinationInputTokens: workerInput, replayInputTokens: replay, newInputTokens: newInput,
          outputTokens: output, totalTokens: replay + newInput + output,
          // Illustrative weighted tokens only. Actual input/output prices and caching vary.
          weightedTokens: Math.round(replay * (1 - assumptions.cachedFraction
            + assumptions.cachedFraction * assumptions.cacheReadWeight) + newInput + output) };
      };
      const approaches = [
        estimate('model_polls_all_screens', assumptions.hours * 3600 / assumptions.pollingIntervalSeconds,
          assumptions.panels * assumptions.screenTokens),
        estimate('current_cadenced_watcher', emitted.length, assumptions.screenTokens),
        estimate('wake_on_every_pi_turn_end', tasks * assumptions.modelRoundsPerTask + assumptions.panels,
          assumptions.eventTokens),
        estimate('correlated_hybrid', hybridWakes,
          (meaningfulEvents * correlatedCoverage * assumptions.eventTokens
            + emitted.length * (1 - correlatedCoverage) * assumptions.screenTokens) / hybridWakes,
          Math.ceil(tasks * correlatedCoverage) * assumptions.receiptAndReplyTokensPerTask,
          tasks * correlatedCoverage * extraWorkerRoundsPerTask),
      ];
      const current = approaches[1];
      const hybrid = approaches[3];
      scenarios.push({ falseStopsPerTask, correlatedCoverage, extraWorkerRoundsPerTask,
        currentFalseWakes: emitted.filter(entry => !entry.meaningful).length,
        assumptions: 'One emitted watcher line wakes the orchestrator, as the current skill specifies. Underlying task execution is excluded, but extra receiver coordination rounds are included. Zero extra rounds assumes receipt/reply commands piggyback on existing work. Blocker notifications are counted once; duplicates would cost another wake. Native or cooperative task replies count as correlated coverage; unsupported agents keep the existing cadence.',
        approaches,
        hybridTokenReductionPercent: Math.round((1 - hybrid.totalTokens / current.totalTokens) * 1000) / 10,
        hybridWeightedReductionPercent: Math.round((1 - hybrid.weightedTokens / current.weightedTokens) * 1000) / 10 });
    }
  }
  console.log(JSON.stringify({ kind: 'simulation', assumptions, scenarios }, null, 2));
} finally {
  await fs.rm(temporary, { recursive: true, force: true });
}
