/**
 * What this Pane may do beyond serving its own window, decided once at startup.
 *
 * A data directory belongs to the Pane that serves its daemon socket. A second
 * Pane started on it (a dev build pointed at ~/.pane, a relaunch racing the old
 * process) must not clean up data the first one is using, nor change state the
 * whole machine shares. A development desktop build never changes Tailscale
 * Serve, whose handlers are machine-wide: it would re-point or remove the
 * installed Pane's Workspaces and phone pages.
 */
export interface InstanceDuties {
  /** Scrollback retention, archive cleanup resume, reserve worktree cleanup. */
  housekeeping: boolean;
  /** The remote daemon host listener, which binds a fixed port. */
  remoteTransport: boolean;
  /** Why this Pane must leave Tailscale Serve alone, or null when it may change it. */
  serveRefusal: string | null;
}

export function decideInstanceDuties(instance: {
  ownsDataDirectory: boolean;
  isPackaged: boolean;
  mode: 'desktop' | 'headless';
}): InstanceDuties {
  if (!instance.ownsDataDirectory) {
    return { housekeeping: false, remoteTransport: false, serveRefusal: 'another Pane already serves this data directory' };
  }
  if (!instance.isPackaged && instance.mode === 'desktop') {
    return { housekeeping: true, remoteTransport: true, serveRefusal: 'a development build never changes Tailscale Serve' };
  }
  return { housekeeping: true, remoteTransport: true, serveRefusal: null };
}
