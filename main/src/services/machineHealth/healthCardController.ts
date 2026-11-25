import { randomUUID } from 'node:crypto';
import type { NotifyResult } from '../../../../shared/types/notify';
import type { CleanupRun, HealthLevel, HealthProcess, LeakWarning, MachineHealthSnapshot } from '../../../../shared/types/machineHealth';
import type { FinishedPane } from './finishedPanes';
import { CardGate, diskCard, finishedCard, IGNORE_PROCESS, KEEP_IT, KEEP_THEM, leakCard, leftoversCard, NOT_NOW, RANK, RESTART_IT, STOP_IT, STOP_THEM, type CardQuestion, type Leftover } from './healthCards';

const DISK = 'disk';
/** Free space must rise this far above the alert's before a nearly full disk counts as a new episode. */
const EPISODE_MARGIN_BYTES = 2 * 1024 ** 3;
const LEFTOVERS_OPEN = 'leftovers';

export interface HealthCardDeps {
  now: () => number;
  /** Settings › Machine health › Cards and notifications. Off: only critical disk raises a card or a notification. */
  notificationsOn: () => boolean;
  /** Raises a Pane-sourced options card under `id` and resolves with the answer. */
  ask: (question: CardQuestion, id: string) => Promise<NotifyResult>;
  /** Takes back a waiting card Pane raised, as when the condition it asks about cleared. */
  withdraw: (id: string, reason: string) => void;
  paneName: (paneId: string) => string;
  paneState: (paneId: string) => 'archived' | 'paused' | 'open';
  /** The tab's title, or null when Pane does not know the tab. */
  tabName: (panelId: string) => string | null;
  /** Whether the leaking process belongs to its Pane's running run script. */
  canRestart: (leak: LeakWarning) => Promise<boolean>;
  stopProcess: (leak: LeakWarning) => Promise<void>;
  /** Identity-checked stop: a process whose start time changed is never signalled. */
  stopProcesses: (processes: HealthProcess[]) => Promise<CleanupRun>;
  restartProcess: (leak: LeakWarning) => Promise<void>;
  ignoreLeak: (leak: LeakWarning) => void;
  archive: (paneIds: string[]) => Promise<void>;
  /** A desktop notification through Pane's desktop-alert path; false when it should be tried again later. */
  alert: (title: string, body: string) => boolean;
  log: (message: string) => void;
  /** Leftover processes the person kept, as pid:start, saved so a restart does not ask again. */
  readKept: () => string[];
  writeKept: (identities: string[]) => void;
}

const identity = (proc: HealthProcess) => `${proc.pid}:${proc.started}`;
const lowestFree = (snapshot: MachineHealthSnapshot) => Math.min(...snapshot.disk.volumes.map(volume => volume.freeBytes));
const RECOVERED = 'free disk is back above the warning line';

/**
 * Raises the machine health cards from samples and checks, each through
 * CardGate, and runs the answer on this machine. Every action covers exactly the
 * rows its card lists. Review in Resources and Ask an agent are buttons on the
 * card's own body, so they act on whichever machine shows it. Memory pressure
 * raises no card: it shows only in Resources (D-175).
 */
export class HealthCardController {
  private readonly gate: CardGate;
  /** Lowest free space when the current episode's desktop alert went out; null when none has. */
  private alertedFree: number | null = null;
  /** The current critical disk episode's card was raised. */
  private urgentCard = false;
  /** Leftover processes the person chose to keep, by pid and start time. */
  private readonly kept: Set<string>;
  /** The card waiting for each open key, so its answer or withdrawal touches only that card. */
  private readonly waiting = new Map<string, { id: string; level: HealthLevel }>();

  constructor(private readonly deps: HealthCardDeps) {
    this.gate = new CardGate(deps.now);
    this.kept = new Set(deps.readKept());
  }

  onSnapshot(snapshot: MachineHealthSnapshot): void {
    const { level } = snapshot.disk;
    this.alertOnCritical(snapshot);
    this.withdrawOutdated(level);
    if (this.mayRaise(level)) this.raise(DISK, level, diskCard(snapshot), async () => {});
    if (this.deps.notificationsOn()) this.askAboutLeftovers(snapshot);
  }

  /** The gate decides in both modes; off, only a critical level passes, once per critical episode. */
  private mayRaise(level: HealthLevel): boolean {
    if (level === 'ok') return false;
    if (!this.deps.notificationsOn() && (level !== 'critical' || this.urgentCard)) return false;
    if (!this.gate.shouldShow(DISK, level)) return false;
    if (level === 'critical') this.urgentCard = true;
    return true;
  }

  async onLeak(leak: LeakWarning, snapshot: MachineHealthSnapshot): Promise<void> {
    // A WSL process has no identity Pane can stop or restart by.
    if (leak.started.startsWith('wsl:') || !this.deps.notificationsOn()) return;
    const key = `leak:${leak.pid}:${leak.started}`;
    if (!this.gate.shouldShow(key, 'warning')) return;
    const tabName = leak.panelId ? this.deps.tabName(leak.panelId) : null;
    const question = leakCard(leak, this.deps.paneName(leak.sessionId), tabName, await this.deps.canRestart(leak), snapshot);
    this.raise(key, 'warning', question, async answer => {
      if (answer === STOP_IT) await this.deps.stopProcess(leak);
      if (answer === RESTART_IT) await this.deps.restartProcess(leak);
      if (answer === IGNORE_PROCESS) this.deps.ignoreLeak(leak);
    });
  }

