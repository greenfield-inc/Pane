import type { ComputerUseEngineChoice } from '../../../../shared/types/computerUse';
import type { JsonObject } from '../../../../shared/validation/boundaryDecoder';
import { createCodexEngine } from './codexEngine';
import { createCuaDriverEngine } from './cuaDriver';
import type { ComputerUseEngine, EngineResult, EngineStatus } from './engine';

interface EngineSelectorOptions {
  engineChoice: () => ComputerUseEngineChoice;
  codex: ComputerUseEngine;
  cua: ComputerUseEngine;
  /** Auto fell back to Cua Driver on its own, mid-session; readiness checks again to show it. */
  onFallback?: () => void;
}

/** Error codes from the runtime itself (crashed, hung, unreachable), as opposed to one action failing. */
const RUNTIME_FAILURES = new Set(['engine_unavailable', 'engine_error']);

/**
 * Auto runs on the user's Codex runtime when it is installed and answers Pane, else on Cua Driver
 * with the reason in `status().fallbackReason`. Each status() picks again, so readiness rechecks
 * notice ChatGPT being installed, removed or broken. A runtime with calls in flight is kept without
 * a new self-test, so a check never stops them; a runtime failure during a call triggers that
 * self-test instead, and Auto falls back if the runtime stays down.
 */
class EngineSelector implements ComputerUseEngine {
  private selected: ComputerUseEngine | null = null;
  /** Bumped by stop(), so a selection that was in progress never starts an engine afterwards. */
  private generation = 0;
  private callsInFlight = 0;

  constructor(private readonly options: EngineSelectorOptions) {}

  get id() {
    return (this.selected ?? this.options.cua).id;
  }

  async status(): Promise<EngineStatus> {
    const generation = this.generation;
    const { engine, fallbackReason } = await this.select();
    // Turned off while selecting: report that without starting the engine again.
    if (generation !== this.generation) return { installed: false, permissions: {}, desktopSession: false, detail: 'Computer use was turned off.' };
    const status = await engine.status();
    if (fallbackReason) status.fallbackReason = `Codex runtime not used: ${fallbackReason}`;
    return status;
  }

  async call(tool: string, args: JsonObject): Promise<EngineResult> {
    const engine = this.selected ?? (await this.select()).engine;
    this.callsInFlight += 1;
    let result: EngineResult;
    try {
      result = await engine.call(tool, args);
    } finally {
      this.callsInFlight -= 1;
    }
    if (engine === this.options.codex && !result.ok && RUNTIME_FAILURES.has(result.error?.code ?? '')) void this.recheckCodex();
    return result;
  }

  async stop(): Promise<void> {
    this.generation += 1;
    this.selected = null;
    await Promise.all([this.options.codex.stop(), this.options.cua.stop()]);
  }

  /** After a runtime failure: falls back to Cua Driver unless the runtime answers again. */
  private async recheckCodex(): Promise<void> {
    const { codex, cua } = this.options;
    const generation = this.generation;
    if (this.selected !== codex) return;
    const test = await codex.call('list_apps', {});
    if (test.ok || generation !== this.generation || this.selected !== codex) return;
    await this.use(generation, cua, codex);
    this.options.onFallback?.();
  }

  private async select(): Promise<{ engine: ComputerUseEngine; fallbackReason?: string }> {
    const { codex, cua } = this.options;
    const generation = this.generation;
    if (this.options.engineChoice() === 'cua-driver') return this.use(generation, cua, codex);

    const status = await codex.status();
    if (!status.installed) return this.use(generation, cua, codex, status.detail ?? 'ChatGPT is not installed.');
    if (!status.desktopSession) return this.use(generation, cua, codex, 'no desktop session.');
    if (this.selected !== codex || this.callsInFlight === 0) {
      const test = await codex.call('list_apps', {});
      if (!test.ok) return this.use(generation, cua, codex, `it refused calls from Pane (${test.error?.message ?? 'no answer'}).`);
    }
    return this.use(generation, codex, cua);
  }

  private async use(generation: number, engine: ComputerUseEngine, other: ComputerUseEngine, fallbackReason?: string) {
    if (generation !== this.generation) {
      // Computer use stopped while this selection ran; leave nothing it started running.
      await engine.stop();
      return { engine, fallbackReason };
    }
    if (this.selected !== engine) await other.stop();
    this.selected = engine;
    return { engine, fallbackReason };
  }
}

export function createEngineSelector(options: EngineSelectorOptions): ComputerUseEngine {
  return new EngineSelector(options);
}

let engine: ComputerUseEngine | null = null;
let hooks: Pick<EngineSelectorOptions, 'engineChoice' | 'onFallback'> = { engineChoice: () => 'auto' };

/** The daemon passes the machine's saved engine choice, and how to recheck readiness, before the first engine call. */
export function configureComputerUseEngine(next: Pick<EngineSelectorOptions, 'engineChoice' | 'onFallback'>): void {
  hooks = next;
}

/** The daemon's one engine instance, shared by the script hosts and readiness. */
export function getComputerUseEngine(): ComputerUseEngine {
  engine ??= createEngineSelector({
    engineChoice: () => hooks.engineChoice(),
    onFallback: () => hooks.onFallback?.(),
    codex: createCodexEngine(),
    cua: createCuaDriverEngine(),
  });
  return engine;
}
