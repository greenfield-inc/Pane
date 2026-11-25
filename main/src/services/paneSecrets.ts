import { safeStorage as electronSafeStorage } from 'electron';
import { randomBytes } from 'crypto';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { PaneError, reasonOf } from '../../../shared/paneError';
import { boundary, decodeBoundary } from '../../../shared/validation/boundaryDecoder';
import {
  loginSitesProblem,
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
import type { ConfigManager } from './configManager';
import { getPaneEventSink, getRuntimeConfigManager } from '../core/runtime';
import { getAppDirectory } from '../utils/appDirectory';
import { decodeLogin, encodeLogin, LoginUseLog, secretIsLogin, type StoredLogin } from './paneLogins';
import { KeychainItemMissing, paneKeychainService, systemKeychain, type Keychain } from './keychain';

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
  /** Present on a login: the origins it may be filled on. */
  sites?: string[];
}

/** Index record for a typed login, kept in config.json under `paneLogins`. */
export interface PaneLoginMeta extends PaneSecretMeta {
  sites?: string[];
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
 * A reference read back from config.json passes the same check as one the person set: an edited
 * file can't point a name at text op would expand (a `$`, braces) or that isn't a reference at all.
 */
function usableReference(reference: string | undefined): reference is string {
  return reference !== undefined && paneSecretReferenceProblem(reference) === null;
}

/** Where a typed login's value is kept. No project has a colon, so it never meets a plain secret's. */
const loginValueKey = (key: string) => `login:${key}`;

/** Sites read back from config.json or a sync, when they are ones a login can have. */
function usableSites(sites: readonly string[] | undefined): string[] | null {
  return sites && loginSitesProblem(sites) === null ? [...sites] : null;
}

/** How a login reference syncs: its address, then one site a line. A host from before logins reads no reference in it. */
function encodeReference(reference: string, sites: readonly string[] | undefined): string {
  return [reference, ...(sites ?? [])].join('\n');
}

function decodeReference(text: string): { reference: string; sites?: string[] } | null {
  const [reference, ...sites] = text.split('\n');
  if (paneSecretReferenceProblem(reference)) return null;
  if (sites.length === 0) return { reference };
  return loginSitesProblem(sites) ? null : { reference, sites };
}

function checkedSites(sites: readonly string[]): string[] {
  const unique = [...new Set(sites)];
  const problem = loginSitesProblem(unique);
  if (problem) throw invalidSecret(problem);
  return unique;
}

function secretNotLogin(project: string, name: string): PaneError {
  return new PaneError(
    'SECRET_NOT_LOGIN',
    `${paneSecretKey(project, name)} is not a login: the person has not chosen a site for it, so it can't be filled in a page. Nothing was filled.`,
    'Ask the person to open Settings → Secrets and choose Use as a login on it. Agents can\'t do that.',
  );
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

function checkValue(value: string): void {
  if (!value) throw invalidSecret('A secret value cannot be empty.');
  if (Buffer.byteLength(value, 'utf8') > MAX_VALUE_BYTES) throw invalidSecret('A secret value can be at most 64 KiB.');
}

function secretIsReference(project: string, name: string): PaneError {
  return new PaneError(
    'SECRET_IS_REFERENCE',
    `${paneSecretKey(project, name)} comes from 1Password, so Pane does not store a value for it. Nothing was changed.`,
    `Run \`${secretLeaseRenewCommand(project, [name])}\` to use it, or remove the reference in Settings → Secrets first.`,
  );
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
  /** Values by key and `updatedAt`, so a sync reads the OS store only for a changed secret. */
  private readonly known = new Map<string, { updatedAt: string; value: string }>();

  constructor(
    private readonly config: SecretConfig,
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
      const sites = usableSites(meta.sites);
      const summary: PaneSecretReferenceSummary = { ...address, reference: meta.reference, updatedAt: meta.updatedAt, machine: meta.source };
      return [sites ? { ...summary, sites } : summary];
    }).sort((a, b) => a.project.localeCompare(b.project) || a.name.localeCompare(b.name));
  }

