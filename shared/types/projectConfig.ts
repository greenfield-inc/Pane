/**
 * Normalized config detected from a repo-root config file.
 *
 * Produced by {@link detectProjectConfig} in projectConfigDetector.ts.
 * Maps to Pane's project settings as fallback defaults when the user
 * hasn't configured scripts in the UI.
 *
 * Supported source files (checked in this priority order):
 *   pane.json → .conductor/settings.toml → conductor.json → .gitpod.yml → devcontainer.json
 */
export interface DetectedProjectConfig {
  /** Setup/install command — maps to Project.build_script. Runs on worktree creation. */
  setup?: string;
  /** Dev server command — maps to Project.run_script. Runs on Play button click. */
  run?: string;
  /** Cleanup command — maps to Project.archive_script. Runs before worktree deletion. */
  archive?: string;
  /** Script concurrency mode from pane.json or Conductor's config. Future use — not yet enforced. */
  runScriptMode?: 'concurrent' | 'nonconcurrent';
  /** The filename this config was detected from (e.g. 'pane.json', '.gitpod.yml'). */
  source: string;
}
