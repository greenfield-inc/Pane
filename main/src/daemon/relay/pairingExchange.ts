import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'crypto';
import type { RemoteDaemonClientRecord } from '../../../../shared/types/remoteDaemon';

const SECRET_TTL_MS = 10 * 60_000;
/** Recently used or expired secrets are remembered this long, so a late scan gets the right message. */
const SPENT_MEMORY_MS = 60 * 60_000;
const MAX_PENDING = 16;
const FAILURE_WINDOW_MS = 60_000;
const FAILURES_BEFORE_LOCK = 5;
const LOCK_MS = 15 * 60_000;
const MAX_LABEL_LENGTH = 60;

export type PairingExchangeResult =
  | { ok: true; token: string; client: RemoteDaemonClientRecord }
  | { ok: false; status: number; code: string; message: string };

export interface PairedEvent {
  clientId: string;
  label: string;
}

interface Pending {
  hash: Buffer;
  expiresAt: number;
  spentAt: number | null;
}

interface PairingExchangeDeps {
  now?: () => number;
  /** Saves the new client record in `remoteDaemon.host.clients`. */
  addClient(record: RemoteDaemonClientRecord): Promise<void>;
  log?: (line: string) => void;
}

function sha256(value: string): Buffer {
  return createHash('sha256').update(value).digest();
}

function cleanLabel(label: string): string {
  const clean = label.replace(/[\p{Cc}\p{Cf}]/gu, '').trim().slice(0, MAX_LABEL_LENGTH);
  return clean || 'Phone';
}

/**
 * One-time QR secrets: 32 random bytes, kept only as a hash, good for 10 minutes and one trade,
 * like glasses pairing secrets. The trade is the pairing listener's only unauthenticated route, so
 * five wrong secrets within a minute lock it for 15 minutes.
 */
export class PairingExchange {
  private readonly pending: Pending[] = [];
  private failures: number[] = [];
  private lockedUntil = 0;
  private readonly listeners = new Set<(event: PairedEvent) => void>();
  private readonly now: () => number;

  constructor(private readonly deps: PairingExchangeDeps) {
    this.now = deps.now ?? Date.now;
  }

  createSecret(): { secret: string; expiresAt: string } {
    const now = this.now();
    this.prune(now);
    const live = this.pending.filter((entry) => entry.spentAt === null);
    if (live.length >= MAX_PENDING) live[0].spentAt = now;
    const secret = randomBytes(32).toString('base64url');
    const expiresAt = now + SECRET_TTL_MS;
    this.pending.push({ hash: sha256(secret), expiresAt, spentAt: null });
    return { secret, expiresAt: new Date(expiresAt).toISOString() };
  }

  onPaired(listener: (event: PairedEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async exchange(secret: string, label: string): Promise<PairingExchangeResult> {
    const now = this.now();
    this.prune(now);
    if (now < this.lockedUntil) {
      return { ok: false, status: 429, code: 'ERR_PAIRING_LOCKED', message: 'Too many wrong pairing codes on this computer. Try again in 15 minutes.' };
    }
    const presented = sha256(secret);
    const entry = this.pending.find((candidate) => timingSafeEqual(candidate.hash, presented));
    if (!entry) {
      this.recordFailure(now);
      return { ok: false, status: 403, code: 'ERR_PAIRING_CODE_INVALID', message: 'This code is not from this computer. Scan the code it shows now.' };
    }
    if (entry.spentAt !== null && entry.expiresAt > entry.spentAt) {
      return { ok: false, status: 410, code: 'ERR_PAIRING_CODE_USED', message: 'This code was already used. Scan the new code on the computer.' };
    }
    if (entry.spentAt !== null || now > entry.expiresAt) {
      entry.spentAt ??= now;
      return { ok: false, status: 410, code: 'ERR_PAIRING_CODE_EXPIRED', message: 'This code expired. Scan the new code on the computer.' };
    }
    entry.spentAt = now;
    const token = randomBytes(32).toString('base64url');
    const client: RemoteDaemonClientRecord = {
      id: randomUUID(),
      label: cleanLabel(label),
      createdAt: new Date(now).toISOString(),
      tokenHash: sha256(token).toString('hex'),
    };
    await this.deps.addClient(client);
    for (const listener of this.listeners) listener({ clientId: client.id, label: client.label });
    return { ok: true, token, client };
  }

  private recordFailure(now: number): void {
    this.failures = [...this.failures.filter((at) => now - at < FAILURE_WINDOW_MS), now];
    if (this.failures.length >= FAILURES_BEFORE_LOCK) {
      this.failures = [];
      this.lockedUntil = now + LOCK_MS;
      this.deps.log?.(`[pairing] ${FAILURES_BEFORE_LOCK} wrong pairing codes within a minute; the exchange is locked for 15 minutes`);
    }
  }

  private prune(now: number): void {
    for (let index = this.pending.length - 1; index >= 0; index -= 1) {
      const entry = this.pending[index];
      if (now - Math.max(entry.expiresAt, entry.spentAt ?? 0) > SPENT_MEMORY_MS) this.pending.splice(index, 1);
    }
  }
}
