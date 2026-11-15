import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'crypto';
import type { RemoteDaemonClientRecord } from '../../../../shared/types/remoteDaemon';
import type { RelayLinkLifetime } from '../../../../shared/types/relay';
import { boundary, decodeOptionalBoundary } from '../../../../shared/validation/boundaryDecoder';

const LINK_LIFETIME_MS = {
  '10m': 10 * 60_000,
  '1h': 60 * 60_000,
  '24h': 24 * 60 * 60_000,
} satisfies Record<RelayLinkLifetime, number>;
/** Used or expired secrets are remembered this long past their expiry, so a late use gets the right message. */
const SPENT_MEMORY_MS = 60 * 60_000;
const MAX_PENDING = 16;
const FAILURE_WINDOW_MS = 60_000;
const FAILURES_BEFORE_LOCK = 5;
const LOCK_MS = 15 * 60_000;
/** Sources with recent wrong secrets kept at once; the oldest is forgotten first. */
const MAX_TRACKED_SOURCES = 1_000;
const MAX_LABEL_LENGTH = 60;

export type PairingRefusal = { ok: false; status: number; code: string; message: string };

export type PairingExchangeResult =
  | { ok: true; token: string; client: RemoteDaemonClientRecord }
  | PairingRefusal;

export interface PairingExchangeRequest {
  secret: string;
  label: string;
  phoneId?: string;
  /** Set when a computer redeems the secret: its relay id. The new record is a linked computer. */
  computerId?: string;
  /** The client's IP address: the relay's `peer` for a relayed connection, else the socket's. */
  source: string;
}

interface SourceFailures {
  failures: number[];
  lockedUntil: number;
}

interface Pending {
  hash: Buffer;
  lifetime: RelayLinkLifetime;
  expiresAt: number;
  spentAt: number | null;
}

/** Where waiting links are kept across restarts: only their hashes, lifetimes and times. */
export interface PendingLinkStore {
  read(): string | null;
  write(text: string): void;
}

const savedSchema = boundary.array(boundary.object({
  hash: boundary.nonEmptyString,
  lifetime: boundary.enumeration('10m', '1h', '24h'),
  expiresAt: boundary.number,
  spentAt: boundary.nullable(boundary.number),
}));

interface PairingExchangeDeps {
  now?: () => number;
  store?: PendingLinkStore;
  /** Saves the new client record in `remoteDaemon.host.clients`, replacing earlier records of the same phone or computer. */
  addClient(record: RemoteDaemonClientRecord): Promise<void>;
  log?: (line: string) => void;
}

function sha256(value: string): Buffer {
  return createHash('sha256').update(value).digest();
}

function cleanLabel(label: string, fallback: string): string {
  const clean = label.replace(/[\p{Cc}\p{Cf}]/gu, '').trim().slice(0, MAX_LABEL_LENGTH);
  return clean || fallback;
}

/**
 * One-time secrets for QR codes and links: 32 random bytes, kept only as a hash, good for one trade
 * until their own expiry (10 minutes, 1 hour or 24 hours), like glasses pairing secrets. The trade
 * and its preview are the pairing listener's only unauthenticated routes, so five wrong secrets
 * from one source within a minute lock that source out for 15 minutes; other sources, the owner's
 * phone among them, still pair.
 */
export class PairingExchange {
  private readonly pending: Pending[] = [];
  private readonly sources = new Map<string, SourceFailures>();
  private readonly now: () => number;

  constructor(private readonly deps: PairingExchangeDeps) {
    this.now = deps.now ?? Date.now;
    let saved: Array<{ hash: string; lifetime: RelayLinkLifetime; expiresAt: number; spentAt: number | null }> = [];
    try {
      const text = deps.store?.read() ?? null;
      saved = (text === null ? undefined : decodeOptionalBoundary(JSON.parse(text), savedSchema)) ?? [];
    } catch (error) {
      deps.log?.(`[pairing] could not read the waiting links, so links made before this start won't work: ${error instanceof Error ? error.message : String(error)}`);
    }
    for (const entry of saved) this.pending.push({ ...entry, hash: Buffer.from(entry.hash, 'hex') });
  }

