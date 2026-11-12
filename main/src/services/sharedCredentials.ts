import { createHash } from 'crypto';
import os from 'os';
import type { AppConfig } from '../types/config';
import type { NotifySettings } from '../../../shared/types/notify';
import type { ConfigManager } from './configManager';
import { boundary, decodeBoundary, decodeOptionalBoundary, type BoundarySchema } from '../../../shared/validation/boundaryDecoder';
import {
  mergeNotifySwitch,
  mergeSharedCredentials,
  SHARED_CREDENTIAL_IDS,
  UNTIMED_CREDENTIAL,
  type ApnsCredentialConfig,
  type SharedCredential,
  type SharedCredentialId,
  type SharedCredentials,
  type SharedNotifySwitch,
} from '../../../shared/types/sharedCredentials';

/** The name other hosts show as a key's source. */
function localHostLabel(): string {
  return os.hostname().replace(/\.local$/i, '');
}

const apnsSchema = boundary.object({
  teamId: boundary.nonEmptyString,
  keyId: boundary.nonEmptyString,
  privateKey: boundary.nonEmptyString,
  topic: boundary.nonEmptyString,
  environment: boundary.enumeration('sandbox', 'production'),
});

const credentialSchema = boundary.object({
  value: boundary.nullable(boundary.nonEmptyString),
  updatedAt: boundary.nonEmptyString,
  source: boundary.nonEmptyString,
});

/** Ids this Pane doesn't know are dropped, so an older host accepts a newer host's set. */
export const sharedCredentialsSchema: BoundarySchema<SharedCredentials> = boundary.object({
  anthropicApiKey: boundary.optional(credentialSchema),
  openaiApiKey: boundary.optional(credentialSchema),
  deepgramApiKey: boundary.optional(credentialSchema),
  falApiKey: boundary.optional(credentialSchema),
  openRouterApiKey: boundary.optional(credentialSchema),
  apns: boundary.optional(credentialSchema),
  paneSecrets: boundary.optional(boundary.record(credentialSchema)),
});

function configValue(config: AppConfig, id: SharedCredentialId): string | undefined {
  if (id === 'apns') return config.apns ? JSON.stringify(config.apns) : undefined;
  return config[id] || undefined;
}

function configPatchValue(id: SharedCredentialId, value: string | null): Partial<AppConfig> {
  if (id !== 'apns') return { [id]: value ?? undefined };
  const apns: ApnsCredentialConfig | undefined = value === null ? undefined : decodeBoundary(JSON.parse(value), apnsSchema);
  return { apns };
}

function valueDigest(value: string | undefined): string | undefined {
  return value === undefined ? undefined : createHash('sha256').update(value).digest('hex').slice(0, 16);
}

/** The keys this host holds in its config. Keys that exist only in its environment stay local. */
export function readSharedCredentials(config: AppConfig): SharedCredentials {
  const credentials: SharedCredentials = {};
  for (const id of SHARED_CREDENTIAL_IDS) {
    const value = configValue(config, id);
    const meta = config.sharedCredentials?.[id];
    if (meta) credentials[id] = { value: value ?? null, updatedAt: meta.updatedAt, source: meta.source };
  }
  return credentials;
}

/**
 * New records for keys whose value changed since their record was written, or null when none did.
 * A changed key counts as set now, on this host. A key with no record is stamped now when it was just
 * saved, or untimed when it comes from a config written before sharing existed, so upgrading never
 * overwrites another host's key. Keys merged from another host already carry a matching record.
 */
export function restampSharedCredentials(config: AppConfig, unrecorded: 'now' | 'untimed'): AppConfig['sharedCredentials'] | null {
  let restamped: AppConfig['sharedCredentials'] | null = null;
  for (const id of SHARED_CREDENTIAL_IDS) {
    const meta = config.sharedCredentials?.[id];
    const digest = valueDigest(configValue(config, id));
    if (meta ? meta.valueDigest === digest : digest === undefined) continue;
    const updatedAt = meta || unrecorded === 'now' ? new Date().toISOString() : UNTIMED_CREDENTIAL;
    restamped = { ...(restamped ?? config.sharedCredentials), [id]: { updatedAt, source: localHostLabel(), valueDigest: digest } };
  }
  return restamped;
}

