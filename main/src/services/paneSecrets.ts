import { safeStorage as electronSafeStorage } from 'electron';
import { randomBytes } from 'crypto';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { PaneError, reasonOf } from '../../../shared/paneError';
import { boundary, decodeBoundary, type BoundarySchema } from '../../../shared/validation/boundaryDecoder';
import {
  paneSecretKey,
  paneSecretNameProblem,
  paneSecretProjectProblem,
  paneSecretReferenceProblem,
  parsePaneSecretKey,
  secretLeaseRenewCommand,
  type PaneSecretReferenceSummary,
  type PaneSecretStorage,
  type PaneSecretSummary,
} from '../../../shared/types/paneSecrets';
import type { SharedCredential } from '../../../shared/types/sharedCredentials';
import { SecretLeaseStore } from './secretLeases';
import type { AppConfig } from '../types/config';
import { getPaneEventSink, getRuntimeConfigManager } from '../core/runtime';
import { getAppDirectory } from '../utils/appDirectory';
import { KeychainItemMissing, paneKeychainService, systemKeychain, type Keychain } from './keychain';
import { readFileSync } from 'fs';
import { EMPTY_PANE_CLOUD_SECRET_CHOICE, sendsToCloud, type PaneCloudSecretChoice } from '../../../shared/types/paneCloudSecrets';
import { parseCloudChoice } from './cloudSecrets';

/** Index record for one secret, kept in config.json. Never holds the value. */
export interface PaneSecretMeta {
  updatedAt: string;
  /** Host where it was last set or deleted. */
  source: string;
  /** Present when the secret was deleted, so an older copy on another host cannot bring it back. */
  deleted?: true;
}

/** Index record for a secret whose value lives in 1Password, kept in config.json under `paneSecretReferences`. */
export interface PaneSecretReferenceMeta extends PaneSecretMeta {
  /** `op://<vault>/<item>/<field>`; absent once removed. */
  reference?: string;
}

/** "Choose what to send" as a host keeps it, with when and where the person last changed it. */
export interface PaneCloudSecretChoiceMeta extends PaneCloudSecretChoice {
  updatedAt: string;
  source: string;
}

/** Where values live: the macOS keychain, or one 0600 file elsewhere. Addressed by `<project>/<NAME>`. */
export interface SecretValueBackend {
  storage(): PaneSecretStorage;
  read(key: string): Promise<string>;
  write(key: string, value: string): Promise<void>;
  remove(key: string): Promise<void>;
}

/** Encryption for the file backend; Electron's async safeStorage API in the app. */
export interface SecretEncryption {
  available(): boolean;
  encrypt(text: string): Promise<Buffer>;
  decrypt(data: Buffer): Promise<string>;
}

const MAX_VALUE_BYTES = 64 * 1024;
/** How far ahead of this host's clock a synced reference's time may be. */
const MAX_CLOCK_AHEAD_MS = 5 * 60_000;

function localHostLabel(): string {
  return os.hostname().replace(/\.local$/i, '');
}

/** UTF-8 bytes per keychain item: `security -i` splits a command line at about 4 KB, and the value goes as hex. */
const KEYCHAIN_PART_BYTES = 1024;
/** Starts the main item of a value stored in parts; no text a person types starts with NUL. */
const PARTS_MARKER = '\u0000pane-parts:';

/** `value` cut into pieces of at most `limit` UTF-8 bytes, never inside a character. */
function splitUtf8(value: string, limit: number): string[] {
  const parts: string[] = [];
  let current = '';
  let bytes = 0;
  for (const char of value) {
    const size = Buffer.byteLength(char);
    if (bytes + size > limit) {
      parts.push(current);
      current = '';
      bytes = 0;
    }
    current += char;
    bytes += size;
  }
  return [...parts, current];
}

/**
 * Values in the login keychain under Pane's per-data-dir service, account `secret:<project>/<NAME>`.
 * A value longer than one item holds is written as parts (`secret:<key>#<generation>.<n>`) first,
 * then a main item that lists them, so a failed write leaves the earlier value whole.
 */
