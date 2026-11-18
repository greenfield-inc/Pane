import { randomBytes } from 'crypto';
import fs from 'fs/promises';
import path from 'path';
import { PaneError, reasonOf } from '../../../shared/paneError';
import { boundary, decodeBoundary } from '../../../shared/validation/boundaryDecoder';
import {
  paneSecretKey,
  secretLeaseRenewCommand,
  type SecretLeaseEvent,
  type SecretLeaseSummary,
} from '../../../shared/types/paneSecrets';
import type { SecretValueBackend } from './paneSecrets';

/** One lease as this machine keeps it. Never holds a value: values live in the value backend or in memory. */
export interface SecretLeaseRecord {
  id: string;
  project: string;
  /** Each leased name and the 1Password reference its value was read from. */
  secrets: Array<{ name: string; reference: string }>;
  /** ISO times on this machine's clock. A pushed lease's expiry is computed here from the time remaining. */
  grantedAt: string;
  expiresAt: string;
  /** Who asked for it: an agent's tab, or "Settings". */
  requestedBy: string;
  /** The machine that read 1Password and granted it. */
  grantedOn: string;
  /** Values held in memory only, because this machine cannot encrypt them at rest. */
  memoryOnly: boolean;
  /** On the desktop that granted it: the machines it was pushed to, by connection id. */
  pushedTo?: string[];
}

export interface SecretLeaseGrant {
  /** Kept when a desktop pushes or renews a lease, so every machine names it the same. */
  id?: string;
  project: string;
  secrets: Array<{ name: string; reference: string; value: string }>;
  /** Time remaining, never an absolute time, so a machine's clock cannot extend it. */
  expiresInMs: number;
  requestedBy: string;
  grantedOn: string;
  pushedTo?: string[];
}

const recordSchema = boundary.object({
  id: boundary.nonEmptyString,
  project: boundary.string,
  secrets: boundary.array(boundary.object({ name: boundary.string, reference: boundary.string })),
  grantedAt: boundary.string,
  expiresAt: boundary.string,
  requestedBy: boundary.string,
  grantedOn: boundary.string,
  memoryOnly: boundary.boolean,
  pushedTo: boundary.optional(boundary.array(boundary.string)),
});
const recordFileSchema = boundary.object({ leases: boundary.array(recordSchema) });

/** setTimeout's longest delay; a later expiry re-arms on the way. */
const MAX_TIMER_MS = 2 ** 31 - 1;

const valueKey = (id: string, name: string) => `lease:${id}:${name}`;

/** Why a reference-backed secret has no value to give. */
export function secretLeaseEnded(project: string, name: string, endedAt: string | null): PaneError {
  const key = paneSecretKey(project, name);
  return new PaneError(
    'SECRET_LEASE_ENDED',
    endedAt
      ? `${key} comes from 1Password, and its lease on this machine ended at ${endedAt}. Nothing was run.`
      : `${key} comes from 1Password and has no active lease on this machine. Nothing was run.`,
    `Run \`${secretLeaseRenewCommand(project, [name])}\`, and the person approves it on the card.`,
  );
}

export interface SecretLeaseStoreOptions {
  /** Directory for `secret-leases.json` and `secret-leases.log`. */
  directory: string;
  values: SecretValueBackend;
  /** False where values could only be stored as plain text: leases are then held in memory only. */
  canEncrypt: () => boolean;
  now?: () => number;
  /** Called after any change, with the summaries; never with values. */
  onChange?: (leases: SecretLeaseSummary[]) => void;
}

/**
 * Leases on this machine. A lease's values stay in the OS store (or memory) until it expires
 * or is ended; a timer deletes them on time, and `ready()` deletes any that expired while
 * Pane was not running before a read is answered. Every event writes one line to
 * `secret-leases.log`, with names and never values.
 */
export class SecretLeaseStore {
  private readonly records = new Map<string, SecretLeaseRecord>();
  private readonly memory = new Map<string, string>();
  /** Last end time of each `<project>/<NAME>`, for the error after a lease ends. */
  private readonly endedAt = new Map<string, string>();
  private timer: NodeJS.Timeout | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private readonly loaded: Promise<void>;
  private readonly now: () => number;

  constructor(private readonly options: SecretLeaseStoreOptions) {
    this.now = options.now ?? Date.now;
    this.loaded = this.serial(() => this.sweep());
  }

  private get recordFile(): string {
    return path.join(this.options.directory, 'secret-leases.json');
  }

  private get logFile(): string {
    return path.join(this.options.directory, 'secret-leases.log');
  }

  private serial<T>(work: () => Promise<T>): Promise<T> {
    const run = this.queue.then(work, work);
    this.queue = run.catch(() => undefined);
    return run;
  }

  /** Resolves once leases that ended while Pane was closed are deleted. Every read waits for it. */
  ready(): Promise<void> {
    return this.loaded;
  }