  /**
   * Points `project/name` at a 1Password item. Only the person does this, from Settings. A typed
   * secret of the same name is deleted here and, through sync, on every host: that is "Move to 1Password".
   */
  async setReference(project: string, name: string, reference: string, sites?: readonly string[]): Promise<{ replacedTyped: boolean }> {
    validatePaneSecretAddress(project, name);
    const problem = paneSecretReferenceProblem(reference);
    if (problem) throw invalidSecret(problem);
    // A login stays one when its value moves to 1Password or its reference changes.
    const chosen = sites ? checkedSites(sites) : this.sitesOf(project, name);
    const replacedTyped = this.has(project, name) && !this.referenceOf(project, name);
    if (replacedTyped) await this.delete(project, name);
    return this.serial(async () => {
      const key = paneSecretKey(project, name);
      const meta: PaneSecretReferenceMeta = { updatedAt: this.now().toISOString(), source: this.hostLabel(), reference };
      if (chosen) meta.sites = chosen;
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

  private loginIndex(): Record<string, PaneLoginMeta> {
    return this.config.getConfig().paneLogins ?? {};
  }

  /** A typed login's sites as the person last set them, or null when it is not a typed login. */
  private typedLoginSites(key: string): string[] | null {
    const meta = this.loginIndex()[key];
    return meta && !meta.deleted ? usableSites(meta.sites) : null;
  }

  /** The sites of a login, typed or from 1Password; null when `project/name` is not a login here. */
  sitesOf(project: string, name: string): string[] | null {
    const key = paneSecretKey(project, name);
    const reference = this.referenceIndex()[key];
    if (reference && !reference.deleted && usableReference(reference.reference)) return usableSites(reference.sites);
    return this.typedLoginSites(key);
  }

  /**
   * Makes `project/name` a login for exactly `sites`, or changes a login's sites. Only the person does
   * this, from Settings. A plain secret moves: its copies are deleted here and, through sync, on every
   * host, so no command gets it any more. A reference takes the sites with its next lease.
   */
  async setSites(project: string, name: string, sites: readonly string[]): Promise<void> {
    validatePaneSecretAddress(project, name);
    const reference = this.referenceOf(project, name);
    if (reference) {
      await this.setReference(project, name, reference, sites);
      return;
    }
    const key = paneSecretKey(project, name);
    const typed = this.typedLoginSites(key) !== null;
    const value = typed ? (await this.readTypedLogin(project, name)).value : await this.read(project, name);
    await this.setLogin(project, name, value, sites);
  }

  /** Saves a typed login, replacing any plain secret of that name. Only the person does this. */
  async setLogin(project: string, name: string, value: string, sites: readonly string[]): Promise<void> {
    const chosen = this.checkedLogin(project, name, value, sites);
    await this.writeLogin(project, name, value, chosen);
    if (this.hasPlain(paneSecretKey(project, name))) await this.deletePlain(project, name);
  }

  private checkedLogin(project: string, name: string, value: string, sites: readonly string[]): string[] {
    validatePaneSecretAddress(project, name);
    if (this.referenceOf(project, name)) throw secretIsReference(project, name);
    checkValue(value);
    return checkedSites(sites);
  }

  private writeLogin(project: string, name: string, value: string, sites: string[]): Promise<void> {
    return this.serial(async () => {
      const key = paneSecretKey(project, name);
      try {
        await this.values.write(loginValueKey(key), encodeLogin({ sites, value }));
      } catch (error) {
        throw this.writeFailed(key, reasonOf(error));
      }
      const meta: PaneLoginMeta = { updatedAt: this.now().toISOString(), source: this.hostLabel(), sites };
      await this.config.updateConfigWith(config => ({ paneLogins: { ...config.paneLogins, [key]: meta } }));
      this.onLocalChange();
    });
  }

  private writeFailed(key: string, reason: string): PaneError {
    return new PaneError(
      'SECRET_WRITE_FAILED',
      `Pane could not store ${key}: ${reason}. Nothing was changed.`,
      this.values.storage().kind === 'keychain'
        ? 'Unlock the login keychain in Keychain Access, then try again.'
        : 'Check that Pane can write to its data directory, then try again.',
    );
  }

  private async readTypedLogin(project: string, name: string): Promise<StoredLogin> {
    const key = paneSecretKey(project, name);
    const login = decodeLogin(await this.values.read(loginValueKey(key)).catch(error => {
      throw new PaneError(
        'SECRET_UNREADABLE',
        `Pane could not read ${key} on this machine: ${reasonOf(error)}. Nothing was filled.`,
        this.values.storage().kind === 'keychain' ? 'Unlock the login keychain in Keychain Access, then try again.' : 'Ask the person to save the login again in Settings → Secrets.',
      );
    }));
    if (!login) throw new PaneError('SECRET_UNREADABLE', `Pane could not read ${key} on this machine: its stored login is malformed. Nothing was filled.`, 'Ask the person to save the login again in Settings → Secrets.');
    return login;
  }

  /**
   * A login's value and the sites it may be filled on: those its stored value carries and the person's
   * list both name. The stored value decides, so editing config.json or a lease record widens nothing.
   * A login from 1Password needs a live lease, exactly as `read` does.
   */
  async readLogin(project: string, name: string): Promise<StoredLogin> {
    validatePaneSecretAddress(project, name);
    const listed = this.sitesOf(project, name);
    const leases = this.leases();
    await leases?.ready();
    const key = paneSecretKey(project, name);
    // A lease can arrive before its reference has synced, but never outlives one the person removed or replaced.
    const replaced = !this.referenceOf(project, name) && (this.referenceIndex()[key]?.deleted === true || this.typedLoginSites(key) !== null);
    if (!replaced && (leases?.has(project, name) || this.referenceOf(project, name))) {
      this.refuseSharedLease(project, name);
      if (!listed && this.referenceOf(project, name)) throw secretNotLogin(project, name);
      const leased = leases ? await leases.readLogin(project, name) : null;
      if (!leased) throw listed ? this.staleLease(project, name) : secretNotLogin(project, name);
      const sites = listed ? leased.sites.filter(site => listed.includes(site)) : leased.sites;
      return { value: leased.value, sites };
    }
    if (!listed) throw this.has(project, name) ? secretNotLogin(project, name) : secretNotFound(project, name);
    const login = await this.readTypedLogin(project, name);
    return { value: login.value, sites: login.sites.filter(site => listed.includes(site)) };
  }

  /** A reference became a login while leased: the lease predates the sites. */
  private staleLease(project: string, name: string): PaneError {
    return new PaneError(
      'SECRET_LEASE_ENDED',
      `${paneSecretKey(project, name)} became a login after its lease started, so the lease does not cover it. Nothing was filled.`,
      `Run \`${secretLeaseRenewCommand(project, [name])}\`, and the person approves it on the card.`,
    );
  }

  private serial<T>(work: () => Promise<T>): Promise<T> {
    const run = this.queue.then(work, work);
    this.queue = run.catch(() => undefined);
    return run;
  }

  private hasPlain(key: string): boolean {
    const meta = this.index()[key];
    return Boolean(meta && !meta.deleted);
  }

  /** Live typed secrets and logins, sorted by project then name. A login hides a plain secret of its name. */
  list(project?: string): PaneSecretSummary[] {
    const entries: Array<[string, PaneLoginMeta]> = [
      ...Object.entries(this.index()).filter(([key]) => this.typedLoginSites(key) === null),
      ...Object.entries(this.loginIndex()),
    ];
    return entries.flatMap(([key, meta]) => {
      const address = parsePaneSecretKey(key);
      if (!address || meta.deleted || (project !== undefined && address.project !== project)) return [];
      const summary: PaneSecretSummary = { ...address, updatedAt: meta.updatedAt, machine: meta.source };
      const sites = this.typedLoginSites(key);
      return [sites ? { ...summary, sites } : summary];
    }).sort((a, b) => a.project.localeCompare(b.project) || a.name.localeCompare(b.name));
  }

  /** Whether `project/name` exists here: typed, a login, or as a 1Password reference. */
  has(project: string, name: string): boolean {
    const key = paneSecretKey(project, name);
    return this.hasPlain(key) || this.typedLoginSites(key) !== null || this.referenceOf(project, name) !== null;
  }

  /** The person's own new value for `project/name`: a login keeps its sites, anything else is `set`. */
  async replaceValue(project: string, name: string, value: string): Promise<{ replaced: boolean }> {
    const key = paneSecretKey(project, name);
    const sites = this.referenceOf(project, name) ? null : this.typedLoginSites(key);
    if (!sites) return this.set(project, name, value);
    checkValue(value);
    await this.writeLogin(project, name, value, sites);
    return { replaced: true };
  }

  /** Store `value` under `project/name`, replacing any saved value. Refused for a login, whoever asks. */
  async set(project: string, name: string, value: string): Promise<{ replaced: boolean; secret: PaneSecretSummary }> {
    validatePaneSecretAddress(project, name);
    checkValue(value);
    if (this.referenceOf(project, name)) throw secretIsReference(project, name);
    if (this.sitesOf(project, name)) throw secretIsLogin(project, name);
    return this.serial(async () => {
      const key = paneSecretKey(project, name);
      const replaced = this.has(project, name);
      try {
        await this.values.write(key, value);
      } catch (error) {
        throw this.writeFailed(key, reasonOf(error));
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
    if (!this.has(project, name)) throw secretNotFound(project, name);
    const key = paneSecretKey(project, name);
    const login = this.typedLoginSites(key) !== null;
    // The plain copy too, when one is left under a login's name, so deleting the login never brings it back.
    if (this.hasPlain(key)) await this.deletePlain(project, name);
    if (login) await this.deleteTyped(project, name, 'paneLogins');
  }

  private deletePlain(project: string, name: string): Promise<void> {
    return this.deleteTyped(project, name, 'paneSecrets');
  }

  private async deleteTyped(project: string, name: string, index: 'paneSecrets' | 'paneLogins'): Promise<void> {
    return this.serial(async () => {
      const key = paneSecretKey(project, name);
      // The value first, so a refused removal leaves the secret listed and the delete can be retried.
      try {
        await this.values.remove(index === 'paneLogins' ? loginValueKey(key) : key);
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
      await this.config.updateConfigWith(config => ({ [index]: { ...config[index], [key]: meta } }));
      if (index === 'paneSecrets') this.known.delete(key);
      this.onLocalChange();
    });
  }

  /**
   * The value of `project/name`: typed, or from its live lease when it is a 1Password reference.
   * Throws SECRET_IS_LOGIN, SECRET_NOT_FOUND, SECRET_LEASE_ENDED or SECRET_UNREADABLE, never with the value.
   */
  async read(project: string, name: string): Promise<string> {
    validatePaneSecretAddress(project, name);
    if (this.sitesOf(project, name)) throw secretIsLogin(project, name);
    const leases = this.leases();
    this.refuseSharedLease(project, name);
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

  private refuseSharedLease(project: string, name: string): void {
    if (this.config.getConfig().workspaces?.visibility !== 'tailnet') return;
    if (!this.leases()?.has(project, name) && !this.referenceOf(project, name)) return;
    throw new PaneError(
      'SECRET_LEASE_REFUSED',
      `${paneSecretKey(project, name)} comes from 1Password, and this machine is shared with everyone on the tailnet, so it holds no leases. Nothing was run.`,
      'Set this machine to "Only me" in Settings → Workspaces, then start a lease again.',
    );
  }

  /** References and their removals, for the other hosts. Addresses only: a reference carries no value. */
  exportReferencesForSync() {
    const records: Record<string, SharedCredential> = {};
    for (const [key, meta] of Object.entries(this.referenceIndex())) {
      if (!parsePaneSecretKey(key)) continue;
      records[key] = { value: meta.deleted || !meta.reference ? null : encodeReference(meta.reference, meta.sites), updatedAt: meta.updatedAt, source: meta.source };
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
        const reference = record.value === null ? null : decodeReference(record.value);
        if (record.value !== null && !reference) continue;
        // A stamp from the future would win every later edit; no real host's clock is that far ahead.
        if (Date.parse(record.updatedAt) > this.now().getTime() + MAX_CLOCK_AHEAD_MS) continue;
        applied[key] = reference
          ? { updatedAt: record.updatedAt, source: record.source, ...reference }
          : { updatedAt: record.updatedAt, source: record.source, deleted: true };
      }
      const changed = Object.keys(applied);
      if (changed.length > 0) {
        await this.config.updateConfigWith((config: AppConfig) => ({ paneSecretReferences: { ...config.paneSecretReferences, ...applied } }));
      }
      return changed;
    });
  }

  /** Typed logins, each with its sites and value together, and their deletions. Only a login whose stored sites match its list syncs. */
  async exportLoginsForSync(): Promise<Record<string, SharedCredential>> {
    const records: Record<string, SharedCredential> = {};
    for (const [key, meta] of Object.entries(this.loginIndex())) {
      const address = parsePaneSecretKey(key);
      if (!address) continue;
      if (meta.deleted) {
        records[key] = { value: null, updatedAt: meta.updatedAt, source: meta.source };
        continue;
      }
      try {
        const login = await this.readTypedLogin(address.project, address.name);
        if (JSON.stringify(login.sites) !== JSON.stringify(meta.sites)) throw new Error('its sites were edited outside Pane');
        records[key] = { value: encodeLogin(login), updatedAt: meta.updatedAt, source: meta.source };
      } catch (error) {
        console.warn(`[PaneSecrets] Not sharing the login ${key}: ${reasonOf(error)}`);
      }
    }
    return records;
  }

  /** Saves each login newer than this host's copy. Returns the keys that changed. */
  async applyLoginsFromSync(incoming: Record<string, SharedCredential>): Promise<string[]> {
    return this.serial(async () => {
      const current = this.loginIndex();
      const applied: Record<string, PaneLoginMeta> = {};
      for (const [key, record] of Object.entries(incoming)) {
        if (!parsePaneSecretKey(key) || !isNewer(record, current[key])) continue;
        // A stamp from the future would win every later edit; no real host's clock is that far ahead.
        if (Date.parse(record.updatedAt) > this.now().getTime() + MAX_CLOCK_AHEAD_MS) continue;
        const login = record.value === null ? null : decodeLogin(record.value);
        if (record.value !== null && !login) continue;
        try {
          if (login) await this.values.write(loginValueKey(key), encodeLogin(login));
          else await this.values.remove(loginValueKey(key)).catch(() => undefined);
        } catch (error) {
          console.warn(`[PaneSecrets] Could not save the login ${key} from ${record.source}: ${reasonOf(error)}`);
          continue;
        }
        applied[key] = login
          ? { updatedAt: record.updatedAt, source: record.source, sites: login.sites }
          : { updatedAt: record.updatedAt, source: record.source, deleted: true };
      }
      const changed = Object.keys(applied);
      if (changed.length > 0) await this.config.updateConfigWith(config => ({ paneLogins: { ...config.paneLogins, ...applied } }));
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
        await this.config.updateConfigWith((config: AppConfig) => ({ paneSecrets: { ...config.paneSecrets, ...applied } }));
      }
      return changed;
    });
  }
}

let shared: PaneSecretStore | null = null;
let sharedValues: SecretValueBackend | null = null;
let sharedLeases: SecretLeaseStore | null = null;
let sharedUses: LoginUseLog | null = null;

/** This host's record of each time a saved login was filled. */
export function loginUseLog(): LoginUseLog {
  sharedUses ??= new LoginUseLog(getAppDirectory(), () => getPaneEventSink().send('pane-secrets:changed'));
  return sharedUses;
}

/** One value store per host, so secrets and leases share its write queue. */
function hostValueBackend(): SecretValueBackend {
  sharedValues ??= systemSecretBackend(getAppDirectory());
  return sharedValues;
}

/** This host's leases, built on first use. Its first read deletes any that expired while Pane was closed. */
export function secretLeaseStore(): SecretLeaseStore {
  sharedLeases ??= new SecretLeaseStore({
    directory: getAppDirectory(),
    values: hostValueBackend(),
    onChange: () => getPaneEventSink().send('pane-secrets:changed'),
  });
  return sharedLeases;
}

/** This host's secret store, built on first use from the runtime config and data directory. */
export function paneSecretStore(): PaneSecretStore {
  if (!shared) {
    // A connected desktop syncs when its hosts report a settings change, as they do for shared keys.
    shared = new PaneSecretStore(getRuntimeConfigManager(), hostValueBackend(), localHostLabel, () => new Date(), () => {
      getPaneEventSink().send('remote:settings-changed');
    }, secretLeaseStore);
  }
  return shared;
}

export { localHostLabel };