export function keychainSecretBackend(keychain: Keychain, service: string): SecretValueBackend {
  const account = (key: string) => `secret:${key}`;
  const partAccount = (key: string, generation: string, index: number) => `secret:${key}#${generation}.${index}`;
  const partsOf = (main: string): { generation: string; count: number } | null => {
    const match = main.startsWith(PARTS_MARKER) ? /^([0-9a-z]+):(\d+)$/.exec(main.slice(PARTS_MARKER.length)) : null;
    return match ? { generation: match[1], count: Number(match[2]) } : null;
  };
  /** Removes the parts; an item already gone counts as removed, any other failure is thrown. */
  const removeParts = async (key: string, parts: { generation: string; count: number }) => {
    const results = await Promise.allSettled(
      Array.from({ length: parts.count }, (_, index) => keychain.remove(service, partAccount(key, parts.generation, index))),
    );
    const failed = results.find(result => result.status === 'rejected' && !(result.reason instanceof KeychainItemMissing));
    if (failed?.status === 'rejected') throw failed.reason;
  };
  /** The parts the main item lists, or null when there is no main item or it holds the value itself. */
  const currentParts = async (key: string) => {
    try {
      return partsOf(await keychain.read(service, account(key)));
    } catch (error) {
      if (error instanceof KeychainItemMissing) return null;
      throw error;
    }
  };
  return {
    storage: () => ({ kind: 'keychain', encrypted: true }),
    async read(key) {
      const main = await keychain.read(service, account(key));
      const parts = partsOf(main);
      if (!parts) return main;
      const pieces = await Promise.all(Array.from({ length: parts.count }, (_, index) => keychain.read(service, partAccount(key, parts.generation, index))));
      return pieces.join('');
    },
    async write(key, value) {
      const previous = await currentParts(key);
      const pieces = splitUtf8(value, KEYCHAIN_PART_BYTES);
      if (pieces.length === 1 && !value.startsWith(PARTS_MARKER)) {
        await keychain.write(service, account(key), value);
      } else {
        const generation = randomBytes(6).toString('hex');
        const parts = { generation, count: pieces.length };
        try {
          for (const [index, piece] of pieces.entries()) await keychain.write(service, partAccount(key, generation, index), piece);
          await keychain.write(service, account(key), `${PARTS_MARKER}${generation}:${pieces.length}`);
        } catch (error) {
          await removeParts(key, parts).catch(() => undefined);
          throw error;
        }
      }
      // Nothing points at the earlier parts now. One that cannot be removed keeps the earlier value.
      if (previous) await removeParts(key, previous).catch(() => undefined);
    },
    async remove(key) {
      // Parts first: the main item is the only record of them, so it goes last.
      const previous = await currentParts(key);
      if (previous) await removeParts(key, previous);
      try {
        await keychain.remove(service, account(key));
      } catch (error) {
        if (!(error instanceof KeychainItemMissing)) throw error;
      }
    },
  };
}

interface SecretFile {
  version: 1;
  values: Record<string, { encrypted: boolean; data: string }>;
}

const secretFileSchema = boundary.object({
  values: boundary.record(boundary.object({ encrypted: boundary.boolean, data: boundary.string })),
});

/**
 * Values in one 0600 JSON file. Each value is encrypted with `encryption` when the OS
 * offers it (DPAPI on Windows, the keyring on desktop Linux), and kept as plain text
 * with `encrypted: false` when it does not, as on a headless Linux host.
 */
export function fileSecretBackend(filePath: string, encryption: SecretEncryption): SecretValueBackend {
  let queue: Promise<unknown> = Promise.resolve();
  const serial = <T>(work: () => Promise<T>): Promise<T> => {
    const run = queue.then(work, work);
    queue = run.catch(() => undefined);
    return run;
  };

  const load = async (): Promise<SecretFile> => {
    const text = await fs.readFile(filePath, 'utf8').catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (text === null) return { version: 1, values: {} };
    return { version: 1, values: decodeBoundary(JSON.parse(text), secretFileSchema).values };
  };

  const save = async (file: SecretFile) => {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    const temporary = `${filePath}.${process.pid}.tmp`;
    await fs.writeFile(temporary, `${JSON.stringify(file)}\n`, { mode: 0o600 });
    await fs.chmod(temporary, 0o600);
    await fs.rename(temporary, filePath);
  };

  return {
    storage: () => ({ kind: 'file', encrypted: encryption.available() }),
    read: key => serial(async () => {
      const entry = (await load()).values[key];
      if (!entry) throw new Error('No value is stored for it on this host');
      return entry.encrypted ? await encryption.decrypt(Buffer.from(entry.data, 'base64')) : entry.data;
    }),
    write: (key, value) => serial(async () => {
      const file = await load();
      const encrypted = encryption.available();
      file.values[key] = { encrypted, data: encrypted ? (await encryption.encrypt(value)).toString('base64') : value };
      await save(file);
    }),
    remove: key => serial(async () => {
      const file = await load();
      if (!(key in file.values)) return;
      delete file.values[key];
      await save(file);
    }),
  };
}

