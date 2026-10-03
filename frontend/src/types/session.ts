import type { Session } from '../../../shared/types/session';
export type { Session, GitStatus, CreateSessionRequest, SessionOutput, ClaudeJsonMessage } from '../../../shared/types/session';

export interface GitCommands {
  rebaseCommands: string[];
  squashCommands: string[];
  mergeCommands: string[];
  comparisonBaseBranch?: string;
  originBranch?: string;
  currentBranch?: string;
  getPullCommand?: () => string;
  getPushCommand?: () => string;
  getRebaseFromMainCommand?: () => string;
  getSquashAndRebaseToMainCommand?: () => string;
}

export interface GitErrorDetails {
  title: string;
  message: string;
  command?: string;
  commands?: string[];
  output: string;
  workingDirectory?: string;
  projectPath?: string;
  isRebaseConflict?: boolean;
  hasConflicts?: boolean;
  conflictingFiles?: string[];
  conflictingCommits?: {
    ours: string[];
    theirs: string[];
  };
}

// Import Folder from the proper types file
import type { Folder } from './folder';

export type ContextMenuPayload = Session | Folder;

// Version update info interface
export interface VersionInfo {
  current: string;
  latest: string;
  hasUpdate: boolean;
  releaseUrl?: string;
  releaseNotes?: string;
  downloadUrl?: string;
}

export interface VersionUpdateInfo extends VersionInfo {
  version: string;
  mandatory?: boolean;
}

// Attachment types for Claude Code config
export interface AttachedImage {
  id: string;
  name: string;
  size: number;
  type: string;
  dataUrl: string;
}

export interface AttachedText {
  id: string;
  name: string;
  content: string;
  size: number;
  path?: string;
}
