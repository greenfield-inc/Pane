import { Cloud, Laptop, Server, type LucideIcon } from 'lucide-react';
import type { RemoteHostKindIcon, RemotePaneConnectionProfile } from '../../../shared/types/remoteDaemon';

export type HostIcon = 'local' | RemoteHostKindIcon;

interface HostDescription {
  /** "This computer" or the saved host's label. */
  name: string;
  /** What kind of host it is, e.g. "remote host"; null for this computer. */
  kindLabel: string | null;
  icon: HostIcon;
}

export const HOST_ICONS: Record<HostIcon, LucideIcon> = {
  local: Laptop,
  server: Server,
  cloud: Cloud,
};

/** How the app names a host: null is this computer, a profile is a saved remote. */
export function describeHost(
  profile: Pick<RemotePaneConnectionProfile, 'label' | 'hostKind'> | null | undefined,
): HostDescription {
  if (!profile) return { name: 'This computer', kindLabel: null, icon: 'local' };
  return {
    name: profile.label,
    kindLabel: profile.hostKind?.label ?? 'remote host',
    icon: profile.hostKind?.icon ?? 'server',
  };
}
