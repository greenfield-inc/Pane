import type { ComputerUseEngine, EngineResult, EngineStatus } from './engine';

/** Stands in until the Cua Driver helper is installed and wired. */
const unavailableEngine: ComputerUseEngine = {
  id: 'cua-driver',
  async status(): Promise<EngineStatus> {
    return { installed: false, permissions: {}, desktopSession: false, detail: 'No computer-use engine is installed.' };
  },
  async call(): Promise<EngineResult> {
    return { ok: false, error: { code: 'engine_unavailable', message: 'No computer-use engine is installed on this machine.' } };
  },
  async stop(): Promise<void> {},
};

/** The daemon's one engine instance, shared by the script hosts and readiness. */
export function getComputerUseEngine(): ComputerUseEngine {
  return unavailableEngine;
}