/**
 * Electron's safeStorage, or no encryption outside Electron. Linux's `basic_text` backend counts as none.
 * Writes use the async API (the sync one is removed in Electron 46); a value the async API cannot
 * decrypt is read with the sync one, so values written before the move keep reading.
 */
function electronSecretEncryption(): SecretEncryption {
  type SafeStorage = Electron.SafeStorage;
  const safeStorage: SafeStorage | null = electronSafeStorage ?? null;
  const available = () => {
    if (!safeStorage?.isEncryptionAvailable()) return false;
    return process.platform !== 'linux' || safeStorage.getSelectedStorageBackend() !== 'basic_text';
  };
  return {
    available,
    encrypt: async text => {
      if (!safeStorage) throw new Error('Encryption is not available');
      return safeStorage.encryptStringAsync(text);
    },
    decrypt: async data => {
      if (!safeStorage) throw new Error('Encryption is not available');
      try {
        return (await safeStorage.decryptStringAsync(data)).result;
      } catch {
        // Written by the sync API before the move. Electron 46 removes it: re-encrypt such values before upgrading.
        return safeStorage.decryptString(data);
      }
    },
  };
}

/** The value store for this host: the keychain on macOS, the file elsewhere. */
export function systemSecretBackend(appDirectory: string, platform: string = process.platform): SecretValueBackend {
  if (platform === 'darwin') return keychainSecretBackend(systemKeychain(platform), paneKeychainService(appDirectory));
  return fileSecretBackend(path.join(appDirectory, 'secrets.json'), electronSecretEncryption());
}

/**
 * The secrets volume, when this machine has one: a Pane Cloud VM's guest mounts it and names it in
 * PANE_SECRETS_DIR. Everything about Pane secrets is kept there (values, the index of names and
 * machines, the cloud choice, leases), never on the Session disk, which scans and staff can open
 * (D-55, D-58, D-84). Other machines keep values in the OS store and the index in config.json.
 */
export function secretsVolume(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return env.PANE_SECRETS_DIR?.trim() || undefined;
}

/** Where Pane secrets and leases keep their values: on the secrets volume when there is one (`secretsVolume`). */
export function paneSecretValueBackend(appDirectory: string, volume: string | undefined = secretsVolume()): SecretValueBackend {
  if (volume === undefined) return systemSecretBackend(appDirectory);
  return fileSecretBackend(path.join(volume, 'secrets.json'), electronSecretEncryption());
}

/**
 * A reference read back from config.json passes the same check as one the person set: an edited
 * file can't point a name at text op would expand (a `$`, braces) or that isn't a reference at all.
 */
function usableReference(reference: string | undefined): reference is string {
  return reference !== undefined && paneSecretReferenceProblem(reference) === null;
}

export function secretNotFound(project: string, name: string): PaneError {
  return new PaneError(
    'SECRET_NOT_FOUND',
    `No secret ${paneSecretKey(project, name)} on this machine yet.`,
    'Run `runpane secrets request`, or open Pane on a desktop connected to this machine so it syncs.',
  );
}

function invalidSecret(message: string): PaneError {
  return new PaneError('SECRET_INVALID', `${message} Nothing was changed.`, 'See `runpane secrets --help` for the naming rules.');
}

export function validatePaneSecretAddress(project: string, name: string): void {
  const problem = paneSecretProjectProblem(project) ?? paneSecretNameProblem(name);
  if (problem) throw invalidSecret(problem);
}

/** The part of config a secret store reads and writes: its index, the cloud choice, and the sharing setting `read` checks. */
type SecretIndex = Pick<AppConfig, 'paneSecrets' | 'paneSecretReferences' | 'paneCloudSecretChoice' | 'workspaces'>;

