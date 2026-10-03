import type { DatabaseService } from '../database/database';
import type { ConfigManager } from '../services/configManager';
import type { SessionManager } from '../services/sessionManager';
import type { WorktreeManager } from '../services/worktreeManager';
import type { CliManagerFactory } from '../services/cliManagerFactory';
import type { AbstractCliManager } from '../services/panels/cli/AbstractCliManager';
import type { GitDiffManager } from '../services/gitDiffManager';
import type { GitStatusManager } from '../services/gitStatusManager';
import type { ExecutionTracker } from '../services/executionTracker';
import type { WorktreeNameGenerator } from '../services/worktreeNameGenerator';
import type { RunCommandManager } from '../services/runCommandManager';
import type { VersionChecker } from '../services/versionChecker';
import type { Logger } from '../utils/logger';
import type { ArchiveProgressManager } from '../services/archiveProgressManager';
import type { SkillCacheManager } from '../services/skillCacheManager';
import type { PaneChatManager } from '../services/paneChatManager';
import type { OrchestrationSessionManager } from '../services/orchestrationSessionManager';

/**
 * Daemon-neutral service graph. Electron-only dependencies are intentionally
 * excluded so the same runtime can later be hosted by a headless daemon.
 */
export interface CoreServices {
  configManager: ConfigManager;
  databaseService: DatabaseService;
  sessionManager: SessionManager;
  worktreeManager: WorktreeManager;
  cliManagerFactory: CliManagerFactory;
  claudeCodeManager: AbstractCliManager;
  gitDiffManager: GitDiffManager;
  gitStatusManager: GitStatusManager;
  executionTracker: ExecutionTracker;
  worktreeNameGenerator: WorktreeNameGenerator;
  runCommandManager: RunCommandManager;
  versionChecker: VersionChecker;
  logger: Logger;
  archiveProgressManager: ArchiveProgressManager;
  skillCacheManager: SkillCacheManager;
  paneChatManager: PaneChatManager;
  orchestrationSessionManager: OrchestrationSessionManager;
}
