import { describeHost, type HostIcon } from './hostKind';
import type { CreateProjectRequest } from '../types/project';
import type { ProjectPathMode } from '../../../shared/types/hostPaths';
import type {
  RemotePaneConnectionProfile,
  RemotePaneConnectionState,
} from '../../../shared/types/remoteDaemon';

/**
 * The host that repo actions (open, new, clone, folder browsing) run on: the
 * connected remote in remote mode, otherwise this computer. Project and clone
 * channels are daemon-owned, so they already reach this host; anything that
 * picks a path for them has to look at the same host.
 */
export interface ActiveHost {
  /** The saved remote profile's id; null for this computer. */
  id: string | null;
  remote: boolean;
  name: string;
  kindLabel: string | null;
  icon: HostIcon;
}

export function getActiveHost(
  connectionState: RemotePaneConnectionState,
  profiles: readonly RemotePaneConnectionProfile[],
): ActiveHost {
  if (connectionState.mode !== 'remote') return { id: null, remote: false, ...describeHost(null) };
  const profile = profiles.find((candidate) => candidate.id === connectionState.activeProfileId);
  return {
    id: connectionState.activeProfileId,
    remote: true,
    ...describeHost(profile ?? { label: connectionState.activeProfileLabel ?? 'Remote host' }),
  };
}

export function formatHostChipText(host: ActiveHost): string {
  return host.kindLabel ? `On: ${host.name} (${host.kindLabel})` : `On: ${host.name}`;
}

/**
 * Adds the host's display name to a host request, so host-side errors name the
 * host the user picked ("testina") instead of its machine hostname.
 */
export function withHostLabel<Request extends object>(host: ActiveHost, request: Request): Request & { hostLabel?: string } {
  return host.remote ? { ...request, hostLabel: host.name } : request;
}

type CreateProjectFields = Omit<CreateProjectRequest, 'mode' | 'hostLabel'> & { mode: ProjectPathMode };

/**
 * Every project the UI registers names its mode: 'open' must find an existing
 * repo on the host, 'new' creates one. Leaving it out would fall back to the
 * legacy create + git init, which turns a mistyped Open path into an empty repo.
 */
export function buildCreateProjectRequest(host: ActiveHost, fields: CreateProjectFields): CreateProjectRequest {
  return withHostLabel(host, fields);
}

/** A remote clone lands in the host's home unless the user picks a folder. */
export function defaultCloneDestination(host: ActiveHost): string {
  return host.remote ? '~' : '';
}

export function buildCloneOptions(host: ActiveHost): { hostLabel?: string } {
  return withHostLabel(host, {});
}

/** The native dialog only sees this computer, so a remote host browses in-app. */
export function folderBrowseTarget(host: ActiveHost): 'native' | 'host' {
  return host.remote ? 'host' : 'native';
}