  /** Loads the record file and deletes every lease already past its expiry. */
  private async sweep(): Promise<void> {
    const text = await fs.readFile(this.recordFile, 'utf8').catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (text !== null) {
      let leases: SecretLeaseRecord[] = [];
      try {
        leases = decodeBoundary(JSON.parse(text), recordFileSchema).leases;
      } catch (error) {
        console.warn(`[SecretLeases] Ignoring an unreadable lease file: ${reasonOf(error)}`);
      }
      for (const lease of leases) this.records.set(lease.id, lease);
    }
    const expired = [...this.records.values()].filter(lease => Date.parse(lease.expiresAt) <= this.now());
    for (const lease of expired) await this.remove(lease, 'swept');
    if (expired.length > 0) await this.save();
    this.arm();
  }

  private async save(): Promise<void> {
    const leases = [...this.records.values()].filter(lease => !lease.memoryOnly);
    await fs.mkdir(this.options.directory, { recursive: true });
    const temporary = `${this.recordFile}.${process.pid}.tmp`;
    await fs.writeFile(temporary, `${JSON.stringify({ leases })}\n`, { mode: 0o600 });
    await fs.rename(temporary, this.recordFile);
  }

  private async log(event: SecretLeaseEvent, lease: SecretLeaseRecord): Promise<void> {
    const line = {
      at: new Date(this.now()).toISOString(),
      event,
      lease: lease.id,
      project: lease.project,
      names: lease.secrets.map(secret => secret.name),
      expiresAt: lease.expiresAt,
      requestedBy: lease.requestedBy,
      grantedOn: lease.grantedOn,
    };
    try {
      await fs.mkdir(this.options.directory, { recursive: true });
      await fs.appendFile(this.logFile, `${JSON.stringify(line)}\n`, { mode: 0o600 });
    } catch (error) {
      console.warn(`[SecretLeases] Could not write the lease log: ${reasonOf(error)}`);
    }
  }

  /** Deletes a lease's values and record (not yet saved), and logs why. A value that can't be removed is retried at the next start. */
  private async remove(lease: SecretLeaseRecord, event: SecretLeaseEvent): Promise<void> {
    let failed = false;
    for (const secret of lease.secrets) {
      const key = valueKey(lease.id, secret.name);
      if (lease.memoryOnly) {
        this.memory.delete(key);
        continue;
      }
      await this.options.values.remove(key).catch((error: unknown) => {
        failed = true;
        console.warn(`[SecretLeases] Could not delete a value of lease ${lease.id}: ${reasonOf(error)}`);
      });
    }
    const endedAt = new Date(this.now()).toISOString();
    for (const secret of lease.secrets) this.endedAt.set(paneSecretKey(lease.project, secret.name), endedAt);
    // A record whose value could not be removed stays, already expired, so the next sweep tries again.
    if (failed) lease.expiresAt = endedAt;
    else this.records.delete(lease.id);
    await this.log(event, lease);
  }

  private arm(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const next = Math.min(...[...this.records.values()].map(lease => Date.parse(lease.expiresAt)));
    if (!Number.isFinite(next)) return;
    this.timer = setTimeout(() => { void this.expireDue(); }, Math.min(Math.max(next - this.now(), 0), MAX_TIMER_MS));
    this.timer.unref?.();
  }

  private expireDue(): Promise<void> {
    return this.serial(async () => {
      const due = [...this.records.values()].filter(lease => Date.parse(lease.expiresAt) <= this.now());
      for (const lease of due) await this.remove(lease, 'expired');
      if (due.length > 0) await this.save();
      this.arm();
      if (due.length > 0) this.changed();
    });
  }

  private changed(): void {
    this.options.onChange?.(this.list());
  }

  /** Stores a new lease, or replaces lease `grant.id` with new values and a new expiry (a renewal). */
  async grant(grant: SecretLeaseGrant): Promise<SecretLeaseSummary> {
    await this.loaded;
    if (grant.secrets.length === 0) throw new PaneError('SECRET_INVALID', 'A lease needs at least one secret. Nothing was changed.', 'Name the secrets to lease.');
    return this.serial(async () => {
      const now = this.now();
      const previous = grant.id ? this.records.get(grant.id) : undefined;
      const lease: SecretLeaseRecord = {
        id: grant.id ?? randomBytes(8).toString('hex'),
        project: grant.project,
        secrets: grant.secrets.map(({ name, reference }) => ({ name, reference })),
        grantedAt: previous?.grantedAt ?? new Date(now).toISOString(),
        expiresAt: new Date(now + Math.max(grant.expiresInMs, 0)).toISOString(),
        requestedBy: grant.requestedBy,
        grantedOn: grant.grantedOn,
        memoryOnly: !this.options.canEncrypt(),
      };
      if (grant.pushedTo) lease.pushedTo = [...grant.pushedTo];
      // The record first, so a crash between the two leaves values the next sweep can find and delete.
      this.records.set(lease.id, lease);
      if (!lease.memoryOnly) await this.save();
      try {
        for (const secret of grant.secrets) {
          const key = valueKey(lease.id, secret.name);
          if (lease.memoryOnly) this.memory.set(key, secret.value);
          else await this.options.values.write(key, secret.value);
        }
      } catch (error) {
        await this.remove(lease, 'ended');
        await this.save();
        throw new PaneError(
          'SECRET_WRITE_FAILED',
          `Pane could not store the lease for ${grant.project}: ${reasonOf(error)}. Nothing was leased.`,
          'Unlock the login keychain (macOS) or check that Pane can write to its data directory, then start the lease again.',
        );
      }
      // Names a renewal dropped lose their values now.
      for (const old of previous?.secrets ?? []) {
        if (lease.secrets.some(secret => secret.name === old.name)) continue;
        const key = valueKey(lease.id, old.name);
        if (previous?.memoryOnly) this.memory.delete(key);
        else await this.options.values.remove(key).catch(() => undefined);
      }
      await this.log(previous ? 'renewed' : 'granted', lease);
      this.arm();
      this.changed();
      return this.summary(lease);
    });
  }

