import type { ComputerUseEngine, EngineResult } from './engine';

// Placeholder for chunk A's Cua Driver helper (P1); its branch replaces this file.

export async function installCuaDriver(): Promise<void> {
  throw new Error('The Cua Driver helper is not built into this Pane yet.');
}

export async function requestCuaDriverPermissions(): Promise<{ accessibility?: boolean; screenRecording?: boolean }> {
  return {};
}

export function selfTest(engine: ComputerUseEngine): Promise<EngineResult> {
  return engine.call('list_apps', {});
}
