import type { NotifyCardsOn } from './notify';
import { cloudSecretRecords, EMPTY_PANE_CLOUD_SECRET_CHOICE, parseCloudChoice, sendsToCloud, type PaneCloudSecretChoice } from './paneCloudSecrets';

/** Integration keys a host shares with the other hosts its paired devices reach. */
export const SHARED_CREDENTIAL_IDS = ['anthropicApiKey', 'openaiApiKey', 'deepgramApiKey', 'falApiKey', 'openRouterApiKey', 'apns'] as const;
export type SharedCredentialId = typeof SHARED_CREDENTIAL_IDS[number];

/** One key as a host holds it. `value: null` records that it was cleared, so an older copy cannot bring it back. */
export interface SharedCredential {
  value: string | null;
  /** ISO time the key was last set or cleared, on the host where that happened. */
  updatedAt: string;
  /** Name of the host where it was set or cleared. */
  source: string;
}

export type SharedCredentials = Partial<Record<SharedCredentialId, SharedCredential>> & {
  /** Pane secrets by `<project>/<NAME>`, with the same newest-wins and tombstone rules. Hosts and phones from before secrets drop this field. */
  paneSecrets?: Record<string, SharedCredential>;
  /**
   * 1Password references by `<project>/<NAME>`: `value` is the `op://` address (never a secret value), null once removed.
   * A field of its own, so hosts, desktops and phones from before references drop it whole and never read one as a tombstone.
   */
  paneSecretReferences?: Record<string, SharedCredential>;
  /**
   * What "Choose what to send" keeps off cloud Sessions: `value` is the choice as JSON (names only, never a
   * secret value). One record for all the person's computers and their cloud VMs, so every sender and every
   * VM reads the same choice. Hosts from before it drop the field.
   */
  paneCloudSecretChoice?: SharedCredential;
  /**
   * Set in a host's own answer when it is a Pane Cloud VM (it has a secrets volume). Every device that
   * syncs with it then writes it only the Pane secrets the person's choice allows, and takes from it
   * only Pane secrets the choice allows. Hosts from before it drop the field.
   */
  cloudVm?: true;
};

/** The per-key maps that merge by newest copy. */
const SECRET_MAPS = ['paneSecrets', 'paneSecretReferences'] as const;

/** When and where a host's copy of a key was set; stored next to the key in host config. */
export interface SharedCredentialMeta extends Pick<SharedCredential, 'updatedAt' | 'source'> {
  /** Short hash of the value when it was stamped. A value that no longer matches was edited in config.json by hand. */
  valueDigest?: string;
}

/** Apple push credentials, kept in host config so they can be shared. Env vars on a host override them. */
export interface ApnsCredentialConfig {
  teamId: string;
  keyId: string;
  /** Contents of the `.p8` key file. */
  privateKey: string;
  topic: string;
  environment: 'sandbox' | 'production';
}

/** A key set before sharing existed: any timestamped copy replaces it. */
export const UNTIMED_CREDENTIAL = '1970-01-01T00:00:00.000Z';

/** The newer copy wins; on a tie the current one stays, so two hosts never trade values back and forth. */
function isNewerCredential(candidate: SharedCredential, current: SharedCredential | undefined): boolean {
  return !current || Date.parse(candidate.updatedAt) > Date.parse(current.updatedAt);
}

export interface SharedCredentialMerge {
  credentials: SharedCredentials;
  changed: SharedCredentialId[];
  /** Pane secret and reference keys (`<project>/<NAME>`) that changed, and `paneCloudSecretChoice` when it did. */
  changedSecrets: string[];
}

/** `current` with every newer key from `incoming`, and the ids that changed. */
export function mergeSharedCredentials(current: SharedCredentials, incoming: SharedCredentials): SharedCredentialMerge {
  const credentials = { ...current };
  const changed: SharedCredentialId[] = [];
  for (const id of SHARED_CREDENTIAL_IDS) {
    const candidate = incoming[id];
    if (candidate && isNewerCredential(candidate, credentials[id])) {
      credentials[id] = candidate;
      changed.push(id);
    }
  }
  const changedSecrets: string[] = [];
  for (const field of SECRET_MAPS) {
    const records = incoming[field];
    if (!records) continue;
    const merged = { ...current[field] };
    let changedHere = false;
    for (const [key, candidate] of Object.entries(records)) {
      if (isNewerCredential(candidate, merged[key])) {
        merged[key] = candidate;
        changedSecrets.push(key);
        changedHere = true;
      }
    }
    if (changedHere || current[field]) credentials[field] = merged;
  }
  const choice = incoming.paneCloudSecretChoice;
  if (choice && isNewerCredential(choice, credentials.paneCloudSecretChoice)) {
    credentials.paneCloudSecretChoice = choice;
    changedSecrets.push('paneCloudSecretChoice');
  }
  return { credentials, changed, changedSecrets };
}