/** Where a secret store keeps its index: config.json (a ConfigManager), or a file on a cloud VM's secrets volume. */
export interface SecretIndexStore {
  getConfig(): SecretIndex;
  /** Applies `update` and resolves with the index afterwards. */
  updateConfigWith(update: (current: SecretIndex) => Partial<SecretIndex>): Promise<SecretIndex>;
}

const indexMetaSchema = boundary.object({
  updatedAt: boundary.nonEmptyString,
  source: boundary.nonEmptyString,
  deleted: boundary.optional(boundary.literal(true)),
});
const volumeIndexSchema = boundary.object({
  paneSecrets: boundary.optional(boundary.record(indexMetaSchema)),
  paneSecretReferences: boundary.optional(boundary.record(boundary.object({
    updatedAt: boundary.nonEmptyString,
    source: boundary.nonEmptyString,
    deleted: boundary.optional(boundary.literal(true)),
    reference: boundary.optional(boundary.string),
  }))),
  paneCloudSecretChoice: boundary.optional(boundary.object({
    excludedSecrets: boundary.array(boundary.string),
    excludedMachines: boundary.array(boundary.string),
    updatedAt: boundary.nonEmptyString,
    source: boundary.nonEmptyString,
  })),
});

/**
 * The index in one 0600 file in `directory`, a cloud VM's secrets volume, so secret names and the
 * machines they came from stay off the Session disk (D-84). `workspaces` still comes from config.json.
 */
export function volumeSecretIndex(directory: string, base: () => Pick<AppConfig, 'workspaces'>): SecretIndexStore {
  const file = path.join(directory, 'index.json');
  type Stored = Omit<SecretIndex, 'workspaces'>;
  let index: Stored = {};
  try {
    index = decodeBoundary(JSON.parse(readFileSync(file, 'utf8')), volumeIndexSchema);
  } catch (error) {
    const code = error instanceof Error && 'code' in error ? error.code : undefined;
    if (code !== 'ENOENT') console.warn(`[PaneSecrets] The secrets index on the secrets volume could not be read, so it starts empty: ${reasonOf(error)}`);
  }
  let queue: Promise<unknown> = Promise.resolve();
  const current = (): SecretIndex => ({ ...index, workspaces: base().workspaces });
  return {
    getConfig: current,
    updateConfigWith(update) {
      const run = queue.then(async () => {
        const { workspaces: _workspaces, ...changes } = update(current());
        const next: Stored = { ...index, ...changes };
        await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
        const temporary = `${file}.${process.pid}.tmp`;
        await fs.writeFile(temporary, `${JSON.stringify(next)}\n`, { mode: 0o600 });
        await fs.rename(temporary, file);
        index = next;
        return current();
      });
      queue = run.catch(() => undefined);
      return run;
    },
  };
}

function isNewer(candidate: SharedCredential, current: Pick<PaneSecretMeta, 'updatedAt'> | undefined): boolean {
  return !current || Date.parse(candidate.updatedAt) > Date.parse(current.updatedAt);
}

/**
 * Pane secrets on this host: an index in config.json (`paneSecrets`) and values in
 * the OS store. Changing the index emits config-updated, which starts a sync with
 * the other saved hosts. No method logs, returns in an error, or stores a value
 * anywhere but the value backend.
 */
export class PaneSecretStore {
  private queue: Promise<unknown> = Promise.resolve();
  /** Values by key and `updatedAt`, so a sync reads the OS store only for a changed secret. */
  private readonly known = new Map<string, { updatedAt: string; value: string }>();

  constructor(
    private readonly config: SecretIndexStore,
    private readonly values: SecretValueBackend,
    private readonly hostLabel: () => string = localHostLabel,
    private readonly now: () => Date = () => new Date(),
    /** Called after a set or delete made on this host, never for one that arrived by sync. */
    private readonly onLocalChange: () => void = () => undefined,
    /** Leases that hold the values of 1Password references; none means references have no value here. */
    private readonly leases: () => SecretLeaseStore | null = () => null,
  ) {}

  storage(): PaneSecretStorage {
    return this.values.storage();
  }

