import { boundary, decodeBoundary, decodeOptionalBoundary, type BoundarySchema, type JsonValue } from '../validation/boundaryDecoder';
import { tokenAccess } from './accessLevel';
import type { PaneRemoteConnectionImportPayload, RemotePaneConnectionProfile, RemoteRelayProfile } from './remoteDaemon';

/**
 * One computer, many routes (D-51). Every computer this one can reach is one record, keyed by the
 * install id its host sends (`AppConfig.machineId`), with its routes in the order they are tried.
 */
export type ComputerRouteKind = 'lan' | 'tailscale' | 'ssh' | 'public' | 'relay';

/** How a route was added: a one-time link, reported by the computer, an SSH host, or by hand (a connection code). */
export type ComputerRouteSource = 'link' | 'found' | 'ssh' | 'manual';

export type ComputerOs = 'macOS' | 'Windows' | 'Linux';

/** Nearest first: same network, Tailscale, SSH, public URL, Pane relay. */
export const COMPUTER_ROUTE_KINDS: readonly ComputerRouteKind[] = ['lan', 'tailscale', 'ssh', 'public', 'relay'];

export const COMPUTER_ROUTE_LABELS = {
  lan: 'Same network',
  tailscale: 'Tailscale',
  ssh: 'SSH',
  public: 'Public URL',
  relay: 'Pane relay',
} as const satisfies Record<ComputerRouteKind, string>;

export type ComputerRouteLabel = (typeof COMPUTER_ROUTE_LABELS)[ComputerRouteKind];

export interface ComputerRoute {
  /** `<kind>:<address>`, unique within its computer. */
  id: string;
  kind: ComputerRouteKind;
  source: ComputerRouteSource;
  baseUrl: string;
  /** The credential: a link or pairing token (accepted on every listener), or a Tailscale password; empty for Tailscale identity alone. */
  token: string;
  tunnel?: PaneRemoteConnectionImportPayload['tunnel'];
  /** Tailscale: the machine's short name and MagicDNS domain, looked up again at each connect. */
  tailnetMachine?: string;
  tailnetDomain?: string;
  /** Relay and same-network routes: the computer's relay id and key fingerprint; any other key is refused. */
  relay?: RemoteRelayProfile;
  /** SSH routes: the host alias or user@host, and the port Pane's host listens on there. */
  ssh?: { host: string; remotePort: number };
}

export interface RemoteComputer {
  /** Stable across renames and routes. A converted computer keeps the id of the entry it came from, so per-computer state survives. */
  id: string;
  label: string;
  /** The host's install id, learned from its `ready` event or a link; ids always win over names when merging. */
  machineId?: string;
  os?: ComputerOs;
  /** "Linked by <name>": who linked it, when a link did. */
  linkedBy?: string;
  routes: ComputerRoute[];
}

/** What a host says about itself: on its `ready` event and in a link's answer. Its routes are saved as "found automatically". */
export interface ComputerRoutesReport {
  machineId: string;
  name: string;
  os?: ComputerOs;
  relay?: { id: string; address: string; fingerprint: string; local: string[] };
  /** The Tailscale workspace listener, when Who can connect is not Off. */
  tailnet?: { dnsName: string; machine: string; domain: string; port: number };
  /** The computer's own HTTPS address (Settings › Remote Access › Public URL). */
  publicUrl?: string;
}

const routeSchema: BoundarySchema<ComputerRoute> = boundary.object({
  id: boundary.nonEmptyString,
  kind: boundary.enumeration(...COMPUTER_ROUTE_KINDS),
  source: boundary.enumeration('link', 'found', 'ssh', 'manual'),
  baseUrl: boundary.nonEmptyString,
  token: boundary.string,
  tunnel: boundary.optional(boundary.object({
    kind: boundary.enumeration('ssh', 'tailscale', 'manual'),
    command: boundary.optional(boundary.nonEmptyString),
    note: boundary.optional(boundary.nonEmptyString),
    selected: boundary.boolean,
    tailscaleIp: boundary.optional(boundary.nonEmptyString),
  })),
  tailnetMachine: boundary.optional(boundary.nonEmptyString),
  tailnetDomain: boundary.optional(boundary.nonEmptyString),
  relay: boundary.optional(boundary.object({
    computerId: boundary.nonEmptyString,
    fingerprint: boundary.nonEmptyString,
    linkedBy: boundary.optional(boundary.nonEmptyString),
  })),
  ssh: boundary.optional(boundary.object({ host: boundary.nonEmptyString, remotePort: boundary.number })),
});