/** A host a device can reach with its pairing token. */
export interface SharedCredentialHost {
  read(): Promise<SharedCredentials>;
  apply(credentials: SharedCredentials): Promise<void>;
}

/** What a cloud VM is written from the merged set: the Pane secrets `choice` allows, and the choice itself. */
function forCloudVm(newest: SharedCredentials, choice: PaneCloudSecretChoice): SharedCredentials {
  const written: SharedCredentials = { paneSecrets: cloudSecretRecords(newest.paneSecrets ?? {}, choice) };
  if (newest.paneCloudSecretChoice) written.paneCloudSecretChoice = newest.paneCloudSecretChoice;
  return written;
}

/**
 * What the other hosts take from a cloud VM: its Pane secrets and deletions, less any the choice keeps off
 * cloud machines (a VM never holds those, so a record of one is not the person's), and the choice. A key the
 * other hosts last had from a turned-off machine counts as turned off, whatever source the VM's record names.
 */
function fromCloudVm(read: SharedCredentials, choice: PaneCloudSecretChoice, others: Record<string, SharedCredential>): SharedCredentials {
  const allowed = ([key, record]: [string, SharedCredential]) => {
    const theirs = others[key];
    return sendsToCloud(choice, key, record.source) && !(theirs && choice.excludedMachines.includes(theirs.source));
  };
  const taken: SharedCredentials = { paneSecrets: Object.fromEntries(Object.entries(read.paneSecrets ?? {}).filter(allowed)) };
  if (read.paneCloudSecretChoice) taken.paneCloudSecretChoice = read.paneCloudSecretChoice;
  return taken;
}

/**
 * Reads every reachable host, then writes the newest copy of each key to the
 * hosts that hold an older one. Unreachable hosts and hosts too old to share
 * keys are skipped; they catch up on a later sync. A host that says it is a
 * cloud VM is written, and read, only through the person's newest choice.
 */
export async function syncSharedCredentials(hosts: readonly SharedCredentialHost[]): Promise<{ reached: number; updated: number }> {
  const reads = await Promise.all(hosts.map(host => host.read().then(credentials => ({ host, credentials }), () => null)));
  const reached = reads.filter(read => read !== null);
  // The choice first, from every host, so what a cloud VM gives and gets is judged by the newest one.
  const choiceRecord = reached.reduce<SharedCredentials>((merged, read) => mergeSharedCredentials(merged, { paneCloudSecretChoice: read.credentials.paneCloudSecretChoice }).credentials, {}).paneCloudSecretChoice;
  const choice = parseCloudChoice(choiceRecord) ?? EMPTY_PANE_CLOUD_SECRET_CHOICE;
  const others = reached.filter(read => !read.credentials.cloudVm)
    .reduce<SharedCredentials>((merged, read) => mergeSharedCredentials(merged, { paneSecrets: read.credentials.paneSecrets }).credentials, {}).paneSecrets ?? {};
  const taken = (read: { credentials: SharedCredentials }) => (read.credentials.cloudVm ? fromCloudVm(read.credentials, choice, others) : read.credentials);
  const newest = reached.reduce<SharedCredentials>((merged, read) => mergeSharedCredentials(merged, taken(read)).credentials, {});
  const written = (read: { credentials: SharedCredentials }) => (read.credentials.cloudVm ? forCloudVm(newest, choice) : newest);
  const behind = reached.filter(read => {
    const merge = mergeSharedCredentials(read.credentials, written(read));
    return merge.changed.length + merge.changedSecrets.length > 0;
  });
  const applied = await Promise.all(behind.map(read => read.host.apply(written(read)).then(() => true, () => false)));
  return { reached: reached.length, updated: applied.filter(Boolean).length };
}

/**
 * The Approvals on/off switch, "Show cards on" and the machine health Notifications switch, as a host holds them. They travel on their own
 * commands, not with the keys: a phone relays keys and has no business relaying these, and a host
 * too old for them refuses the commands instead of silently dropping them.
 */
export interface SharedNotifySwitch {
  enabled: boolean;
  /** Epoch ms of the last change, on the host where the person made it. 0: never changed since sharing began. */
  changedAt: number;
  /** The machine where cards pop up and chime; null: whichever computer is in use. Hosts from before it omit it. */
  cardsOn?: NotifyCardsOn | null;
  /** Epoch ms `cardsOn` last changed, on the host where the person changed it; 0 if never. Hosts from before it omit it. */
  cardsOnChangedAt?: number;
  /** Settings › Machine health › Cards and notifications; a host from before it omits it. */
  healthNotifications?: boolean;
  /** Epoch ms `healthNotifications` last changed, on the host where the person changed it; 0 if never. Hosts from before it omit it. */
  healthNotificationsChangedAt?: number;
}

