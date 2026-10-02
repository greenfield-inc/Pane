/**
 * What a pane:// link opens, sent to the renderer on `pane:open-link`. A host resolves Pane and
 * panel targets itself and sends `pane:focus-requested`; a remote-mode client passes every target
 * to its renderer, which resolves it against the active host.
 */
export type PaneLinkTarget =
  | { kind: 'pane'; paneId: string; panelId?: string }
  | { kind: 'repo'; repoId: number }
  | { kind: 'session'; sessionId: string };

/** The targets a host asks the renderer to navigate to. */
export type PaneLinkNavigation = Exclude<PaneLinkTarget, { kind: 'pane' }>;