/** A saved computer with its routes and OS read separately, so a route or OS a later Pane added drops alone. */
const computerSchema = boundary.object({
  id: boundary.nonEmptyString,
  label: boundary.nonEmptyString,
  machineId: boundary.optional(boundary.nonEmptyString),
  os: boundary.optional(boundary.json),
  linkedBy: boundary.optional(boundary.nonEmptyString),
  routes: boundary.array(boundary.json),
});

const osSchema = boundary.enumeration('macOS', 'Windows', 'Linux');

const reportSchema: BoundarySchema<ComputerRoutesReport> = boundary.object({
  machineId: boundary.nonEmptyString,
  name: boundary.nonEmptyString,
  os: boundary.optional(boundary.enumeration('macOS', 'Windows', 'Linux')),
  relay: boundary.optional(boundary.object({
    id: boundary.nonEmptyString,
    address: boundary.nonEmptyString,
    fingerprint: boundary.nonEmptyString,
    local: boundary.array(boundary.string),
  })),
  tailnet: boundary.optional(boundary.object({
    dnsName: boundary.nonEmptyString,
    machine: boundary.nonEmptyString,
    domain: boundary.nonEmptyString,
    port: boundary.number,
  })),
  publicUrl: boundary.optional(boundary.nonEmptyString),
});

/**
 * Saved computers that decode. A route that does not decode (a route kind a later Pane added, or a
 * hand edit) is dropped and logged, and its computer keeps the rest; a computer left with no route,
 * or whose own fields do not decode, is dropped and logged.
 */
export function decodeComputers(value: JsonValue | undefined, log: (line: string) => void = logOnce): RemoteComputer[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry, index) => {
    let saved: ReturnType<typeof computerSchema.decode>;
    try {
      saved = decodeBoundary(entry, computerSchema);
    } catch (error) {
      log(`[computers] dropped saved computer ${index + 1}: ${error instanceof Error ? error.message : String(error)}`);
      return [];
    }
    const { os, routes: savedRoutes, ...fields } = saved;
    const routes = savedRoutes.flatMap((route) => {
      try {
        return [decodeBoundary(route, routeSchema)];
      } catch (error) {
        log(`[computers] ${saved.label}: dropped a route Pane can't read: ${error instanceof Error ? error.message : String(error)}`);
        return [];
      }
    });
    if (!routes.length) {
      log(`[computers] dropped ${saved.label}: none of its routes can be read`);
      return [];
    }
    const computer: RemoteComputer = { ...fields, routes };
    const known = decodeOptionalBoundary(os, osSchema);
    if (known) computer.os = known;
    return [computer];
  });
}

const logged = new Set<string>();
/** Config is read often; each drop is logged once per run. */
function logOnce(line: string): void {
  if (logged.has(line)) return;
  logged.add(line);
  console.warn(line);
}

export function decodeComputerRoutesReport(value: JsonValue | undefined): ComputerRoutesReport | undefined {
  try {
    return value === undefined ? undefined : decodeBoundary(value, reportSchema);
  } catch {
    return undefined;
  }
}

function routeId(kind: ComputerRouteKind, baseUrl: string): string {
  return `${kind}:${baseUrl.replace(/\/+$/u, '')}`;
}

/** A network interface as `os.networkInterfaces()` lists it. */
export interface LocalInterface {
  address: string;
  netmask: string;
  family: string | number;
  internal: boolean;
}

function ipv4Number(address: string): number | undefined {
  const parts = address.split('.').map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return undefined;
  return parts.reduce((value, part) => value * 256 + part, 0);
}

/**
 * The routes worth trying from here. A Same network route (`https://l<a-b-c-d>.<id>.<domain>`) is
 * kept only when its address is on one of this computer's own subnets, so the addresses of another
 * home network, or of WSL, Docker or VM adapters on the computer, cost no timeouts. When that leaves
 * nothing, every route is kept.
 */