/**
 * The later change wins. Equal times settle on off: only a value stored before sharing existed
 * has no time, and an off there was somebody's choice, while most on values are just the default.
 * The rule looks only at the values, so every host picks the same one whatever order it reads them in.
 */
function isNewerNotifySwitch(candidate: SharedNotifySwitch, current: SharedNotifySwitch): boolean {
  if (candidate.changedAt !== current.changedAt) return candidate.changedAt > current.changedAt;
  return !candidate.enabled && current.enabled;
}

/**
 * The later "Show cards on" wins, on its own time, so a host that reports none (one from before it)
 * never clears a pick. Equal times settle on the smaller id, "whichever computer is in use" first,
 * so every host picks the same one.
 */
function isNewerCardsOn(candidate: SharedNotifySwitch, current: SharedNotifySwitch): boolean {
  if (candidate.cardsOnChangedAt === undefined) return false;
  if (current.cardsOnChangedAt === undefined) return true;
  if (candidate.cardsOnChangedAt !== current.cardsOnChangedAt) return candidate.cardsOnChangedAt > current.cardsOnChangedAt;
  return (candidate.cardsOn?.id ?? '') < (current.cardsOn?.id ?? '');
}

/** The later machine health switch wins, on its own time; a host from before it never wins. Equal times settle on off, as the Approvals switch does. */
function isNewerHealthNotifications(candidate: SharedNotifySwitch, current: SharedNotifySwitch): boolean {
  if (candidate.healthNotificationsChangedAt === undefined) return false;
  if (current.healthNotificationsChangedAt === undefined) return true;
  if (candidate.healthNotificationsChangedAt !== current.healthNotificationsChangedAt) return candidate.healthNotificationsChangedAt > current.healthNotificationsChangedAt;
  return candidate.healthNotifications === false && current.healthNotifications !== false;
}

export interface NotifySwitchMerge {
  notifySwitch: SharedNotifySwitch;
  changed: boolean;
}

/** `current` with each part of `incoming` that is newer: the switch, "Show cards on" and the machine health switch each by their own time. */
export function mergeNotifySwitch(current: SharedNotifySwitch, incoming: SharedNotifySwitch): NotifySwitchMerge {
  let notifySwitch = current;
  if (isNewerNotifySwitch(incoming, current)) notifySwitch = { ...notifySwitch, enabled: incoming.enabled, changedAt: incoming.changedAt };
  if (isNewerCardsOn(incoming, current)) notifySwitch = { ...notifySwitch, cardsOn: incoming.cardsOn ?? null, cardsOnChangedAt: incoming.cardsOnChangedAt };
  if (isNewerHealthNotifications(incoming, current)) notifySwitch = { ...notifySwitch, healthNotifications: incoming.healthNotifications ?? true, healthNotificationsChangedAt: incoming.healthNotificationsChangedAt };
  return { notifySwitch, changed: notifySwitch !== current };
}

/** Whether `host` is missing a part of `newest` it can hold: a host from before a part never takes it. */
function isBehind(host: SharedNotifySwitch, newest: SharedNotifySwitch): boolean {
  if (isNewerNotifySwitch(newest, host)) return true;
  if (host.cardsOnChangedAt !== undefined && isNewerCardsOn(newest, host)) return true;
  return host.healthNotificationsChangedAt !== undefined && isNewerHealthNotifications(newest, host);
}

export interface SharedNotifySwitchHost {
  read(): Promise<SharedNotifySwitch>;
  apply(notifySwitch: SharedNotifySwitch): Promise<void>;
}

/**
 * Reads every reachable host, then writes the newest values to the hosts behind it. Unreachable
 * hosts and hosts too old to share the switch are skipped; they catch up on a later sync.
 */
export async function syncSharedNotifySwitch(hosts: readonly SharedNotifySwitchHost[]): Promise<{ reached: number; updated: number }> {
  const reads = await Promise.all(hosts.map(host => host.read().then(notifySwitch => ({ host, notifySwitch }), () => null)));
  const reached = reads.filter(read => read !== null);
  if (reached.length === 0) return { reached: 0, updated: 0 };
  const newest = reached.reduce((best, read) => mergeNotifySwitch(best, read.notifySwitch).notifySwitch, reached[0].notifySwitch);
  const behind = reached.filter(read => isBehind(read.notifySwitch, newest));
  const applied = await Promise.all(behind.map(read => read.host.apply(newest).then(() => true, () => false)));
  return { reached: reached.length, updated: applied.filter(Boolean).length };
}