  /** Keeps the waiting and recently used links, so a link made before Pane restarts still works after. */
  private save(): void {
    if (!this.deps.store) return;
    try {
      this.deps.store.write(JSON.stringify(this.pending.map((entry) => ({ ...entry, hash: entry.hash.toString('hex') }))));
    } catch (error) {
      this.deps.log?.(`[pairing] could not save the waiting links, so they stop working if Pane restarts: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** A new secret. At most 16 wait at once: a 17th spends the oldest 10-minute one, else the oldest. */
  createSecret(lifetime: RelayLinkLifetime = '10m') {
    const now = this.now();
    this.prune(now);
    const waiting = this.pending.filter((entry) => entry.spentAt === null && now <= entry.expiresAt);
    if (waiting.length >= MAX_PENDING) (waiting.find((entry) => entry.lifetime === '10m') ?? waiting[0]).spentAt = now;
    const secret = randomBytes(32).toString('base64url');
    const expiresAt = now + LINK_LIFETIME_MS[lifetime];
    this.pending.push({ hash: sha256(secret), lifetime, expiresAt, spentAt: null });
    this.save();
    return { secret, expiresAt: new Date(expiresAt).toISOString() };
  }

  /** Whether a secret would trade now, without spending it. Wrong secrets count toward the lockout. */
  check(secret: string, source: string): { ok: true; expiresAt: string } | PairingRefusal {
    const now = this.now();
    this.prune(now);
    const found = this.find(secret, source, now);
    return found.ok ? { ok: true, expiresAt: new Date(found.entry.expiresAt).toISOString() } : found;
  }

  async exchange({ secret, label, phoneId, computerId, source }: PairingExchangeRequest): Promise<PairingExchangeResult> {
    const now = this.now();
    this.prune(now);
    const found = this.find(secret, source, now);
    if (!found.ok) return found;
    found.entry.spentAt = now;
    this.save();
    const token = randomBytes(32).toString('base64url');
    const client: RemoteDaemonClientRecord = {
      id: randomUUID(),
      label: cleanLabel(label, computerId ? 'Computer' : 'Phone'),
      createdAt: new Date(now).toISOString(),
      tokenHash: sha256(token).toString('hex'),
    };
    if (computerId) {
      client.kind = 'computer';
      client.computerId = computerId;
    } else if (phoneId) {
      client.phoneId = phoneId.slice(0, 100);
    }
    await this.deps.addClient(client);
    return { ok: true, token, client };
  }

  private find(secret: string, source: string, now: number): { ok: true; entry: Pending } | PairingRefusal {
    if (now < (this.sources.get(source)?.lockedUntil ?? 0)) {
      return { ok: false, status: 429, code: 'ERR_PAIRING_LOCKED', message: 'Too many wrong pairing codes from this network. Try again in 15 minutes.' };
    }
    const presented = sha256(secret);
    const entry = this.pending.find((candidate) => timingSafeEqual(candidate.hash, presented));
    if (!entry) {
      this.recordFailure(source, now);
      return { ok: false, status: 403, code: 'ERR_PAIRING_CODE_INVALID', message: 'This computer has no such link or code waiting, so nothing was paired. Ask for a new link, or scan the code it shows now.' };
    }
    if (entry.spentAt !== null && entry.expiresAt > entry.spentAt) {
      return { ok: false, status: 410, code: 'ERR_PAIRING_CODE_USED', message: 'This code was already used. Ask for a new link, or scan the new code on the computer.' };
    }
    if (entry.spentAt !== null || now > entry.expiresAt) {
      entry.spentAt ??= now;
      return { ok: false, status: 410, code: 'ERR_PAIRING_CODE_EXPIRED', message: 'This code expired. Ask for a new link, or scan the new code on the computer.' };
    }
    return { ok: true, entry };
  }

  private recordFailure(source: string, now: number): void {
    const state = this.sources.get(source) ?? { failures: [], lockedUntil: 0 };
    // Re-inserted, so the map stays ordered from least to most recently failed.
    this.sources.delete(source);
    this.sources.set(source, state);
    state.failures = [...state.failures.filter((at) => now - at < FAILURE_WINDOW_MS), now];
    if (state.failures.length >= FAILURES_BEFORE_LOCK) {
      state.failures = [];
      state.lockedUntil = now + LOCK_MS;
      this.deps.log?.(`[pairing] ${FAILURES_BEFORE_LOCK} wrong pairing codes within a minute from ${source}; it is locked out for 15 minutes`);
    }
    for (const oldest of this.sources.keys()) {
      if (this.sources.size <= MAX_TRACKED_SOURCES) break;
      this.sources.delete(oldest);
    }
  }

  private prune(now: number): void {
    for (let index = this.pending.length - 1; index >= 0; index -= 1) {
      const entry = this.pending[index];
      if (now - Math.max(entry.expiresAt, entry.spentAt ?? 0) > SPENT_MEMORY_MS) this.pending.splice(index, 1);
    }
    for (const [source, state] of this.sources) {
      if (now >= state.lockedUntil && state.failures.every((at) => now - at >= FAILURE_WINDOW_MS)) this.sources.delete(source);
    }
  }
}