  private index(): Record<string, PaneSecretMeta> {
    return this.config.getConfig().paneSecrets ?? {};
  }

  private referenceIndex(): Record<string, PaneSecretReferenceMeta> {
    return this.config.getConfig().paneSecretReferences ?? {};
  }

  /** The 1Password reference behind `project/name`, or null when it is a typed secret or none. */
  referenceOf(project: string, name: string): string | null {
    const meta = this.referenceIndex()[paneSecretKey(project, name)];
    return meta && !meta.deleted && usableReference(meta.reference) ? meta.reference : null;
  }

  /** Secrets whose values live in 1Password, sorted by project then name. */
  listReferences(project?: string): PaneSecretReferenceSummary[] {
    return Object.entries(this.referenceIndex()).flatMap(([key, meta]) => {
      const address = parsePaneSecretKey(key);
      if (!address || meta.deleted || !usableReference(meta.reference) || (project !== undefined && address.project !== project)) return [];
      return [{ ...address, reference: meta.reference, updatedAt: meta.updatedAt, machine: meta.source }];
    }).sort((a, b) => a.project.localeCompare(b.project) || a.name.localeCompare(b.name));
  }

  /**
   * Points `project/name` at a 1Password item. Only the person does this, from Settings. A typed
   * secret of the same name is deleted here and, through sync, on every host: that is "Move to 1Password".
   */
  async setReference(project: string, name: string, reference: string): Promise<{ replacedTyped: boolean }> {
    validatePaneSecretAddress(project, name);
    const problem = paneSecretReferenceProblem(reference);
    if (problem) throw invalidSecret(problem);
    const replacedTyped = this.has(project, name) && !this.referenceOf(project, name);
    if (replacedTyped) await this.delete(project, name);
    return this.serial(async () => {
      const key = paneSecretKey(project, name);
      const meta: PaneSecretReferenceMeta = { updatedAt: this.now().toISOString(), source: this.hostLabel(), reference };
      await this.config.updateConfigWith(config => ({ paneSecretReferences: { ...config.paneSecretReferences, [key]: meta } }));
      this.onLocalChange();
      return { replacedTyped };
    });
  }

  private async deleteReference(project: string, name: string): Promise<void> {
    return this.serial(async () => {
      const key = paneSecretKey(project, name);
      const meta: PaneSecretReferenceMeta = { updatedAt: this.now().toISOString(), source: this.hostLabel(), deleted: true };
      await this.config.updateConfigWith(config => ({ paneSecretReferences: { ...config.paneSecretReferences, [key]: meta } }));
      this.onLocalChange();
    });
  }

  private serial<T>(work: () => Promise<T>): Promise<T> {
    const run = this.queue.then(work, work);
    this.queue = run.catch(() => undefined);
    return run;
  }

  /** Live secrets, sorted by project then name. */
  list(project?: string): PaneSecretSummary[] {
    return Object.entries(this.index()).flatMap(([key, meta]) => {
      const address = parsePaneSecretKey(key);
      if (!address || meta.deleted || (project !== undefined && address.project !== project)) return [];
      return [{ ...address, updatedAt: meta.updatedAt, machine: meta.source }];
    }).sort((a, b) => a.project.localeCompare(b.project) || a.name.localeCompare(b.name));
  }

  /** Whether `project/name` exists here, typed or as a 1Password reference. */
  has(project: string, name: string): boolean {
    const meta = this.index()[paneSecretKey(project, name)];
    return Boolean(meta && !meta.deleted) || this.referenceOf(project, name) !== null;
  }

