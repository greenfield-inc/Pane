import { createCuaDriverEngine } from './cuaDriver';
import type { ComputerUseEngine } from './engine';

let engine: ComputerUseEngine | null = null;

/** The daemon's one engine instance, shared by the script hosts and readiness. */
export function getComputerUseEngine(): ComputerUseEngine {
  engine ??= createCuaDriverEngine();
  return engine;
}