export function routesReachableHere<Route extends Pick<ComputerRoute, 'kind' | 'baseUrl'>>(routes: readonly Route[], interfaces: readonly LocalInterface[]): Route[] {
  const subnets = interfaces.flatMap((entry) => {
    const address = entry.family === 'IPv4' || entry.family === 4 ? ipv4Number(entry.address) : undefined;
    const mask = ipv4Number(entry.netmask);
    return entry.internal || address === undefined || mask === undefined ? [] : [{ address, mask }];
  });
  const sameNetwork = (baseUrl: string) => {
    let host: string;
    try {
      host = new URL(baseUrl).hostname;
    } catch {
      return false;
    }
    const encoded = /^l(\d+-\d+-\d+-\d+)\./u.exec(host)?.[1];
    const address = encoded === undefined ? undefined : ipv4Number(encoded.replace(/-/gu, '.'));
    if (address === undefined) return true;
    // Bitwise AND works on signed 32-bit ints; `>>> 0` reads both sides as unsigned.
    return subnets.some((subnet) => ((address & subnet.mask) >>> 0) === ((subnet.address & subnet.mask) >>> 0));
  };
  const kept = routes.filter((route) => route.kind !== 'lan' || sameNetwork(route.baseUrl));
  return kept.length ? kept : [...routes];
}

/** The route a saved entry from before computers (one entry per route) stands for. */
export function routeFromProfile(profile: RemotePaneConnectionProfile, source?: ComputerRouteSource): ComputerRoute {
  const kind: ComputerRouteKind = profile.relay ? 'relay'
    : profile.tailnetMachine || profile.tunnel?.kind === 'tailscale' ? 'tailscale'
      : profile.tunnel?.kind === 'ssh' ? 'ssh'
        : 'public';
  const route: ComputerRoute = {
    id: routeId(kind, profile.baseUrl),
    kind,
    source: source ?? (profile.relay ? 'link' : profile.tailnetMachine ? 'found' : 'manual'),
    baseUrl: profile.baseUrl,
    token: profile.token,
  };
  if (profile.tunnel) route.tunnel = profile.tunnel;
  if (profile.tailnetMachine) route.tailnetMachine = profile.tailnetMachine;
  if (profile.tailnetDomain) route.tailnetDomain = profile.tailnetDomain;
  if (profile.relay) route.relay = { computerId: profile.relay.computerId, fingerprint: profile.relay.fingerprint };
  return route;
}

/**
 * Whether this computer only watches a saved computer: one of its routes carries a read-only token.
 * A computer saved both ways counts as watched, so nothing of this computer's own is sent to it.
 */
export function isWatchedComputer(computer: Pick<RemoteComputer, 'routes'>): boolean {
  return computer.routes.some((route) => tokenAccess(route.token) === 'read');
}

/** One route of a computer in the shape the connection code takes: the profile id is the computer's. */
export function routeProfile(computer: RemoteComputer, route: ComputerRoute): RemotePaneConnectionProfile {
  const profile: RemotePaneConnectionProfile = {
    id: computer.id,
    label: computer.label,
    baseUrl: route.baseUrl,
    token: route.token,
    transport: 'http+sse',
  };
  if (route.tunnel) profile.tunnel = route.tunnel;
  if (route.tailnetMachine) profile.tailnetMachine = route.tailnetMachine;
  if (route.tailnetDomain) profile.tailnetDomain = route.tailnetDomain;
  if (route.relay) {
    profile.relay = { computerId: route.relay.computerId, fingerprint: route.relay.fingerprint };
    if (computer.linkedBy) profile.relay.linkedBy = computer.linkedBy;
  }
  return profile;
}

/**
 * Saves a connection profile (a connection code, a self-test pair) as one route of the computer
 * with its id, or as a new computer.
 */
export function saveProfileRoute(computers: readonly RemoteComputer[], profile: RemotePaneConnectionProfile, source: ComputerRouteSource = 'manual'): RemoteComputer[] {
  const route = routeFromProfile(profile, source);
  const existing = computers.find((computer) => computer.id === profile.id);
  if (!existing) return [...computers, { id: profile.id, label: profile.label, routes: [route] }];
  return computers.map((computer) => (computer === existing
    ? { ...computer, label: profile.label, routes: withRoutes(computer.routes.filter((candidate) => candidate.kind !== route.kind || candidate.id === route.id), [route]) }
    : computer));
}

/** Every route of every computer, each as a connection profile. */
export function allRouteProfiles(computers: readonly RemoteComputer[]): RemotePaneConnectionProfile[] {
  return computers.flatMap((computer) => computer.routes.map((route) => routeProfile(computer, route)));
}