  /** Store `value` under `project/name`, replacing any saved value. */
  async set(project: string, name: string, value: string): Promise<{ replaced: boolean; secret: PaneSecretSummary }> {
    validatePaneSecretAddress(project, name);
    if (!value) throw invalidSecret('A secret value cannot be empty.');
    if (Buffer.byteLength(value, 'utf8') > MAX_VALUE_BYTES) throw invalidSecret('A secret value can be at most 64 KiB.');
    if (this.referenceOf(project, name)) {
      throw new PaneError(
        'SECRET_IS_REFERENCE',
        `${paneSecretKey(project, name)} comes from 1Password, so Pane does not store a value for it. Nothing was changed.`,
        `Run \`${secretLeaseRenewCommand(project, [name])}\` to use it, or remove the reference in Settings → Secrets first.`,
      );
    }
    return this.serial(async () => {
      const key = paneSecretKey(project, name);
      const replaced = this.has(project, name);
      try {
        await this.values.write(key, value);
      } catch (error) {
        throw new PaneError(
          'SECRET_WRITE_FAILED',
          `Pane could not store ${key}: ${reasonOf(error)}. Nothing was changed.`,
          this.values.storage().kind === 'keychain'
            ? 'Unlock the login keychain in Keychain Access, then try again.'
            : 'Check that Pane can write to its data directory, then try again.',
        );
      }
      const meta: PaneSecretMeta = { updatedAt: this.now().toISOString(), source: this.hostLabel() };
      await this.config.updateConfigWith(config => ({ paneSecrets: { ...config.paneSecrets, [key]: meta } }));
      this.known.set(key, { updatedAt: meta.updatedAt, value });
      this.onLocalChange();
      return { replaced, secret: { project, name, updatedAt: meta.updatedAt, machine: meta.source } };
    });
  }

  /** Delete `project/name` here; the deletion reaches other hosts on the next sync. */
  async delete(project: string, name: string): Promise<void> {
    validatePaneSecretAddress(project, name);
    if (this.referenceOf(project, name)) return this.deleteReference(project, name);
    return this.serial(async () => {
      if (!this.has(project, name)) throw secretNotFound(project, name);
      const key = paneSecretKey(project, name);
      // The value first, so a refused removal leaves the secret listed and the delete can be retried.
      try {
        await this.values.remove(key);
      } catch (error) {
        throw new PaneError(
          'SECRET_WRITE_FAILED',
          `Pane could not delete ${key}: ${reasonOf(error)}. The secret is still saved.`,
          this.values.storage().kind === 'keychain'
            ? 'Unlock the login keychain in Keychain Access, then delete it again.'
            : 'Check that Pane can write to its data directory, then delete it again.',
        );
      }
      const meta: PaneSecretMeta = { updatedAt: this.now().toISOString(), source: this.hostLabel(), deleted: true };
      await this.config.updateConfigWith(config => ({ paneSecrets: { ...config.paneSecrets, [key]: meta } }));
      this.known.delete(key);
      this.onLocalChange();
    });
  }

  /**
   * The value of `project/name`: typed, or from its live lease when it is a 1Password reference.
   * Throws SECRET_NOT_FOUND, SECRET_LEASE_ENDED or SECRET_UNREADABLE, never with the value.
   */
  async read(project: string, name: string): Promise<string> {
    validatePaneSecretAddress(project, name);
    const leases = this.leases();
    if (this.config.getConfig().workspaces?.visibility === 'tailnet' && (leases?.has(project, name) || this.referenceOf(project, name))) {
      throw new PaneError(
        'SECRET_LEASE_REFUSED',
        `${paneSecretKey(project, name)} comes from 1Password, and this machine is shared with everyone on the tailnet, so it holds no leases. Nothing was run.`,
        'Set this machine to "Only me" in Settings → Workspaces, then start a lease again.',
      );
    }
    // A lease answers first: a host can hold a lease pushed before the reference itself has synced.
    if (leases) {
      await leases.ready();
      if (leases.has(project, name)) return leases.read(project, name);
    }
    if (this.referenceOf(project, name)) {
      if (leases) return leases.read(project, name);
      throw secretNotFound(project, name);
    }
    if (!this.has(project, name)) throw secretNotFound(project, name);
    const key = paneSecretKey(project, name);
    try {
      return await this.values.read(key);
    } catch (error) {
      throw new PaneError(
        'SECRET_UNREADABLE',
        `Pane could not read ${key} on this machine: ${reasonOf(error)}.`,
        this.values.storage().kind === 'keychain'
          ? 'Unlock the login keychain in Keychain Access, or set it again with `runpane secrets set`.'
          : 'Set it again with `runpane secrets set`, or from Settings → Secrets.',
      );
    }
  }

  /** The index record of `key` (`<project>/<NAME>`), deletions included; never a value. */
  secretRecord(key: string): PaneSecretMeta | undefined {
    return this.index()[key];
  }

