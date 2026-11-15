import { boundary, decodeBoundary, type BoundarySchema, type JsonValue } from '../validation/boundaryDecoder';
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

export const COMPUTER_ROUTE_LABELS: Record<ComputerRouteKind, string> = {
  lan: 'Same network',
  tailscale: 'Tailscale',
  ssh: 'SSH',
  public: 'Public URL',
  relay: 'Pane relay',
};

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

const computerSchema: BoundarySchema<RemoteComputer> = boundary.object({
  id: boundary.nonEmptyString,
  label: boundary.nonEmptyString,
  machineId: boundary.optional(boundary.nonEmptyString),
  os: boundary.optional(boundary.enumeration('macOS', 'Windows', 'Linux')),
  linkedBy: boundary.optional(boundary.nonEmptyString),
  routes: boundary.array(routeSchema),
});

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

/** Saved computers that decode; a record that does not is dropped, the rest load. */
export function decodeComputers(value: JsonValue | undefined): RemoteComputer[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    try {
      const computer = decodeBoundary(entry, computerSchema);
      return computer.routes.length ? [computer] : [];
    } catch {
      return [];
    }
  });
}

export function decodeComputerRoutesReport(value: unknown): ComputerRoutesReport | undefined {
  try {
    return value === undefined ? undefined : decodeBoundary(value, reportSchema);
  } catch {
    return undefined;
  }
}

function routeId(kind: ComputerRouteKind, baseUrl: string): string {
  return `${kind}:${baseUrl.replace(/\/+$/u, '')}`;
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

/** Saves routes onto the computer the identity names, or a new computer. Returns the list and the computer's id. */
export function upsertComputer(computers: readonly RemoteComputer[], upsert: ComputerUpsert): { computers: RemoteComputer[]; id: string } {
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

/** The routes a host reports for itself, all reached with the credential this computer already holds there. */
export function foundRoutes(report: ComputerRoutesReport, token: string): ComputerRoute[] {
  if (!token) return [];
  const routes: ComputerRoute[] = [];
  const relay = report.relay;
  for (const address of relay?.local ?? []) {
    routes.push({ id: routeId('lan', address), kind: 'lan', source: 'found', baseUrl: address, token, relay: { computerId: relay!.id, fingerprint: relay!.fingerprint } });
  }
  if (report.tailnet) {
    const baseUrl = `https://${report.tailnet.dnsName.replace(/\.$/u, '')}:${report.tailnet.port}`;
    routes.push({ id: routeId('tailscale', baseUrl), kind: 'tailscale', source: 'found', baseUrl, token, tailnetMachine: report.tailnet.machine, tailnetDomain: report.tailnet.domain });
  }
  if (report.publicUrl) {
    routes.push({ id: routeId('public', report.publicUrl), kind: 'public', source: 'found', baseUrl: report.publicUrl.replace(/\/+$/u, ''), token });
  }
  if (relay) {
    routes.push({ id: routeId('relay', relay.address), kind: 'relay', source: 'found', baseUrl: relay.address.replace(/\/+$/u, ''), token, relay: { computerId: relay.id, fingerprint: relay.fingerprint } });
  }
  return routes;
}

/**
 * Applies what a computer reported on connecting over `via`: its install id, OS, and found routes.
 * Found routes it no longer reports are dropped. When the computer reports a different install id
 * than the one saved, the route belongs to another computer: it moves to that computer's record.
 */
export function applyRoutesReport(
  computers: readonly RemoteComputer[],
  computerId: string,
  via: ComputerRoute,
  report: ComputerRoutesReport,
): { computers: RemoteComputer[]; id: string } {
  const computer = computers.find((candidate) => candidate.id === computerId);
  if (!computer) return { computers: [...computers], id: computerId };
  const found = foundRoutes(report, via.token);
  if (computer.machineId && computer.machineId !== report.machineId) {
    const remaining = computers.map((candidate) => (candidate.id === computerId
      ? { ...candidate, routes: candidate.routes.filter((route) => route.id !== via.id) }
      : candidate)).filter((candidate) => candidate.routes.length > 0);
    return upsertComputer(remaining, { machineId: report.machineId, label: report.name, os: report.os, routes: [via, ...found] });
  }
  const reported = new Set(found.map((route) => route.id));
  const kept = computer.routes.filter((route) => route.source !== 'found' || reported.has(route.id) || route.id === via.id);
  const updated: RemoteComputer = { ...computer, machineId: report.machineId, routes: withRoutes(kept, found) };
  if (report.os) updated.os = report.os;
  // Another saved record with this install id is the same computer: fold it in.
  const twin = computers.find((candidate) => candidate.id !== computerId && candidate.machineId === report.machineId);
  if (twin) updated.routes = withRoutes(updated.routes, twin.routes);
  return {
    computers: computers.filter((candidate) => candidate !== twin).map((candidate) => (candidate.id === computerId ? updated : candidate)),
    id: computerId,
  };
}

/**
 * Converts entries saved before computers (one per route) into computers. A saved Tailscale machine
 * and a relay computer with the same name become one computer with both routes. The merged record
 * keeps the active entry's id when it is one of them, else the first one's.
 */
export function convertProfiles(
  profiles: readonly RemotePaneConnectionProfile[],
  activeProfileId: string | null,
): { computers: RemoteComputer[]; activeProfileId: string | null } {
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
