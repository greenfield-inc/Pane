/**
 * Pane secrets: named values any agent on the person's hosts can use through
 * `runpane secrets exec`, addressed as `<project>/<NAME>`. Every saved host keeps
 * a copy; values live only in the host's OS store, never in config.json.
 */
import { PaneError } from '../paneError';
import { projectEnvKeyProblem } from './projectEnvVars';

/** A secret as lists show it. Never carries a value. */
export interface PaneSecretSummary {
  project: string;
  name: string;
  /** ISO time it was last set, on the host where that happened. */
  updatedAt: string;
  /** Name of the host where it was last set. */
  machine: string;
}

/** Where this host keeps secret values. */
export interface PaneSecretStorage {
  kind: 'keychain' | 'file';
  /** False only for the file store on a host without an OS keyring: values sit in a 0600 file as plain text. */
  encrypted: boolean;
}

const PROJECT_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;

/** Why `project` cannot name a secret project, or null when it can. */
export function paneSecretProjectProblem(project: string): string | null {
  if (!project) return 'A secret needs a project.';
  if (!PROJECT_PATTERN.test(project)) return `"${project}" is not a valid secret project: use up to 64 letters, digits, ".", "_" or "-".`;
  return null;
}

/** Why `name` cannot name a secret, or null when it can. Secrets follow environment-variable rules so `exec` injects them as-is. */
export function paneSecretNameProblem(name: string): string | null {
  return projectEnvKeyProblem(name);
}

/** The address `<project>/<NAME>`, used as the sync and index key. */
export function paneSecretKey(project: string, name: string): string {
  return `${project}/${name}`;
}

export function parsePaneSecretKey(key: string): { project: string; name: string } | null {
  const slash = key.indexOf('/');
  if (slash <= 0) return null;
  const project = key.slice(0, slash);
  const name = key.slice(slash + 1);
  return paneSecretProjectProblem(project) || paneSecretNameProblem(name) ? null : { project, name };
}

/** Pane secrets are the owner's: a teammate a workspace lets in can use the computer, but not them. */
export function teammateSecretRefusal(teammate: string, action: string): PaneError {
  return new PaneError(
    'SECRET_OWNER_REQUIRED',
    `Only this computer's owner can use its Pane secrets, so ${teammate} cannot ${action}. Nothing was read or changed.`,
    'Ask the owner to do it on their own devices.',
  );
}

/** Where a secret's value comes from: typed into Pane, or read from 1Password into a lease. */
export type PaneSecretSource = 'typed' | '1password';

/** A secret whose value lives in 1Password, as lists show it. The reference is an address, not a value. */
export interface PaneSecretReferenceSummary {
  project: string;
  name: string;
  /** `op://<vault>/<item>/<field>` */
  reference: string;
  updatedAt: string;
  machine: string;
}

/** What a lease log line records. */
export type SecretLeaseEvent = 'granted' | 'renewed' | 'ended' | 'expired' | 'swept';

/** A lease as lists show it: names and times, never values. */
export interface SecretLeaseSummary {
  id: string;
  project: string;
  names: string[];
  grantedAt: string;
  expiresAt: string;
  requestedBy: string;
  /** The machine that read 1Password and granted it. */
  grantedOn: string;
  /** Held in memory only (this machine cannot encrypt at rest): it ends if Pane restarts here. */
  memoryOnly: boolean;
}

/** Lease length bounds and default, per project. */
export const SECRET_LEASE_DEFAULT_MS = 24 * 60 * 60 * 1000;
export const SECRET_LEASE_MIN_MS = 60 * 60 * 1000;
export const SECRET_LEASE_MAX_MS = 7 * 24 * 60 * 60 * 1000;
/** How long before expiry the desktop tries to renew, and shows the reminder card when it cannot. */
export const SECRET_LEASE_REMINDER_MS = 60 * 60 * 1000;

/** The command an agent runs to ask for a lease again. */
export function secretLeaseRenewCommand(project: string, names: readonly string[]): string {
  return `runpane secrets lease --project ${project} ${names.join(' ')}`;
}

/** op://vault/item/field or op://vault/item/section/field, with an optional ?attribute=…; names may hold spaces. */
const ONE_PASSWORD_REFERENCE = /^op:\/\/[^/?{}\n]+\/[^/?{}\n]+(\/[^/?{}\n]+)?\/[^/?{}\n]+(\?[^{}\s]*)?$/;

/** Why `reference` is not a 1Password secret reference, or null when it is. */
export function paneSecretReferenceProblem(reference: string): string | null {
  if (reference !== reference.trim() || !ONE_PASSWORD_REFERENCE.test(reference)) {
    return 'A 1Password reference looks like op://vault/item/field. In 1Password, open the item, then choose Copy Secret Reference on the field.';
  }
  return null;
}

/** A machine a lease can be pushed to, as Settings → Secrets shows it. */
export interface SecretLeaseMachine {
  /** `local` for this desktop, else the saved machine's connection id. */
  id: string;
  name: string;
  online: boolean;
  /**
   * Why a lease can't go there, or null when it can: "Everyone on tailnet" sharing, a Pane too old
   * for leases, or offline. Known once the machine answers; null until then.
   */
  refusal: string | null;
  /** The machine can't encrypt at rest, so a lease there is held in memory and ends if Pane restarts there. */
  memoryOnly: boolean;
}

/** A lease as the desktop sees it on one machine. */
export interface SecretLeaseOnMachine extends SecretLeaseSummary {
  machineId: string;
  machine: string;
}

/** Everything Settings → Secrets shows. Never carries a value. */
export interface PaneSecretsOverview {
  secrets: PaneSecretSummary[];
  references: PaneSecretReferenceSummary[];
  storage: PaneSecretStorage;
  /** Live leases on this desktop and on each machine that answered, ending soonest first. */
  leases: SecretLeaseOnMachine[];
  machines: SecretLeaseMachine[];
  /** Lease length per project in ms; projects not listed use SECRET_LEASE_DEFAULT_MS. */
  leaseLengths: Record<string, number>;
  /** The vault "Move to 1Password" writes into, or null until the person picks one. */
  moveVault: string | null;
}

/** Settings → Secrets "Start lease". */
export interface SecretLeaseStartRequest {
  project: string;
  names: string[];
  /** Machine ids from {@link SecretLeaseMachine}; `local` is this desktop. */
  machines: string[];
}

/** What starting a lease did, per machine. */
export interface SecretLeaseStartResult {
  leaseId: string;
  expiresAt: string;
  /** Names of the machines that hold it now. */
  machines: string[];
  /** Machines that refused or could not be reached, each with why. Nothing was sent to them. */
  refused: Array<{ machine: string; reason: string }>;
}
