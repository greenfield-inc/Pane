// Glasses join your other computers on their own: on launch and every 10 minutes, one paired
// computer vouches for them. It returns a pairing code for the computers it could add, which the
// glasses trade as if it were pasted, and a reason for each computer it couldn't.
import { JOIN_REASONS, type UnjoinedComputer } from './model';
import type { Cancel } from './timers';

/** How often the glasses ask again, so a computer you add later joins within this long. */
const JOIN_EVERY_MS = 10 * 60_000;
/** A computer answers one vouch per pair of glasses per 5 minutes; it is never asked sooner. */
const VOUCH_SPACING_MS = 5 * 60_000;
/** Reasons another computer may not share: it may have the password saved, or reach the computer. */
const SOLVABLE: ReadonlySet<string> = new Set([JOIN_REASONS.password, JOIN_REASONS.silent]);

export type VouchAnswer =
  | { kind: 'answered'; code: string | null; skipped: UnjoinedComputer[] }
  /** It didn't answer, failed, or was asked less than 5 minutes ago: ask the next computer. */
  | { kind: 'unavailable' }
  /** An older Pane with no vouch: it is not asked again until the next launch. */
  | { kind: 'unsupported' };

/** A paired computer that can vouch for the glasses. */
export interface Voucher {
  id: string;
  name: string;
  live: boolean;
  vouch(): Promise<VouchAnswer>;
}

export interface AutoJoinDeps {
  /** The paired computers, in pairing order. */
  vouchers(): Voucher[];
  /** Pairs with a code as a pasted one does; names the computers that joined and those that didn't. */
  join(code: string): Promise<{ joined: string[]; failed: string[] }>;
  later(fn: () => void, ms: number): Cancel;
  now(): number;
  changed(): void;
}

export class AutoJoin {
  /** The last answered round's computers that couldn't join, by name. Held in memory only. */
  private reasons = new Map<string, string>();
  private readonly askedAt = new Map<string, number>();
  private readonly unsupported = new Set<string>();
  /** Computers whose reason only the person can fix: no other computer is asked about them until the next launch. */
  private readonly stuck = new Set<string>();
  private due = true;
  private running = false;
  private timer: Cancel | null = null;

  constructor(private readonly deps: AutoJoinDeps) {}

  start(): void {
    this.timer?.cancel();
    this.timer = this.deps.later(() => {
      this.due = true;
      this.start();
    }, JOIN_EVERY_MS);
    this.poke();
  }

  stop(): void {
    this.timer?.cancel();
    this.timer = null;
    this.due = false;
  }

  /** Runs a round that is due once a paired computer is live; call it whenever a computer changes. */
  poke(): void {
    if (!this.due || this.running || !this.candidates(new Set()).length) return;
    this.due = false;
    void this.round();
  }

  unjoined(): UnjoinedComputer[] {
    const paired = new Set(this.deps.vouchers().map((voucher) => voucher.name));
    return [...this.reasons].filter(([name]) => !paired.has(name)).map(([name, reason]) => ({ name, reason }));
  }

  private candidates(asked: ReadonlySet<string>): Voucher[] {
    const now = this.deps.now();
    return this.deps.vouchers().filter((voucher) => voucher.live && !asked.has(voucher.id) && !this.unsupported.has(voucher.id)
      && now - (this.askedAt.get(voucher.id) ?? -Infinity) >= VOUCH_SPACING_MS);
  }

  /**
   * Asks the first live computer. When it can't answer, or couldn't add a computer for a reason
   * another computer might not share, asks the next, until none is left to ask.
   */
  private async round(): Promise<void> {
    this.running = true;
    const asked = new Set<string>();
    const reasons = new Map<string, string>();
    let answered = false;
    try {
      for (let voucher = this.candidates(asked)[0]; voucher; voucher = this.candidates(asked)[0]) {
        asked.add(voucher.id);
        this.askedAt.set(voucher.id, this.deps.now());
        const answer = await voucher.vouch();
        if (answer.kind === 'unsupported') this.unsupported.add(voucher.id);
        if (answer.kind !== 'answered') continue;
        answered = true;
        for (const { name, reason } of answer.skipped) {
          const known = reasons.get(name);
          if (known === undefined || SOLVABLE.has(known)) reasons.set(name, reason);
          if (!SOLVABLE.has(reason)) this.stuck.add(name);
        }
        if (answer.code) {
          // A code that can't be read or stored changes nothing; the next round asks again.
          const { joined, failed } = await this.deps.join(answer.code).catch(() => ({ joined: [], failed: [] }));
          for (const name of joined) reasons.delete(name);
          for (const name of failed) if (!reasons.has(name)) reasons.set(name, JOIN_REASONS.silent);
        }
        const paired = new Set(this.deps.vouchers().map((candidate) => candidate.name));
        const another = [...reasons].some(([name, reason]) => SOLVABLE.has(reason) && !this.stuck.has(name) && !paired.has(name));
        if (!another) break;
      }
    } finally {
      this.running = false;
    }
    // With no answer, the next computer to come live is asked.
    if (!answered) {
      this.due = true;
      return;
    }
    this.reasons = reasons;
    this.deps.changed();
  }
}
