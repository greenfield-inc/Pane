/** What a pane:// link opens. Pane and panel targets reuse `pane:focus-requested`. */
export type PaneLinkTarget =
  | { kind: 'pane'; paneId: string; panelId?: string }
  | { kind: 'repo'; repoId: number }
  | { kind: 'session'; sessionId: string };

/** Sent to the renderer on `pane:open-link` for the targets the renderer navigates to itself. */
export type PaneLinkNavigation = Exclude<PaneLinkTarget, { kind: 'pane' }>;
