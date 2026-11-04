import { safeStorage as electronSafeStorage } from 'electron';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { PaneError, reasonOf } from '../../../shared/paneError';
import { boundary, decodeBoundary } from '../../../shared/validation/boundaryDecoder';
import {
  paneSecretKey,
  paneSecretNameProblem,
  paneSecretProjectProblem,
  parsePaneSecretKey,
  type PaneSecretStorage,
  type PaneSecretSummary,
} from '../../../shared/types/paneSecrets';
import type { SharedCredential } from '../../../shared/types/sharedCredentials';
import type { AppConfig } from '../types/config';
import type { ConfigManager } from './configManager';
import { getRuntimeConfigManager } from '../core/runtime';
import { getAppDirectory } from '../utils/appDirectory';
import { paneKeychainService, systemKeychain, type Keychain } from './keychain';

/** Index record for one secret, kept in config.json. Never holds the value. */
export interface PaneSecretMeta {
  updatedAt: string;
  /** Host where it was last set or deleted. */
  source: string;
  /** Present when the secret was deleted, so an older copy on another host cannot bring it back. */
  deleted?: true;
}

/** Where values live: the macOS keychain, or one 0600 file elsewhere. Addressed by `<project>/<NAME>`. */
export interface SecretValueBackend {
  storage(): PaneSecretStorage;
  read(key: string): Promise<string>;
  write(key: string, value: string): Promise<void>;
  remove(key: string): Promise<void>;
}

/** Encryption for the file backend; Electron's safeStorage in the app. */
export interface SecretEncryption {
  available(): boolean;
  encrypt(text: string): Buffer;
  decrypt(data: Buffer): string;
}

const MAX_VALUE_BYTES = 64 * 1024;

function localHostLabel(): string {
  return os.hostname().replace(/\.local$/i, '');
}

/** Values in the login keychain under Pane's per-data-dir service, account `secret:<project>/<NAME>`. */
export function keychainSecretBackend(keychain: Keychain, service: string): SecretValueBackend {
  const account = (key: string) => `secret:${key}`;
  return {
    storage: () => ({ kind: 'keychain', encrypted: true }),
    read: key => keychain.read(service, account(key)),
    write: (key, value) => keychain.write(service, account(key), value),
    remove: key => keychain.remove(service, account(key)),
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
      return entry.encrypted ? encryption.decrypt(Buffer.from(entry.data, 'base64')) : entry.data;
    }),
    write: (key, value) => serial(async () => {
      const file = await load();
      const encrypted = encryption.available();
      file.values[key] = { encrypted, data: encrypted ? encryption.encrypt(value).toString('base64') : value };
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

/** Electron's safeStorage, or no encryption outside Electron. Linux's `basic_text` backend counts as none. */
export function electronSecretEncryption(): SecretEncryption {
  type SafeStorage = Electron.SafeStorage;
  const safeStorage: SafeStorage | null = electronSafeStorage ?? null;
  const available = () => {
    if (!safeStorage?.isEncryptionAvailable()) return false;
    return process.platform !== 'linux' || safeStorage.getSelectedStorageBackend() !== 'basic_text';
  };
  return {
    available,
    encrypt: text => {
      if (!safeStorage) throw new Error('Encryption is not available');
      return safeStorage.encryptString(text);
    },
    decrypt: data => {
      if (!safeStorage) throw new Error('Encryption is not available');
      return safeStorage.decryptString(data);
    },
  };
}

/** The value store for this host: the keychain on macOS, the file elsewhere. */
export function systemSecretBackend(appDirectory: string, platform: string = process.platform): SecretValueBackend {
  if (platform === 'darwin') return keychainSecretBackend(systemKeychain(platform), paneKeychainService(appDirectory));
  return fileSecretBackend(path.join(appDirectory, 'secrets.json'), electronSecretEncryption());
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

type SecretConfig = Pick<ConfigManager, 'getConfig' | 'updateConfigWith'>;

function isNewer(candidate: SharedCredential, current: PaneSecretMeta | undefined): boolean {
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

  constructor(
    private readonly config: SecretConfig,
    private readonly values: SecretValueBackend,
    private readonly hostLabel: () => string = localHostLabel,
    private readonly now: () => Date = () => new Date(),
  ) {}

  storage(): PaneSecretStorage {
    return this.values.storage();
  }

  private index(): Record<string, PaneSecretMeta> {
    return this.config.getConfig().paneSecrets ?? {};
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

  has(project: string, name: string): boolean {
    const meta = this.index()[paneSecretKey(project, name)];
    return Boolean(meta && !meta.deleted);
  }

  /** Store `value` under `project/name`, replacing any saved value. */
  async set(project: string, name: string, value: string): Promise<{ replaced: boolean; secret: PaneSecretSummary }> {
    validatePaneSecretAddress(project, name);
    if (!value) throw invalidSecret('A secret value cannot be empty.');
    if (Buffer.byteLength(value, 'utf8') > MAX_VALUE_BYTES) throw invalidSecret('A secret value can be at most 64 KiB.');
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
      return { replaced, secret: { project, name, updatedAt: meta.updatedAt, machine: meta.source } };
    });
  }

  /** Delete `project/name` here; the deletion reaches other hosts on the next sync. */
  async delete(project: string, name: string): Promise<void> {
    validatePaneSecretAddress(project, name);
    return this.serial(async () => {
      if (!this.has(project, name)) throw secretNotFound(project, name);
      const key = paneSecretKey(project, name);
      const meta: PaneSecretMeta = { updatedAt: this.now().toISOString(), source: this.hostLabel(), deleted: true };
      await this.config.updateConfigWith(config => ({ paneSecrets: { ...config.paneSecrets, [key]: meta } }));
      await this.values.remove(key).catch(error => {
        console.warn(`[PaneSecrets] Could not remove the stored value of ${key}: ${reasonOf(error)}`);
      });
    });
  }

  /** The value of `project/name`. Throws SECRET_NOT_FOUND or SECRET_UNREADABLE, never with the value. */
  async read(project: string, name: string): Promise<string> {
    validatePaneSecretAddress(project, name);
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
        records[key] = { value: await this.values.read(key), updatedAt: meta.updatedAt, source: meta.source };
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
        applied[key] = record.value === null
          ? { updatedAt: record.updatedAt, source: record.source, deleted: true }
          : { updatedAt: record.updatedAt, source: record.source };
      }
      const changed = Object.keys(applied);
      if (changed.length > 0) {
        await this.config.updateConfigWith((config: AppConfig) => ({ paneSecrets: { ...config.paneSecrets, ...applied } }));
      }
      return changed;
    });
  }
}

let shared: PaneSecretStore | null = null;

/** This host's secret store, built on first use from the runtime config and data directory. */
export function paneSecretStore(): PaneSecretStore {
  if (!shared) {
    shared = new PaneSecretStore(getRuntimeConfigManager(), systemSecretBackend(getAppDirectory()));
  }
  return shared;
}
