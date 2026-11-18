import { afterAll, vi } from 'vitest';
import { guardFileState } from '../../../shared/testing/fileStateGuard';

// Isolation is off (vite.config.ts), so one worker runs many test files and
// this file runs at the start of each. Do the module reset isolation would have
// done: every module an earlier file evaluated is evaluated again, including
// the cached results of its vi.mock factories ('mock:' entries), which
// vi.resetModules() keeps. Vitest exposes the module graph only on its worker
// state. This file is skipped because it is the module running now.
interface EvaluatedModule {
  promise?: unknown;
  exports?: unknown;
  evaluated: boolean;
  importers: Set<string>;
}
// SAFETY: Vitest sets __vitest_worker__ in every test worker before setup
// files run; evaluatedModules is its EvaluatedModules graph, typed here to the
// fields Vitest's own per-file reset writes.
const workerState = (globalThis as {
  __vitest_worker__?: { evaluatedModules: { idToModuleMap: Map<string, EvaluatedModule> } };
}).__vitest_worker__;
workerState?.evaluatedModules.idToModuleMap.forEach((mod, id) => {
  if (/\/vitest\/dist\/|@vitest\/|\/src\/test\/setup\.ts/.test(id)) return;
  mod.promise = undefined;
  mod.exports = undefined;
  mod.evaluated = false;
  mod.importers.clear();
});

guardFileState({ afterAll, vi });
