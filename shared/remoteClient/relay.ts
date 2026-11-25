import { tokenAccess } from '../types/accessLevel';
import {
  RELAY_CLIENT_COMMANDS,
  type RelayComputer,
  type RelayComputerGrant,
  type RelayExchangeRequest,
} from '../types/relay';
import type { RemotePaneConnectionProfile, RemoteRelayProfile } from '../types/remoteDaemon';
import { boundary, decodeBoundary, decodeOptionalBoundary } from '../validation/boundaryDecoder';
import { RemoteRequestError, type RemoteFetch } from './remoteDaemonClient';

/** Pane's relay domain. A `pane://pair` link without `d=` names a computer under it. */
export const DEFAULT_RELAY_DOMAIN = 'runpane.net';

/** What a pairing QR or link carries: a one-time secret for one computer under a relay domain. */
export interface RelayPairingLink {
  secret: string;
  computerId: string;
  /** The computer's name, for "Pair with <name>" before anything connects. */
  name: string;
  /** `host[:port]` of the relay domain. */
  domain: string;
}

/** What the phone and the browser app store about a relay computer, beyond the profile type's fields. */
export interface StoredRelayProfile extends RemoteRelayProfile {
  domain: string;
  /** Same-network https addresses, tried before the relay by the native networking module. */
  local: string[];
}

export type RelayConnectionProfile = RemotePaneConnectionProfile & { relay: StoredRelayProfile };

