import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import {
  boundary,
  decodeBoundary,
  type BoundarySchema,
  type JsonValue,
} from '../../../shared/validation/boundaryDecoder';
import type { RunpaneLockOwner, RunpaneLockRecord } from '../../../shared/types/runpaneOrchestration';

const NAMED_LOCK_STORE_VERSION = 1;
const MAX_STORE_BYTES = 1_000_000;
/** Bounds the store so a runaway script cannot grow it without limit. */
export const MAX_NAMED_LOCKS = 512;
/** Same character set as watch cursor names, up to 128 characters. */
export const NAMED_LOCK_NAME_PATTERN = /^[A-Za-z0-9._-]{1,128}$/u;
export const MAX_NAMED_LOCK_TEXT_LENGTH = 500;

interface NamedLockStoreData {
  version: typeof NAMED_LOCK_STORE_VERSION;
  locks: RunpaneLockRecord[];
}

const ownerSchema: BoundarySchema<RunpaneLockOwner> = boundary.object({
  kind: boundary.enumeration('pane', 'external'),
  paneId: boundary.optional(boundary.nonEmptyString),
  panelId: boundary.optional(boundary.nonEmptyString),
  label: boundary.optional(boundary.nonEmptyString),
});

const lockSchema: BoundarySchema<RunpaneLockRecord> = boundary.object({
  name: boundary.nonEmptyString,
  scope: boundary.enumeration('session', 'global'),
  sessionId: boundary.optional(boundary.nonEmptyString),
  owner: ownerSchema,
  note: boundary.optional(boundary.string),
  acquiredAt: boundary.nonEmptyString,
  expiresAt: boundary.nonEmptyString,
  ttlMs: boundary.number,
});

const storeSchema: BoundarySchema<NamedLockStoreData> = boundary.object({
  version: boundary.literal(NAMED_LOCK_STORE_VERSION),
  locks: boundary.array(lockSchema),
});

/**
 * Durable JSON file behind named locks (`<paneDir>/locks.json`). Every write
 * validates the whole snapshot and publishes it with temp-and-rename, so a
 * crash leaves either the previous or the next complete file.
 */
export class NamedLockStore {
  constructor(private readonly filePath: string) {}

  /** Read the saved locks; a missing file is an empty store. */
  read(): RunpaneLockRecord[] {
    try {
      const raw = fs.readFileSync(this.filePath, 'utf8');
      if (Buffer.byteLength(raw, 'utf8') > MAX_STORE_BYTES) {
        throw new Error(`named lock store exceeds ${MAX_STORE_BYTES} bytes`);
      }
      return validateStore(decodeBoundary(JSON.parse(raw), boundary.json)).locks;
    } catch (error) {
      if (error instanceof Error && isFileMissing(error)) return [];
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Unable to read named lock store ${this.filePath}: ${message}`);
    }
  }

  write(locks: RunpaneLockRecord[]): void {
    const validated = validateStore({ version: NAMED_LOCK_STORE_VERSION, locks });
    const temporaryPath = `${this.filePath}.tmp-${process.pid}-${randomUUID()}`;
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
    try {
      const payload = `${JSON.stringify(validated, null, 2)}\n`;
      if (Buffer.byteLength(payload, 'utf8') > MAX_STORE_BYTES) {
        throw new Error(`named lock store exceeds ${MAX_STORE_BYTES} bytes`);
      }
      fs.writeFileSync(temporaryPath, payload, { mode: 0o600 });
      fs.renameSync(temporaryPath, this.filePath);
    } finally {
      if (fs.existsSync(temporaryPath)) fs.unlinkSync(temporaryPath);
    }
  }
}

function validateStore(value: JsonValue | NamedLockStoreData): NamedLockStoreData {
  const decoded = decodeBoundary(value, storeSchema);
  if (decoded.locks.length > MAX_NAMED_LOCKS) {
    throw new Error(`named lock store contains more than ${MAX_NAMED_LOCKS} locks`);
  }
  const keys = new Set<string>();
  for (const lock of decoded.locks) {
    validateLock(lock);
    const key = namedLockKey(lock.name, lock.sessionId);
    if (keys.has(key)) throw new Error(`named lock store contains duplicate lock ${lock.name}`);
    keys.add(key);
  }
  return decoded;
}

function validateLock(lock: RunpaneLockRecord): void {
  if (!NAMED_LOCK_NAME_PATTERN.test(lock.name)) throw new Error(`Lock name ${lock.name} is invalid`);
  if ((lock.scope === 'session') !== (lock.sessionId !== undefined)) {
    throw new Error(`Lock ${lock.name} scope does not match its Session`);
  }
  if (lock.owner.kind === 'pane' && !lock.owner.paneId) throw new Error(`Lock ${lock.name} Pane owner needs a Pane id`);
  if (lock.owner.kind === 'external' && !lock.owner.label) throw new Error(`Lock ${lock.name} external owner needs a label`);
  for (const text of [lock.note, lock.owner.label]) {
    if (text !== undefined && text.length > MAX_NAMED_LOCK_TEXT_LENGTH) {
      throw new Error(`Lock ${lock.name} text exceeds ${MAX_NAMED_LOCK_TEXT_LENGTH} characters`);
    }
  }
  if (!Number.isFinite(lock.ttlMs) || lock.ttlMs <= 0) throw new Error(`Lock ${lock.name} has an invalid TTL`);
  for (const timestamp of [lock.acquiredAt, lock.expiresAt]) {
    if (!Number.isFinite(Date.parse(timestamp))) throw new Error(`Lock ${lock.name} has an invalid timestamp`);
  }
}

/** Locks are unique per (Session scope, name); a global lock has no Session. */
export function namedLockKey(name: string, sessionId: string | undefined): string {
  return `${sessionId ?? ''}\u0000${name}`;
}

interface FileSystemError extends Error {
  code?: string;
}

function isFileMissing(error: Error): error is FileSystemError {
  // SAFETY: Node filesystem errors expose an optional string `code` property.
  return (error as FileSystemError).code === 'ENOENT';
}
