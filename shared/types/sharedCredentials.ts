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
};

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
  /** Pane secret keys (`<project>/<NAME>`) that changed. */
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
  if (incoming.paneSecrets) {
    const secrets = { ...current.paneSecrets };
    for (const [key, candidate] of Object.entries(incoming.paneSecrets)) {
      if (isNewerCredential(candidate, secrets[key])) {
        secrets[key] = candidate;
        changedSecrets.push(key);
      }
    }
    if (changedSecrets.length > 0 || current.paneSecrets) credentials.paneSecrets = secrets;
  }
  return { credentials, changed, changedSecrets };
}

/** A host a device can reach with its pairing token. */
export interface SharedCredentialHost {
  read(): Promise<SharedCredentials>;
  apply(credentials: SharedCredentials): Promise<void>;
}

/**
 * Reads every reachable host, then writes the newest copy of each key to the
 * hosts that hold an older one. Unreachable hosts and hosts too old to share
 * keys are skipped; they catch up on a later sync.
 */
export async function syncSharedCredentials(hosts: readonly SharedCredentialHost[]): Promise<{ reached: number; updated: number }> {
  const reads = await Promise.all(hosts.map(host => host.read().then(credentials => ({ host, credentials }), () => null)));
  const reached = reads.filter(read => read !== null);
  const newest = reached.reduce<SharedCredentials>((merged, read) => mergeSharedCredentials(merged, read.credentials).credentials, {});
  const behind = reached.filter(read => {
    const merge = mergeSharedCredentials(read.credentials, newest);
    return merge.changed.length + merge.changedSecrets.length > 0;
  });
  const applied = await Promise.all(behind.map(read => read.host.apply(newest).then(() => true, () => false)));
  return { reached: reached.length, updated: applied.filter(Boolean).length };
}

/**
 * The Approvals on/off switch as a host holds it. It travels on its own commands, not with the keys:
 * a phone relays keys and has no business relaying this, and a host too old for it refuses the
 * commands instead of silently dropping it.
 */
export interface SharedNotifySwitch {
  enabled: boolean;
  /** Epoch ms of the last change, on the host where the person made it. 0: never changed since sharing began. */
  changedAt: number;
}

/**
 * The later change wins. Equal times settle on off: only a value stored before sharing existed
 * has no time, and an off there was somebody's choice, while most on values are just the default.
 * The rule looks only at the values, so every host picks the same one whatever order it reads them in.
 */
export function isNewerNotifySwitch(candidate: SharedNotifySwitch, current: SharedNotifySwitch): boolean {
  if (candidate.changedAt !== current.changedAt) return candidate.changedAt > current.changedAt;
  return !candidate.enabled && current.enabled;
}

export interface SharedNotifySwitchHost {
  read(): Promise<SharedNotifySwitch>;
  apply(notifySwitch: SharedNotifySwitch): Promise<void>;
}

/**
 * Reads every reachable host, then writes the newest value to the hosts behind it. Unreachable
 * hosts and hosts too old to share the switch are skipped; they catch up on a later sync.
 */
export async function syncSharedNotifySwitch(hosts: readonly SharedNotifySwitchHost[]): Promise<{ reached: number; updated: number }> {
  const reads = await Promise.all(hosts.map(host => host.read().then(notifySwitch => ({ host, notifySwitch }), () => null)));
  const reached = reads.filter(read => read !== null);
  if (reached.length === 0) return { reached: 0, updated: 0 };
  const newest = reached.reduce((best, read) => isNewerNotifySwitch(read.notifySwitch, best) ? read.notifySwitch : best, reached[0].notifySwitch);
  const behind = reached.filter(read => isNewerNotifySwitch(newest, read.notifySwitch));
  const applied = await Promise.all(behind.map(read => read.host.apply(newest).then(() => true, () => false)));
  return { reached: reached.length, updated: applied.filter(Boolean).length };
}
