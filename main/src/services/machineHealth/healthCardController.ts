import type { NotifyResult } from '../../../../shared/types/notify';
import type { LeakWarning, MachineHealthSnapshot, StorageInventory } from '../../../../shared/types/machineHealth';
import type { FinishedPane } from './finishedPanes';
import type { IdleOffer } from './memoryRelief';
import { CardGate, CLEAN_UP, diskCard, finishedCard, IGNORE_PROCESS, leakCard, memoryCard, NOT_NOW, PAUSE_IDLE, RESTART_IT, STOP_IT, type CardQuestion } from './healthCards';

export interface HealthCardDeps {
  now: () => number;
  /** Raises a Pane-sourced options card and resolves with the answer. */
  ask: (question: CardQuestion) => Promise<NotifyResult>;
  inventory: () => StorageInventory | null;
  idleOffer: () => IdleOffer;
  pauseIdleHours: () => number;
  paneName: (paneId: string) => string;
  /** Whether the leaking process belongs to its Pane's running run script. */
  canRestart: (leak: LeakWarning) => Promise<boolean>;
  cleanUp: (itemIds: string[]) => Promise<void>;
  pauseIdle: () => Promise<void>;
  stopProcess: (leak: LeakWarning) => Promise<void>;
  restartProcess: (leak: LeakWarning) => Promise<void>;
  ignoreLeak: (leak: LeakWarning) => void;
  archive: (paneIds: string[]) => Promise<void>;
  /** A desktop notification when Pane is not focused; used at the critical level. */
  alert: (title: string, body: string) => void;
  log: (message: string) => void;
}

/**
 * Raises the four machine health cards from samples and checks, each through
 * CardGate, and runs the answer on this machine. Review in Resources and Ask an
 * agent are buttons on the card's own body, so they act on whichever machine shows it.
 */
export class HealthCardController {
  private readonly gate: CardGate;

  constructor(private readonly deps: HealthCardDeps) {
    this.gate = new CardGate(deps.now);
  }

  onSnapshot(snapshot: MachineHealthSnapshot): void {
    if (snapshot.disk.level !== 'ok' && this.gate.shouldShow('disk', snapshot.disk.level)) {
      const question = diskCard(snapshot, this.deps.inventory(), 'local');
      const itemIds = (this.deps.inventory()?.items ?? []).filter(item => item.tier !== 3).slice(0, 5).map(item => item.id);
      this.raise('disk', snapshot.disk.level, question, async answer => {
        if (answer === CLEAN_UP) await this.deps.cleanUp(itemIds);
      });
      if (snapshot.disk.level === 'critical') this.deps.alert(question.title, question.context);
    }
    if (snapshot.memory.level !== 'ok' && this.gate.shouldShow('memory', snapshot.memory.level)) {
      const question = memoryCard(snapshot, this.deps.idleOffer(), this.deps.pauseIdleHours(), 'local');
      this.raise('memory', snapshot.memory.level, question, async answer => {
        if (answer === PAUSE_IDLE) await this.deps.pauseIdle();
      });
      if (snapshot.memory.level === 'critical') this.deps.alert(question.title, question.context);
    }
  }

  async onLeak(leak: LeakWarning, snapshot: MachineHealthSnapshot): Promise<void> {
    const key = `leak:${leak.pid}:${leak.started}`;
    if (!this.gate.shouldShow(key, 'warning')) return;
    const question = leakCard(leak, this.deps.paneName(leak.sessionId), await this.deps.canRestart(leak), snapshot, 'local');
    this.raise(key, 'warning', question, async answer => {
      if (answer === STOP_IT) await this.deps.stopProcess(leak);
      if (answer === RESTART_IT) await this.deps.restartProcess(leak);
      if (answer === IGNORE_PROCESS) this.deps.ignoreLeak(leak);
    });
  }

  onFinished(finished: FinishedPane[], snapshot: MachineHealthSnapshot): void {
    const ready = finished.filter(pane => !pane.protection);
    if (ready.length === 0 || !this.gate.shouldShow('finished', 'warning')) return;
    const question = finishedCard(finished, snapshot, 'local');
    this.raise('finished', 'warning', question, async answer => {
      if (answer !== NOT_NOW) await this.deps.archive(ready.map(pane => pane.sessionId));
    });
  }

  private raise(key: string, level: MachineHealthSnapshot['disk']['level'], question: CardQuestion, act: (answer: string) => Promise<void>): void {
    this.gate.shown(key, level);
    this.gate.open(key);
    void this.deps.ask(question).then(async result => {
      if (!('answer' in result)) return;
      if (result.answer === NOT_NOW) {
        this.gate.snooze(key, level);
        return;
      }
      await act(result.answer);
    }).catch(error => {
      this.deps.log(`[MachineHealth] card "${question.title}" failed: ${error instanceof Error ? error.message : String(error)}`);
    }).finally(() => this.gate.closed(key));
  }
}
