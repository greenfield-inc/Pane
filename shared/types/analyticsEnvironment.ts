/**
 * Where this Pane runs, sent with first open, app open and the heartbeat so
 * dashboards can tell people apart from automated installs. Tags, never a
 * filter: these events are still sent. Older app versions send none of them,
 * so a missing tag means unknown.
 */
export interface AnalyticsEnvironment {
  ci: boolean;
  /** Which CI set the env var; `none` outside CI, `other` for a bare `CI`. */
  ci_provider: string;
  /** Docker, Podman or another container runtime (Linux only). */
  container: boolean;
  /** `native` on macOS and Windows; on Linux `x11`, `wayland`, `virtual` (Xvfb) or `none`. */
  display: 'native' | 'x11' | 'wayland' | 'virtual' | 'none';
  wsl: boolean;
  packaged: boolean;
  /** Started with PANE_DIR, FOOZOL_DIR or --pane-dir. */
  custom_pane_dir: boolean;
  /** CI, a container, or a virtual or missing display. */
  automated: boolean;
}