/** The route a computer is tried on first: its first. */
export function primaryProfile(computer: RemoteComputer): RemotePaneConnectionProfile {
  return routeProfile(computer, computer.routes[0]);
}

/** Lowercased, without `.local`, `.` parts after the first label, or spaces: how a relay name and a Tailscale name compare. */
export function machineNameKey(name: string): string {
  return name.trim().toLowerCase().replace(/\.local$/u, '').split('.')[0].replace(/[\s_]+/gu, '-');
}

/** The relay id a computer is known by, from any of its routes. */
export function computerRelayId(computer: RemoteComputer): string | undefined {
  return computer.routes.find((route) => route.relay)?.relay?.computerId;
}

/** The Tailscale name a computer is known by, from any of its routes. */
export function computerTailnetName(computer: RemoteComputer): { machine: string; domain: string } | undefined {
  const route = computer.routes.find((candidate) => candidate.tailnetMachine && candidate.tailnetDomain);
  return route?.tailnetMachine && route.tailnetDomain ? { machine: route.tailnetMachine, domain: route.tailnetDomain } : undefined;
}

function rank(kind: ComputerRouteKind): number {
  return COMPUTER_ROUTE_KINDS.indexOf(kind);
}

/** Adds or replaces routes by id. A new route goes before the first route of a later kind, so nearest stays first. */
export function withRoutes(routes: readonly ComputerRoute[], added: readonly ComputerRoute[]): ComputerRoute[] {
  let next = [...routes];
  for (const route of added) {
    const at = next.findIndex((existing) => existing.id === route.id);
    if (at >= 0) {
      // A found route never downgrades one that was linked or added by hand.
      const existing = next[at];
      next[at] = route.source === 'found' && existing.source !== 'found' ? { ...route, source: existing.source } : route;
      continue;
    }
    const before = next.findIndex((existing) => rank(existing.kind) > rank(route.kind));
    next = before < 0 ? [...next, route] : [...next.slice(0, before), route, ...next.slice(before)];
  }
  return next;
}

/** What a computer is told apart by: its install id, else its relay id, else (Tailscale only) its name. */
export interface ComputerIdentity {
  machineId?: string;
  relayId?: string;
  /** A Tailscale machine before its install id is known matches a computer of the same name. */
  tailnetName?: string;
}

/**
 * The saved computer this identity is, or undefined. Ids always win: a different install id never
 * matches, whatever the name (journey 16).
 */
export function findComputer(computers: readonly RemoteComputer[], identity: ComputerIdentity): RemoteComputer | undefined {
  if (identity.machineId) {
    const byId = computers.find((computer) => computer.machineId === identity.machineId);
    if (byId) return byId;
  }
  if (identity.relayId) {
    const byRelay = computers.find((computer) => computerRelayId(computer) === identity.relayId
      && (!identity.machineId || !computer.machineId || computer.machineId === identity.machineId));
    if (byRelay) return byRelay;
  }
  if (identity.tailnetName) {
    const key = machineNameKey(identity.tailnetName);
    const byName = computers.filter((computer) => (!identity.machineId || !computer.machineId)
      && (machineNameKey(computer.label) === key || machineNameKey(computerTailnetName(computer)?.machine ?? '') === key));
    // Two saved computers with this name: the name decides nothing.
    if (byName.length === 1) return byName[0];
  }
  return undefined;
}

export interface ComputerUpsert extends ComputerIdentity {
  label: string;
  os?: ComputerOs;
  linkedBy?: string;
  routes: ComputerRoute[];
  /** The id for a new record; defaults to one derived from the identity. */
  id?: string;
}

/** The saved computers after a change, and the id of the computer it was about. */
export interface ComputersChange {
  computers: RemoteComputer[];
  id: string;
}