const COMPUTER_ID = /^[a-z0-9-]{1,63}$/u;
// https://<domain>/pair#… (any https host: dev domains vary) or pane://pair#… from the landing's "Open in Pane app".
const PAIRING_LINK = /^(?:https:\/\/([^/?#\s]+)\/pair\/?|pane:\/\/pair\/?)(?:\?[^#]*)?#(.+)$/u;

/** Reads a pairing QR or link: `https://<domain>/pair#s=<secret>&c=<id>&n=<name>` or `pane://pair#…`. Null for anything else. */
export function parseRelayPairingLink(text: string): RelayPairingLink | null {
  const match = PAIRING_LINK.exec(text.trim());
  if (!match) return null;
  const fragment = new URLSearchParams(match[2]);
  const secret = fragment.get('s') ?? '';
  const computerId = (fragment.get('c') ?? '').toLowerCase();
  const domain = (match[1] ?? fragment.get('d') ?? DEFAULT_RELAY_DOMAIN).toLowerCase();
  if (!secret || !COMPUTER_ID.test(computerId)) return null;
  const name = (fragment.get('n') ?? '').trim().slice(0, 60) || 'your computer';
  return { secret, computerId, name, domain };
}

/** `https://<id>.<domain>`: the computer's address through the relay. */
export function relayComputerAddress(link: Pick<RelayPairingLink, 'computerId' | 'domain'>): string {
  return `https://${link.computerId}.${link.domain}`;
}

export function isRelayProfile(profile: RemotePaneConnectionProfile): profile is RelayConnectionProfile {
  return profile.relay !== undefined;
}

/** A saved profile for a computer reached through a relay. Its id follows the computer, so pairing again replaces it. */
export function relayProfile(grant: RelayComputerGrant, via?: { name: string; id: string }): RelayConnectionProfile {
  const { computer, token } = grant;
  const relay: StoredRelayProfile = { computerId: computer.id, fingerprint: computer.fingerprint, domain: computer.domain, local: computer.local };
  if (via) relay.linkedBy = via.name;
  if (via && tokenAccess(token) === 'read') relay.sharedBy = via.id;
  const profile: RelayConnectionProfile = { id: `relay:${computer.id}`, label: computer.name, baseUrl: computer.address.replace(/\/+$/u, ''), token, transport: 'http+sse', relay };
  return profile;
}

/** Why a pairing failed, in the words the phone and the browser show. */
export class RelayPairingError extends Error {
  override name = 'RelayPairingError';

  constructor(
    /** The short title, such as "This code was already used". */
    message: string,
    readonly detail: string,
    /** The computer's error code, or `unreachable`. */
    readonly code: string,
    /** Scanning the computer's current code fixes it. */
    readonly scanAgain: boolean,
  ) {
    super(message);
  }
}

const computerSchema = boundary.object({
  id: boundary.nonEmptyString,
  name: boundary.nonEmptyString,
  domain: boundary.nonEmptyString,
  address: boundary.nonEmptyString,
  local: boundary.array(boundary.string),
  fingerprint: boundary.nonEmptyString,
});
const grantSchema = boundary.object({ computer: computerSchema, token: boundary.nonEmptyString });
const exchangeSchema = boundary.object({
  ok: boundary.literal(true),
  token: boundary.nonEmptyString,
  clientId: boundary.nonEmptyString,
  computer: computerSchema,
  linked: boundary.array(grantSchema),
});
const failureSchema = boundary.object({
  ok: boundary.literal(false),
  error: boundary.object({ code: boundary.optional(boundary.string), message: boundary.optional(boundary.string) }),
});
const tokenSchema = boundary.object({ token: boundary.nonEmptyString });

function pairingFailure(code: string, name: string): RelayPairingError {
  switch (code) {
    case 'ERR_PAIRING_CODE_USED':
      return new RelayPairingError('This code was already used', `Each code pairs one phone. Pane on ${name} is showing a new one now.`, code, true);
    case 'ERR_PAIRING_CODE_EXPIRED':
      return new RelayPairingError('This code expired', `Codes last 10 minutes. Pane on ${name} is showing a new one now.`, code, true);
    case 'ERR_PAIRING_LOCKED':
      return new RelayPairingError('Pairing is paused', `${name} paused pairing for 15 minutes after several wrong codes. Try again later.`, code, false);
    default:
      return new RelayPairingError('This code didn’t work', `Scan the code Pane on ${name} is showing now.`, code, true);
  }
}

/** A pairing request that has no answer after this long fails, so the phone says why instead of loading. */
const RELAY_PAIRING_TIMEOUT_MS = 10_000;

/** A pairing request's answer: its status and JSON body, read within RELAY_PAIRING_TIMEOUT_MS or thrown. */
export async function fetchWithin(fetch: RemoteFetch, url: string, init: Parameters<RemoteFetch>[1]): Promise<{ ok: boolean; status: number; body: unknown }> {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), RELAY_PAIRING_TIMEOUT_MS);
  try {
    const response = await fetch(url, { ...init, signal: abort.signal });
    return { ok: response.ok, status: response.status, body: await response.json() };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Trades a pairing secret for this device's token at `POST https://<id>.<domain>/pair/exchange`
 * (the browser app's own origin) and returns the scanned computer's profile first, then a profile
 * for each computer linked with it. With `watching`, the person agreed to watch only: an answer with any
 * other token throws and nothing is kept. Throws `RelayPairingError`, also when a different computer
 * answers. Linked computers outside `<id>.<domain>` are dropped.
 */
export async function exchangeRelayPairing(
  fetch: RemoteFetch,
  scanned: Pick<RelayPairingLink, 'computerId' | 'domain' | 'name'>,
  request: RelayExchangeRequest,
  { watching = false }: { watching?: boolean } = {},
): Promise<RelayConnectionProfile[]> {
  const { name } = scanned;
  let response;
  try {
    response = await fetchWithin(fetch, `${relayComputerAddress(scanned)}/pair/exchange`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request),
      cache: 'no-store',
    });
  } catch {
    throw new RelayPairingError(`Can’t reach ${name}`, `${name} didn’t answer. Check that this device is online, then open Pane › Add a device on ${name}: it shows a code once ${name} is ready for phones, or says why not. Then try again.`, 'unreachable', false);
  }
  const body = response.body;
  const result = decodeOptionalBoundary(body, exchangeSchema);
  if (!response.ok || !result) {
    const failure = decodeOptionalBoundary(body, failureSchema);
    throw pairingFailure(failure?.error.code ?? `HTTP_${response.status}`, name);
  }
  if (result.computer.id !== scanned.computerId || !isRelayComputerUnder(result.computer, scanned.domain)) {
    throw new RelayPairingError('This code didn’t work', `A different computer answered. Scan the code Pane on ${name} is showing now.`, 'ERR_PAIRING_WRONG_COMPUTER', true);
  }
  const level = tokenAccess(result.token);
  if (watching && level !== 'read') {
    throw new RelayPairingError('This code changed', `It was Read only, and ${name} answered with full access, so nothing was paired. Ask for a new code.`, 'ERR_PAIRING_LEVEL_CHANGED', true);
  }
  // Linked computers come at the scanned computer's own level, never another.
  const linked = result.linked.filter(grant => grant.computer.id !== scanned.computerId && tokenAccess(grant.token) === level && isRelayComputerUnder(grant.computer, scanned.domain));
  return [relayProfile({ computer: result.computer, token: result.token }), ...linked.map(grant => relayProfile(grant, { name: result.computer.name, id: result.computer.id }))];
}

const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567';
const BASE64URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

/**
 * Whether a computer's key fingerprint (base64url sha256 of its public key) is the one its id names:
 * the id is the fingerprint's first 80 bits in lowercase base32 (relay/src/id.rs). A pin that matches
 * the scanned id can't be swapped for another key, even by a relay that holds a certificate for the name.
 */
export function relayKeyMatchesId(computer: Pick<RelayComputer, 'id' | 'fingerprint'>): boolean {
  if (!/^[A-Za-z0-9_-]{43}$/u.test(computer.fingerprint)) return false;
  let value = 0;
  let bits = 0;
  let id = '';
  for (const char of computer.fingerprint.slice(0, 16)) {
    value = ((value << 6) | BASE64URL.indexOf(char)) & 0x7ff;
    bits += 6;
    while (bits >= 5 && id.length < 16) {
      id += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  return id === computer.id;
}

/** Whether a computer sits at `https://<id>.<domain>` with the key its id names, so its answer can't stand in for another computer. */
export function isRelayComputerUnder(computer: RelayComputer, domain: string): boolean {
  return COMPUTER_ID.test(computer.id)
    && relayKeyMatchesId(computer)
    && computer.domain === domain
    && computer.address.replace(/\/+$/u, '') === relayComputerAddress({ computerId: computer.id, domain });
}

/**
 * `saved` plus each of `added` the device has no profile for yet (same id or address). A
 * computer's answer never replaces a saved computer's token or fingerprint; only scanning that
 * computer's own code does. A read-only profile is the exception: full access takes its place, and so
 * does a fresh read-only token from whoever shared it, who may have removed this device before sharing again.
 */
export function withNewProfiles<T extends RemotePaneConnectionProfile>(saved: readonly T[], added: readonly T[]): T[] {
  const profiles = [...saved];
  for (const profile of added) {
    const at = profiles.findIndex(known => known.id === profile.id || known.baseUrl === profile.baseUrl);
    if (at < 0) profiles.push(profile);
    else if (tokenAccess(profiles[at]?.token ?? '') === 'read' && (tokenAccess(profile.token) !== 'read' || profiles[at]?.relay?.sharedBy === profile.relay?.sharedBy)) profiles[at] = profile;
  }
  return profiles;
}

/** A client that calls one computer's commands: `RemoteDaemonClient`, or a fake in tests. */
export interface RelayCommandClient {
  invoke<T = unknown>(channel: string, args?: unknown[]): Promise<T>;
}

export interface RelayLinkPeer {
  computer: RelayComputer;
  client: RelayCommandClient;
}

/**
 * Links a newly paired computer with each of the phone's other relay computers (D-16: no prompt).
 * Each pair mints a token on both sides and saves it on the other. One computer that is off fails
 * only its own link; the rest go ahead. Returns the ids of the computers it could not link.
 */
export async function linkRelayComputers(added: RelayLinkPeer, others: readonly RelayLinkPeer[]): Promise<string[]> {
  const peers = others.filter(other => other.computer.id !== added.computer.id);
  const results = await Promise.allSettled(peers.map(async (other) => {
    const forOther = decodeBoundary(await added.client.invoke(RELAY_CLIENT_COMMANDS.mintLink, [{ peer: other.computer }]), tokenSchema);
    const forAdded = decodeBoundary(await other.client.invoke(RELAY_CLIENT_COMMANDS.mintLink, [{ peer: added.computer }]), tokenSchema);
    await other.client.invoke(RELAY_CLIENT_COMMANDS.saveLink, [{ peer: added.computer, token: forOther.token }]);
    await added.client.invoke(RELAY_CLIENT_COMMANDS.saveLink, [{ peer: other.computer, token: forAdded.token }]);
  }));
  return peers.flatMap((peer, index) => {
    const result = results[index];
    // A computer that is already linked with the peer keeps its link, and the pair counts as linked.
    const alreadyLinked = result?.status === 'rejected' && result.reason instanceof RemoteRequestError && result.reason.code === 'ERR_RELAY_ALREADY_LINKED';
    return result?.status === 'rejected' && !alreadyLinked ? [peer.computer.id] : [];
  });
}

/**
 * Links a newly paired computer with the device's other saved relay computers, skipping the
 * ones the pairing already linked it with. Returns the ids it could not link yet. A computer this
 * device only watches joins nothing: it is never linked, whether it is the new one or a saved one.
 */
export function linkWithSavedRelayComputers(
  added: RelayConnectionProfile,
  alreadyLinked: readonly RelayConnectionProfile[],
  saved: readonly RemotePaneConnectionProfile[],
  clientFor: (profile: RelayConnectionProfile) => RelayCommandClient,
): Promise<string[]> {
  if (tokenAccess(added.token) === 'read') return Promise.resolve([]);
  const skip = new Set([added.relay.computerId, ...alreadyLinked.map(profile => profile.relay.computerId)]);
  const others = saved.filter(isRelayProfile).filter(profile => tokenAccess(profile.token) !== 'read' && !skip.has(profile.relay.computerId));
  const peer = (profile: RelayConnectionProfile): RelayLinkPeer => ({ computer: relayComputerOf(profile), client: clientFor(profile) });
  return others.length ? linkRelayComputers(peer(added), others.map(peer)) : Promise.resolve([]);
}

/** The computer a relay profile stands for, as the link commands take it. */
export function relayComputerOf(profile: RelayConnectionProfile): RelayComputer {
  const { relay } = profile;
  return { id: relay.computerId, name: profile.label, domain: relay.domain, address: profile.baseUrl, local: relay.local, fingerprint: relay.fingerprint };
}

/**
 * "Your computers": asks one relay computer for the computers linked with it and returns profiles
 * for the ones this device has not saved yet, on that computer's domain. A computer this device only
 * watches hands out read-only tokens, and is told only of the computers it shared itself.
 */
export async function fetchNewRelayProfiles(
  client: RelayCommandClient,
  from: RelayConnectionProfile,
  saved: readonly RemotePaneConnectionProfile[],
): Promise<RelayConnectionProfile[]> {
  const level = tokenAccess(from.token);
  // Read-only profiles another computer shared are not this one's business, and full access never asks to keep them.
  const known = saved.flatMap(profile => (profile.relay && tokenAccess(profile.token) === level && (level !== 'read' || profile.relay.sharedBy === from.relay.computerId) ? [profile.relay.computerId] : []));
  const grants = decodeBoundary(await client.invoke(RELAY_CLIENT_COMMANDS.computers, [{ known }]), boundary.array(grantSchema));
  return grants
    .filter(grant => !known.includes(grant.computer.id) && tokenAccess(grant.token) === level && isRelayComputerUnder(grant.computer, from.relay.domain))
    .map(grant => relayProfile(grant, { name: from.label, id: from.relay.computerId }));
}

const statusSchema = boundary.object({
  state: boundary.enumeration('online', 'asleep', 'offline'),
  since: boundary.nullable(boundary.string),
});

/** When the relay says the computer told it it went to sleep, that time; otherwise null. */
export async function relayAsleepSince(fetch: RemoteFetch, profile: RelayConnectionProfile): Promise<string | null> {
  try {
    const response = await fetch(`https://${profile.relay.domain}/v1/status/${profile.relay.computerId}`, { cache: 'no-store' });
    const status = decodeOptionalBoundary(await response.json(), statusSchema);
    return status?.state === 'asleep' ? status.since : null;
  } catch {
    return null;
  }
}