  /** Ends a lease now and deletes its values. Ending one that is already gone is not an error. */
  async end(id: string): Promise<boolean> {
    await this.loaded;
    return this.serial(async () => {
      const lease = this.records.get(id);
      if (!lease) return false;
      await this.remove(lease, 'ended');
      await this.save();
      this.arm();
      this.changed();
      return true;
    });
  }

  async endAll(): Promise<number> {
    await this.loaded;
    const ids = [...this.records.keys()];
    for (const id of ids) await this.end(id);
    return ids.length;
  }

  /** The live lease covering `project/name`, the one ending last when several do. */
  private covering(project: string, name: string): SecretLeaseRecord | null {
    const now = this.now();
    return [...this.records.values()]
      .filter(lease => lease.project === project && Date.parse(lease.expiresAt) > now && lease.secrets.some(secret => secret.name === name))
      .sort((a, b) => Date.parse(b.expiresAt) - Date.parse(a.expiresAt))[0] ?? null;
  }

  /** The leased value of `project/name`. Throws SECRET_LEASE_ENDED when no live lease covers it. */
  async read(project: string, name: string): Promise<string> {
    await this.loaded;
    const lease = this.covering(project, name);
    if (!lease) {
      // A lease past its time whose timer has not fired yet is deleted before answering.
      if ([...this.records.values()].some(record => Date.parse(record.expiresAt) <= this.now())) await this.expireDue();
      throw secretLeaseEnded(project, name, this.endedAt.get(paneSecretKey(project, name)) ?? null);
    }
    const key = valueKey(lease.id, name);
    if (lease.memoryOnly) {
      const value = this.memory.get(key);
      if (value === undefined) throw secretLeaseEnded(project, name, null);
      return value;
    }
    try {
      return await this.options.values.read(key);
    } catch (error) {
      throw new PaneError(
        'SECRET_UNREADABLE',
        `Pane could not read the leased value of ${paneSecretKey(project, name)}: ${reasonOf(error)}.`,
        `Unlock the login keychain (macOS), or end the lease in Settings → Secrets and run \`${secretLeaseRenewCommand(project, [name])}\`.`,
      );
    }
  }

  /** Records which machines the desktop pushed lease `id` to. */
  async setPushedTo(id: string, machines: readonly string[]): Promise<void> {
    await this.loaded;
    return this.serial(async () => {
      const lease = this.records.get(id);
      if (!lease) return;
      lease.pushedTo = [...machines];
      if (!lease.memoryOnly) await this.save();
    });
  }

  /** Whether this machine can keep a lease at rest; false means memory only. */
  memoryOnly(): boolean {
    return !this.options.canEncrypt();
  }

  has(project: string, name: string): boolean {
    return this.covering(project, name) !== null;
  }

  get(id: string): SecretLeaseRecord | null {
    return this.records.get(id) ?? null;
  }

  private summary(lease: SecretLeaseRecord): SecretLeaseSummary {
    return {
      id: lease.id,
      project: lease.project,
      names: lease.secrets.map(secret => secret.name),
      grantedAt: lease.grantedAt,
      expiresAt: lease.expiresAt,
      requestedBy: lease.requestedBy,
      grantedOn: lease.grantedOn,
      memoryOnly: lease.memoryOnly,
    };
  }

  /** Live leases, ending soonest first. Names and times only. */
  list(): SecretLeaseSummary[] {
    const now = this.now();
    return [...this.records.values()]
      .filter(lease => Date.parse(lease.expiresAt) > now)
      .sort((a, b) => Date.parse(a.expiresAt) - Date.parse(b.expiresAt))
      .map(lease => this.summary(lease));
  }

  /** Stops the expiry timer, for tests and shutdown. Values stay until expiry or the next start's sweep. */
  dispose(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}