/** Saves routes onto the computer the identity names, or a new computer. */
export function upsertComputer(computers: readonly RemoteComputer[], upsert: ComputerUpsert): ComputersChange {
  const existing = findComputer(computers, upsert);
  if (existing) {
    const merged: RemoteComputer = { ...existing, routes: withRoutes(existing.routes, upsert.routes) };
    if (upsert.machineId) merged.machineId = upsert.machineId;
    if (upsert.os) merged.os = upsert.os;
    if (upsert.linkedBy) merged.linkedBy = upsert.linkedBy;
    // A link names the computer as it calls itself; a Tailscale name does not rename it.
    if (upsert.routes.some((route) => route.source !== 'found')) merged.label = upsert.label;
    return { computers: computers.map((computer) => (computer.id === existing.id ? merged : computer)), id: existing.id };
  }
  const id = upsert.id ?? newComputerId(upsert, computers);
  const created: RemoteComputer = { id, label: upsert.label, routes: withRoutes([], upsert.routes) };
  if (upsert.machineId) created.machineId = upsert.machineId;
  if (upsert.os) created.os = upsert.os;
  if (upsert.linkedBy) created.linkedBy = upsert.linkedBy;
  return { computers: [...computers, created], id };
}

function newComputerId(identity: ComputerIdentity, computers: readonly RemoteComputer[]): string {
  const base = identity.machineId ? `computer-${identity.machineId}`
    : identity.relayId ? `relay-${identity.relayId}`
      : `computer-${machineNameKey(identity.tailnetName ?? 'computer')}`;
  let id = base;
  for (let n = 2; computers.some((computer) => computer.id === id); n += 1) id = `${base}-${n}`;
  return id;
}