  /** What "Choose what to send" keeps off cloud Sessions, as this host last heard it. */
  cloudChoice(): PaneCloudSecretChoice {
    const meta = this.config.getConfig().paneCloudSecretChoice;
    return meta ? { excludedSecrets: [...meta.excludedSecrets], excludedMachines: [...meta.excludedMachines] } : EMPTY_PANE_CLOUD_SECRET_CHOICE;
  }

  /** The person's new choice, stamped here and now so it wins on every computer and cloud VM it reaches. */
  async setCloudChoice(choice: PaneCloudSecretChoice): Promise<void> {
    return this.serial(async () => {
      const meta: PaneCloudSecretChoiceMeta = { excludedSecrets: [...choice.excludedSecrets], excludedMachines: [...choice.excludedMachines], updatedAt: this.now().toISOString(), source: this.hostLabel() };
      await this.config.updateConfigWith(() => ({ paneCloudSecretChoice: meta }));
      this.onLocalChange();
    });
  }

  /** The choice for the other hosts and cloud VMs: names only. */
  exportCloudChoiceForSync(): SharedCredential | undefined {
    const meta = this.config.getConfig().paneCloudSecretChoice;
    if (!meta) return undefined;
    return { value: JSON.stringify({ excludedSecrets: meta.excludedSecrets, excludedMachines: meta.excludedMachines }), updatedAt: meta.updatedAt, source: meta.source };
  }

  /** Saves a choice newer than this host's. Returns whether it changed. */
  async applyCloudChoiceFromSync(record: SharedCredential): Promise<boolean> {
    return this.serial(async () => {
      if (record.value === null || !isNewer(record, this.config.getConfig().paneCloudSecretChoice)) return false;
      // A stamp from the future would win every later change; no real host's clock is that far ahead.
      if (Date.parse(record.updatedAt) > this.now().getTime() + MAX_CLOCK_AHEAD_MS) return false;
      const choice = parseCloudChoice(record);
      if (!choice) return false;
      await this.config.updateConfigWith(() => ({ paneCloudSecretChoice: { ...choice, updatedAt: record.updatedAt, source: record.source } }));
      return true;
    });
  }

  /**
   * On a cloud VM: removes every secret the choice keeps off cloud Sessions, its value and its record,
   * leaving no deletion behind, so it arrives again once the person turns it back on. A value that
   * can't be removed keeps its record, so the next sync tries again. Returns the keys removed.
   */
  async forgetExcluded(): Promise<string[]> {
    return this.serial(async () => {
      const choice = this.cloudChoice();
      const removed: string[] = [];
      for (const [key, meta] of Object.entries(this.index())) {
        if (meta.deleted || sendsToCloud(choice, key, meta.source)) continue;
        try {
          await this.values.remove(key);
        } catch (error) {
          console.warn(`[PaneSecrets] Could not remove ${key}, which is now kept off cloud Sessions: ${reasonOf(error)}`);
          continue;
        }
        this.known.delete(key);
        removed.push(key);
      }
      if (removed.length > 0) {
        await this.config.updateConfigWith((config) => ({ paneSecrets: Object.fromEntries(Object.entries(config.paneSecrets ?? {}).filter(([key]) => !removed.includes(key))) }));
      }
      return removed;
    });
  }

  /** References and their removals, for the other hosts. Addresses only: a reference carries no value. */
  exportReferencesForSync() {
    const records: Record<string, SharedCredential> = {};
    for (const [key, meta] of Object.entries(this.referenceIndex())) {
      if (!parsePaneSecretKey(key)) continue;
      records[key] = { value: meta.deleted ? null : meta.reference ?? null, updatedAt: meta.updatedAt, source: meta.source };
    }
    return records;
  }

  /** Saves each reference newer than this host's copy. Returns the keys that changed. */
  async applyReferencesFromSync(incoming: Record<string, SharedCredential>): Promise<string[]> {
    return this.serial(async () => {
      const current = this.referenceIndex();
      const applied: Record<string, PaneSecretReferenceMeta> = {};
      for (const [key, record] of Object.entries(incoming)) {
        if (!parsePaneSecretKey(key) || !isNewer(record, current[key])) continue;
        if (record.value !== null && paneSecretReferenceProblem(record.value)) continue;
        // A stamp from the future would win every later edit; no real host's clock is that far ahead.
        if (Date.parse(record.updatedAt) > this.now().getTime() + MAX_CLOCK_AHEAD_MS) continue;
        applied[key] = record.value === null
          ? { updatedAt: record.updatedAt, source: record.source, deleted: true }
          : { updatedAt: record.updatedAt, source: record.source, reference: record.value };
      }
      const changed = Object.keys(applied);
      if (changed.length > 0) {
        await this.config.updateConfigWith((config) => ({ paneSecretReferences: { ...config.paneSecretReferences, ...applied } }));
      }
      return changed;
    });
  }