/** Saves each key in `incoming` that is newer than this host's copy. Returns this host's keys afterwards and the ids that changed. */
export async function applySharedCredentials(configManager: ConfigManager, incoming: SharedCredentials): Promise<{ credentials: SharedCredentials; changed: SharedCredentialId[] }> {
  let changed: SharedCredentialId[] = [];
  await configManager.updateConfigWith((config) => {
    const merged = mergeSharedCredentials(readSharedCredentials(config), incoming);
    changed = merged.changed.filter(id => isApplicable(id, merged.credentials[id]));
    if (changed.length === 0) return {};
    const patch: Partial<AppConfig> = { sharedCredentials: { ...config.sharedCredentials } };
    for (const id of changed) {
      // SAFETY: `changed` lists only ids present in the merged set.
      const { value, updatedAt, source } = merged.credentials[id] as SharedCredential;
      Object.assign(patch, configPatchValue(id, value));
      patch.sharedCredentials = { ...patch.sharedCredentials, [id]: { updatedAt, source, valueDigest: valueDigest(configValue({ ...config, ...patch }, id)) } };
    }
    return patch;
  });
  return { credentials: readSharedCredentials(configManager.getConfig()), changed };
}

/** An APNs value that doesn't decode is skipped rather than failing the whole set. */
function isApplicable(id: SharedCredentialId, credential: SharedCredential | undefined): boolean {
  if (id !== 'apns' || !credential?.value) return true;
  try {
    return decodeOptionalBoundary(JSON.parse(credential.value), apnsSchema) !== undefined;
  } catch {
    return false;
  }
}

const cardsOnSchema = boundary.object({ id: boundary.nonEmptyString, name: boundary.nonEmptyString });

/** A host from before "Show cards on" sends neither of its fields; an older host drops them. */
export const sharedNotifySwitchSchema: BoundarySchema<SharedNotifySwitch> = boundary.object({
  enabled: boundary.boolean,
  changedAt: boundary.number,
  cardsOn: boundary.optional(boundary.nullable(cardsOnSchema)),
  cardsOnChangedAt: boundary.optional(boundary.number),
});

/** This host's Approvals switch and "Show cards on". A missing switch means on; an off saved before sharing existed has time 0. */
export function readNotifySwitch(config: AppConfig): SharedNotifySwitch {
  return {
    enabled: config.notify?.enabled ?? true,
    changedAt: config.notifyEnabledChangedAt ?? 0,
    cardsOn: config.notify?.cardsOn ?? null,
    cardsOnChangedAt: config.notifyCardsOnChangedAt ?? 0,
  };
}

/** A later time than `changedAt`, so a change here beats a stored time from a clock running ahead. */
const restampAfter = (changedAt: number) => Math.max(Date.now(), changedAt + 1);

/** The new time for a switch the person changed between `previous` and `next`, or null when it wasn't. */
export function restampNotifySwitch(previous: AppConfig, next: AppConfig): number | null {
  const before = readNotifySwitch(previous);
  const after = readNotifySwitch(next);
  if (before.enabled === after.enabled || before.changedAt !== after.changedAt) return null;
  return restampAfter(after.changedAt);
}

/** The new time for a "Show cards on" the person changed between `previous` and `next`, or null when it wasn't. */
export function restampCardsOn(previous: AppConfig, next: AppConfig): number | null {
  const before = readNotifySwitch(previous);
  const after = readNotifySwitch(next);
  if (before.cardsOn?.id === after.cardsOn?.id || before.cardsOnChangedAt !== after.cardsOnChangedAt) return null;
  return restampAfter(after.cardsOnChangedAt ?? 0);
}

/** Saves each part of `incoming` that beats this host's, keeping its time. The other Approvals settings stay per-machine. */
export async function applyNotifySwitch(configManager: ConfigManager, incoming: SharedNotifySwitch): Promise<{ notifySwitch: SharedNotifySwitch; changed: boolean }> {
  let changed = false;
  await configManager.updateConfigWith((config) => {
    const current = readNotifySwitch(config);
    const merged = mergeNotifySwitch(current, incoming).notifySwitch;
    const notify: Partial<NotifySettings> = {};
    const patch: Partial<AppConfig> = { notify };
    if (merged.changedAt !== current.changedAt || merged.enabled !== current.enabled) {
      notify.enabled = merged.enabled;
      patch.notifyEnabledChangedAt = merged.changedAt;
    }
    if (merged.cardsOnChangedAt !== current.cardsOnChangedAt) {
      notify.cardsOn = merged.cardsOn ?? null;
      patch.notifyCardsOnChangedAt = merged.cardsOnChangedAt;
    }
    changed = Object.keys(patch).length > 1;
    return changed ? patch : {};
  });
  return { notifySwitch: readNotifySwitch(configManager.getConfig()), changed };
}