/** An `https:` address with no credentials, query or fragment, without a trailing slash; anything else is undefined. */
function httpsOrigin(address: string): string | undefined {
  try {
    const url = new URL(address);
    const plain = url.protocol === 'https:' && url.hostname && !url.username && !url.password && !url.search && !url.hash;
    return plain ? `${url.origin}${url.pathname.replace(/\/+$/u, '')}` : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The routes a host reports for itself, all reached with the credential this computer already holds
 * there. Only `https:` addresses are kept, so the token never goes out in the clear.
 */
export function foundRoutes(report: ComputerRoutesReport, token: string): ComputerRoute[] {
  if (!token) return [];
  const routes: ComputerRoute[] = [];
  const relay = report.relay;
  const relayAddress = relay && httpsOrigin(relay.address);
  const pin = relay && { computerId: relay.id, fingerprint: relay.fingerprint };
  for (const address of relay?.local ?? []) {
    const baseUrl = httpsOrigin(address);
    if (baseUrl && pin) routes.push({ id: routeId('lan', baseUrl), kind: 'lan', source: 'found', baseUrl, token, relay: pin });
  }
  const tailnet = report.tailnet && httpsOrigin(`https://${report.tailnet.dnsName.replace(/\.$/u, '')}:${report.tailnet.port}`);
  if (report.tailnet && tailnet) {
    routes.push({ id: routeId('tailscale', tailnet), kind: 'tailscale', source: 'found', baseUrl: tailnet, token, tailnetMachine: report.tailnet.machine, tailnetDomain: report.tailnet.domain });
  }
  const publicUrl = report.publicUrl && httpsOrigin(report.publicUrl);
  if (publicUrl) routes.push({ id: routeId('public', publicUrl), kind: 'public', source: 'found', baseUrl: publicUrl, token });
  if (relayAddress && pin) routes.push({ id: routeId('relay', relayAddress), kind: 'relay', source: 'found', baseUrl: relayAddress, token, relay: pin });
  return routes;
}

/**
 * Applies what a computer reported on connecting over `via`: its install id, OS, and found routes.
 * Found routes it no longer reports are dropped. Everything in a report is the host's own claim, and
 * the only claim checked is the key on a route whose TLS is pinned to it (Pane relay, Same network).
 * So only a report over such a route, naming that route's own key, may set the install id, move the
 * route onto another saved record, or fold another record in, and that record must pin the same key.
 * Any other report keeps to its own record and adds no route pinned to a key the record doesn't pin.
 * A route that answers with an install id no record holds moves to a new record.
 */
export function applyRoutesReport(
  computers: readonly RemoteComputer[],
  computerId: string,
  via: ComputerRoute,
  report: ComputerRoutesReport,
): ComputersChange {
  const computer = computers.find((candidate) => candidate.id === computerId);
  if (!computer) return { computers: [...computers], id: computerId };
  const proven = via.relay !== undefined && report.relay !== undefined
    && via.relay.computerId === report.relay.id && via.relay.fingerprint === report.relay.fingerprint;
  const pinned = (route: ComputerRoute, record: RemoteComputer) => route.relay === undefined
    || record.routes.some((own) => own.relay?.computerId === route.relay?.computerId && own.relay?.fingerprint === route.relay?.fingerprint);
  const found = foundRoutes(report, via.token).filter((route) => proven || pinned(route, computer));
  const holder = computers.find((candidate) => candidate.id !== computerId && candidate.machineId === report.machineId);
  const confirmed = proven && holder !== undefined && reportNamesKeyOf(holder, report);
  if (computer.machineId && computer.machineId !== report.machineId && (!holder || confirmed)) {
    const remaining = computers.map((candidate) => (candidate.id === computerId
      ? { ...candidate, routes: candidate.routes.filter((route) => route.id !== via.id) }
      : candidate)).filter((candidate) => candidate.routes.length > 0);
    return upsertComputer(remaining, { machineId: proven ? report.machineId : undefined, label: report.name, os: report.os, routes: [via, ...found] });
  }
  const reported = new Set(found.map((route) => route.id));
  const kept = computer.routes.filter((route) => route.source !== 'found' || reported.has(route.id) || route.id === via.id);
  const updated: RemoteComputer = { ...computer, routes: withRoutes(kept, found) };
  if (proven && (!holder || confirmed)) updated.machineId = report.machineId;
  if (report.os) updated.os = report.os;
  // Another saved record with this install id and the key this route just checked is the same computer: fold it in.
  const twin = confirmed ? holder : undefined;
  if (twin) updated.routes = withRoutes(updated.routes, twin.routes);
  return {
    computers: computers.filter((candidate) => candidate !== twin).map((candidate) => (candidate.id === computerId ? updated : candidate)),
    id: computerId,
  };
}

/** Whether a report's relay id and key fingerprint are the ones a saved record pins. */
function reportNamesKeyOf(computer: RemoteComputer, report: ComputerRoutesReport): boolean {
  const relay = report.relay;
  return relay !== undefined && computer.routes.some((route) => route.relay?.computerId === relay.id && route.relay.fingerprint === relay.fingerprint);
}

/** Computers converted from entries saved before them, and the active one's id among them. */
export interface ConvertedComputers {
  computers: RemoteComputer[];
  activeProfileId: string | null;
}

/**
 * Converts entries saved before computers (one per route) into computers. A saved Tailscale machine
 * and a relay computer with the same name become one computer with both routes. The merged record
 * keeps the active entry's id when it is one of them, else the first one's.
 */
export function convertProfiles(
  profiles: readonly RemotePaneConnectionProfile[],
  activeProfileId: string | null,
): ConvertedComputers {
  let computers: RemoteComputer[] = [];
  const idOf = new Map<string, string>();
  for (const profile of profiles) {
    const route = routeFromProfile(profile);
    const name = profile.tailnetMachine ?? profile.label;
    const match = computers.find((computer) => {
      const tailnet = computerTailnetName(computer);
      const relayId = computerRelayId(computer);
      // Only a Tailscale entry and a relay entry pair up by name; two of a kind are two computers.
      if (route.kind === 'relay') return !relayId && tailnet !== undefined && machineNameKey(tailnet.machine) === machineNameKey(name);
      if (route.tailnetMachine) return !tailnet && relayId !== undefined && machineNameKey(computer.label) === machineNameKey(name);
      return false;
    });
    if (!match) {
      const created: RemoteComputer = { id: profile.id, label: profile.label, routes: [route] };
      if (profile.relay?.linkedBy) created.linkedBy = profile.relay.linkedBy;
      computers.push(created);
      idOf.set(profile.id, profile.id);
      continue;
    }
    const keepId = profile.id === activeProfileId ? profile.id : match.id;
    const merged: RemoteComputer = {
      ...match,
      id: keepId,
      // The relay names the computer as it calls itself.
      label: route.kind === 'relay' ? profile.label : match.label,
      routes: withRoutes(match.routes, [route]),
    };
    if (profile.relay?.linkedBy) merged.linkedBy = profile.relay.linkedBy;
    computers = computers.map((computer) => (computer === match ? merged : computer));
    idOf.set(profile.id, keepId);
    for (const [from, to] of idOf) if (to === match.id) idOf.set(from, keepId);
  }
  return { computers, activeProfileId: activeProfileId ? idOf.get(activeProfileId) ?? null : null };
}