  onFinished(finished: FinishedPane[], snapshot: MachineHealthSnapshot): void {
    const ready = finished.filter(pane => !pane.protection);
    if (ready.length === 0 || !this.deps.notificationsOn() || !this.gate.shouldShow('finished', 'warning')) return;
    this.raise('finished', 'warning', finishedCard(finished, snapshot), async answer => {
      if (answer !== NOT_NOW) await this.deps.archive(ready.map(pane => pane.sessionId));
    });
  }

  /** Asks once about processes that left a tab and outlived their Pane; a new set of processes asks again. */
  private askAboutLeftovers(snapshot: MachineHealthSnapshot): void {
    const leftovers: Leftover[] = snapshot.panes.flatMap(pane => {
      const paneState = this.deps.paneState(pane.sessionId);
      if (paneState === 'open') return [];
      return pane.processes.filter(proc => proc.escaped && !this.kept.has(identity(proc))).map(proc => ({ proc, paneName: pane.name, paneState }));
    });
    if (leftovers.length === 0 || this.gate.isOpen(LEFTOVERS_OPEN)) return;
    const key = `leftovers:${leftovers.map(({ proc }) => identity(proc)).sort().join(',')}`;
    if (!this.gate.shouldShow(key, 'warning')) return;
    const processes = leftovers.map(({ proc }) => proc);
    this.raise(key, 'warning', leftoversCard(leftovers, snapshot), async answer => {
      if (answer === KEEP_THEM || answer === KEEP_IT) {
        // Only identities still running are worth remembering; a pid with a new start time is a new process.
        const running = new Set(snapshot.panes.flatMap(pane => pane.processes.map(identity)));
        for (const id of [...this.kept]) if (!running.has(id)) this.kept.delete(id);
        for (const proc of processes) this.kept.add(identity(proc));
        this.deps.writeKept([...this.kept]);
      }
      if (answer === STOP_THEM || answer === STOP_IT) {
        const run = await this.deps.stopProcesses(processes);
        if (run.skipped.length > 0) this.deps.log(`[MachineHealth] ${run.skipped.length} left-behind process(es) did not stop`);
      }
    }, LEFTOVERS_OPEN);
  }

  /**
   * Turning critical replaces a waiting warning card with the critical one. A critical card closes
   * once the level is back to ok, and the next episode may raise a card again; a dip to warning keeps
   * it. A warning card keeps waiting through recovery, so a level hovering at the line never re-raises it.
   */
  private withdrawOutdated(level: HealthLevel): void {
    const card = this.waiting.get(DISK);
    if (!card) return;
    const recovered = level === 'ok' && card.level === 'critical';
    if (!recovered && RANK[level] <= RANK[card.level]) return;
    this.waiting.delete(DISK);
    this.gate.closed(DISK);
    if (recovered) this.gate.forget(DISK);
    this.deps.withdraw(card.id, recovered ? RECOVERED : 'it turned critical, and a new card replaces it');
  }

  /** One desktop alert when the disk turns critical, whatever card is already waiting. */
  private alertOnCritical(snapshot: MachineHealthSnapshot): void {
    const free = lowestFree(snapshot);
    if (snapshot.disk.level !== 'critical') {
      // Hovering at the line stays one episode.
      if (snapshot.disk.level === 'ok' || this.alertedFree === null || free > this.alertedFree + EPISODE_MARGIN_BYTES) {
        this.alertedFree = null;
        this.urgentCard = false;
      }
      return;
    }
    if (this.alertedFree !== null) return;
    const { title, context } = diskCard(snapshot);
    // Counted only once it went out (or the rules say it should not); otherwise the next sample tries again.
    if (this.deps.alert(title, context)) this.alertedFree = free;
  }

  private raise(key: string, level: HealthLevel, question: CardQuestion, act: (answer: string) => Promise<void>, openKey = key): void {
    const id = randomUUID();
    this.gate.shown(key, level);
    this.gate.open(openKey);
    this.waiting.set(openKey, { id, level });
    // A withdrawn card's end is already settled; a newer card may hold its key.
    const current = () => this.waiting.get(openKey)?.id === id;
    void this.deps.ask(question, id).then(async result => {
      if (!current()) return;
      if ('unavailable' in result) {
        // Not delivered (Approvals off): the next sample may ask again.
        this.gate.forget(key);
        if (key === DISK) this.urgentCard = false;
        return;
      }
      if (!('answer' in result)) return;
      if (result.answer === NOT_NOW) {
        this.gate.snooze(key, level);
        return;
      }
      await act(result.answer);
    }).catch(error => {
      this.deps.log(`[MachineHealth] card "${question.title}" failed: ${error instanceof Error ? error.message : String(error)}`);
    }).finally(() => {
      if (!current()) return;
      this.waiting.delete(openKey);
      this.gate.closed(openKey);
    });
  }
}
