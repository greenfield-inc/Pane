import type { ComputerUseEngine, EngineResult } from './engine';
import type { AppConfig } from '../../types/config';
import type {
  ComputerUseEngineChoice,
  ComputerUsePermission,
  ComputerUseReadiness,
} from '../../../../shared/types/computerUse';

type ComputerUseSetting = NonNullable<AppConfig['computerUse']>;

export interface ComputerUseReadinessDeps {
  getSetting(): AppConfig['computerUse'];
  saveSetting(next: ComputerUseSetting): Promise<void>;
  engine(): ComputerUseEngine;
  /** Installs the engine; throws with a readable message. */
  install(): Promise<void>;
  selfTest(engine: ComputerUseEngine): Promise<EngineResult>;
  /** Registers the Pane MCP server and syncs the computer-use skill to match the saved setting. */
  syncAgentSetup(): void;
  stopEngine(): Promise<void>;
  onChange(): void;
  now(): number;
}

/** While a permission is missing, look again this often so the status turns Ready soon after the grant. */
const PERMISSION_RECHECK_MS = 5_000;
// Mac grants go to Cua Driver's own app, not to Pane.
const ENGINE_APP_NAME = 'Cua Driver';

/**
 * Computer use on this machine: the on/off setting and the readiness step
 * (install the engine, register agents, check permissions, self-test).
 */
export class ComputerUseReadinessService {
  private readiness: ComputerUseReadiness;
  /** Bumped by every check and by turning off, so a stale check never overwrites a newer state. */
  private generation = 0;
  private recheckTimer: ReturnType<typeof setTimeout> | null = null;
  /** The install in flight, shared by every check so turning on twice never runs two installers. */
  private installing: Promise<void> | null = null;

  constructor(private readonly deps: ComputerUseReadinessDeps) {
    this.readiness = { state: 'off', engineChoice: this.engineChoice() };
  }

  get(): ComputerUseReadiness {
    return this.readiness;
  }

  /** Rechecks on daemon start while computer use is on. */
  async start(): Promise<void> {
    if (this.deps.getSetting()?.enabled !== true) return;
    this.deps.syncAgentSetup();
    await this.check();
  }

  async set(update: { enabled: boolean; engine?: ComputerUseEngineChoice }): Promise<ComputerUseReadiness> {
    const setting: ComputerUseSetting = { ...this.deps.getSetting(), enabled: update.enabled };
    if (update.engine) setting.engine = update.engine;
    await this.deps.saveSetting(setting);
    this.deps.syncAgentSetup();
    if (update.enabled) return this.check();

    this.generation += 1;
    this.clearRecheck();
    this.update({ state: 'off', engineChoice: this.engineChoice() });
    await this.deps.stopEngine();
    return this.readiness;
  }

  /** The readiness step. Shows Installing… only when an install actually runs. */
  async check(): Promise<ComputerUseReadiness> {
    if (this.deps.getSetting()?.enabled !== true) return this.readiness;
    const generation = ++this.generation;
    this.clearRecheck();
    const engineChoice = this.engineChoice();
    const engine = this.deps.engine();
    // A newer check or turning off supersedes this one: it stops before its next side effect.
    const stale = () => generation !== this.generation;
    const settle = (next: ComputerUseReadiness): ComputerUseReadiness => {
      if (!stale()) this.update(next);
      return this.readiness;
    };

    try {
      let status = await engine.status();
      if (stale()) return this.readiness;
      if (!status.installed) {
        settle({ state: 'installing', engineChoice });
        try {
          this.installing ??= this.deps.install().finally(() => { this.installing = null; });
          await this.installing;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          return settle({ state: 'failed', engineChoice, step: 'install', detail: message });
        }
        if (stale()) return this.readiness;
        status = await engine.status();
        if (stale()) return this.readiness;
      }

      if (!status.desktopSession) return settle({ state: 'no-desktop', engineChoice });
      if (!status.installed) {
        return settle({ state: 'failed', engineChoice, step: 'install', detail: status.detail ?? `${ENGINE_APP_NAME} is not installed.` });
      }
      const missing = missingPermission(status.permissions);
      if (missing) {
        settle({ state: 'needs-permission', engineChoice, permission: missing, appName: ENGINE_APP_NAME });
        this.scheduleRecheck();
        return this.readiness;
      }

      const test = await this.deps.selfTest(engine);
      if (!test.ok) {
        return settle({ state: 'failed', engineChoice, step: 'self-test', detail: test.error?.message ?? 'The engine did not answer.' });
      }
      const ready: ComputerUseReadiness = { state: 'ready', engineChoice, engine: engine.id, checkedAt: this.deps.now() };
      if (status.fallbackReason) ready.detail = status.fallbackReason;
      return settle(ready);
    } catch (error) {
      return settle({ state: 'failed', engineChoice, step: 'self-test', detail: error instanceof Error ? error.message : String(error) });
    }
  }

  dispose(): void {
    this.generation += 1;
    this.clearRecheck();
  }

  private engineChoice(): ComputerUseEngineChoice {
    return this.deps.getSetting()?.engine ?? 'auto';
  }

  private update(next: ComputerUseReadiness): void {
    this.readiness = next;
    this.deps.onChange();
  }

  private scheduleRecheck(): void {
    this.recheckTimer = setTimeout(() => {
      this.recheckTimer = null;
      void this.check();
    }, PERMISSION_RECHECK_MS);
    this.recheckTimer.unref?.();
  }

  private clearRecheck(): void {
    if (this.recheckTimer) clearTimeout(this.recheckTimer);
    this.recheckTimer = null;
  }
}

function missingPermission(permissions: { accessibility?: boolean; screenRecording?: boolean }): ComputerUsePermission | null {
  if (permissions.screenRecording === false) return 'Screen Recording';
  if (permissions.accessibility === false) return 'Accessibility';
  return null;
}