  /** Every live record with its value, and every deletion, for the other hosts. Unreadable values are left out. */
  async exportForSync(): Promise<Record<string, SharedCredential>> {
    const records: Record<string, SharedCredential> = {};
    await Promise.all(Object.entries(this.index()).map(async ([key, meta]) => {
      if (!parsePaneSecretKey(key)) return;
      if (meta.deleted) {
        records[key] = { value: null, updatedAt: meta.updatedAt, source: meta.source };
        return;
      }
      try {
        const known = this.known.get(key);
        const value = known?.updatedAt === meta.updatedAt ? known.value : await this.values.read(key);
        this.known.set(key, { updatedAt: meta.updatedAt, value });
        records[key] = { value, updatedAt: meta.updatedAt, source: meta.source };
      } catch (error) {
        console.warn(`[PaneSecrets] Not sharing ${key}: its value could not be read (${reasonOf(error)})`);
      }
    }));
    return records;
  }

  /** Save each record newer than this host's copy. Returns the keys that changed. */
  async applyFromSync(incoming: Record<string, SharedCredential>): Promise<string[]> {
    return this.serial(async () => {
      const current = this.index();
      const applied: Record<string, PaneSecretMeta> = {};
      for (const [key, record] of Object.entries(incoming)) {
        if (!parsePaneSecretKey(key) || !isNewer(record, current[key])) continue;
        try {
          if (record.value === null) await this.values.remove(key).catch(() => undefined);
          else await this.values.write(key, record.value);
        } catch (error) {
          console.warn(`[PaneSecrets] Could not save ${key} from ${record.source}: ${reasonOf(error)}`);
          continue;
        }
        if (record.value === null) this.known.delete(key);
        else this.known.set(key, { updatedAt: record.updatedAt, value: record.value });
        applied[key] = record.value === null
          ? { updatedAt: record.updatedAt, source: record.source, deleted: true }
          : { updatedAt: record.updatedAt, source: record.source };
      }
      const changed = Object.keys(applied);
      if (changed.length > 0) {
        await this.config.updateConfigWith((config) => ({ paneSecrets: { ...config.paneSecrets, ...applied } }));
      }
      return changed;
    });
  }
}

let shared: PaneSecretStore | null = null;
let sharedValues: SecretValueBackend | null = null;
let sharedLeases: SecretLeaseStore | null = null;

/** One value store per host, so secrets and leases share its write queue. */
function hostValueBackend(): SecretValueBackend {
  sharedValues ??= paneSecretValueBackend(getAppDirectory());
  return sharedValues;
}

/** This host's leases, built on first use. Its first read deletes any that expired while Pane was closed. */
export function secretLeaseStore(): SecretLeaseStore {
  // On a cloud VM the lease records and log name secrets, so they live on the secrets volume too.
  const volume = secretsVolume();
  sharedLeases ??= new SecretLeaseStore({
    directory: volume ?? getAppDirectory(),
    values: hostValueBackend(),
    onChange: () => getPaneEventSink().send('pane-secrets:changed'),
  });
  return sharedLeases;
}

/** This host's secret store, built on first use from the runtime config and data directory. */
export function paneSecretStore(): PaneSecretStore {
  if (!shared) {
    // A connected desktop syncs when its hosts report a settings change, as they do for shared keys.
    const config = getRuntimeConfigManager();
    const volume = secretsVolume();
    const index = volume === undefined ? config : volumeSecretIndex(volume, () => config.getConfig());
    shared = new PaneSecretStore(index, hostValueBackend(), localHostLabel, () => new Date(), () => {
      getPaneEventSink().send('remote:settings-changed');
    }, secretLeaseStore);
  }
  return shared;
}

export { localHostLabel };
