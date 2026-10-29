/** Repos the first-run "Open your project" screen offers (main/src/services/repoFinder.ts). */

import type { PaneChatAgent } from './paneChat';

export type RepoSource = 'claude_config' | 'codex_config' | 'code_folder';

export interface FoundRepo {
  name: string;
  /** Path to register as a project (a \\wsl.localhost path for WSL repos). */
  path: string;
  /** Path as the user knows it, with home shown as ~. */
  displayPath: string;
  branch: string | null;
  /** Last commit time in ms since the epoch, or null for a repo with no commits. */
  lastCommitAt: number | null;
  source: RepoSource;
}

export interface HostRepos {
  repos: FoundRepo[];
  /** Detected Windows shells, short names (empty elsewhere). */
  shells: string[];
  /** The default WSL distribution on Windows, else null. */
  wslDistro: string | null;
}

export interface WslRepos {
  distro: string;
  repos: FoundRepo[];
  /** Agent titles whose CLI a login shell in the distro finds. */
  agents: string[];
}

export interface SampleRepoSetup {
  projectId: number;
  projectPath: string;
  wasAlreadyRegistered: boolean;
  wasAlreadyCloned: boolean;
}

/** What the first-archive Support prompt reads from main, leaving out the sample repo. */
export interface FirstStepsState {
  /** Projects registered at the sample repo's path. */
  sampleProjectIds: number[];
  /** The newest archived worktree Panes in other projects, at most two. */
  archivedPaneIds: string[];
}

/** An agent the first-run screen offers: one this platform supports, and whether its CLI is installed. */
export interface FirstRunAgent {
  id: PaneChatAgent;
  found: boolean;
}
