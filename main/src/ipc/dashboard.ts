import { IpcMain } from 'electron';
import { formatForDatabase } from '../utils/timestampUtils';
import type { AppServices } from './types';
import fs from 'fs';
import type { CommandRunner } from '../utils/commandRunner';
import type { PathResolver } from '../utils/pathResolver';
import { boundary, decodeBoundary } from '../../../shared/validation/boundaryDecoder';

interface MainBranchStatus {
  status: 'up-to-date' | 'behind' | 'ahead' | 'diverged';
  aheadCount?: number;
  behindCount?: number;
  lastFetched: string;
}

interface SessionBranchInfo {
  sessionId: string;
  sessionName: string;
  branchName: string;
  worktreePath: string;
  baseCommit: string;
  baseBranch: string;
  isStale: boolean;
  staleSince?: string;
  hasUncommittedChanges: boolean;
  pullRequest?: {
    number: number;
    title: string;
    state: 'open' | 'closed' | 'merged';
    url: string;
  };
  commitsAhead: number;
  commitsBehind: number;
}

interface RemoteStatus {
  name: string;
  url: string;
  branch: string;
  status: 'up-to-date' | 'behind' | 'ahead' | 'diverged';
  aheadCount: number;
  behindCount: number;
  isUpstream?: boolean;
  isFork?: boolean;
}

interface ProjectDashboardData {
  projectId: number;
  projectName: string;
  projectPath: string;
  mainBranch: string;
  mainBranchStatus: MainBranchStatus;
  remotes?: RemoteStatus[];
  sessionBranches: SessionBranchInfo[];
  lastRefreshed: string;
}

export function registerDashboardHandlers(ipcMain: IpcMain, services: AppServices) {
  const { databaseService, worktreeManager, sessionManager } = services;

  // Progressive loading handler that streams updates
  ipcMain.handle('dashboard:get-project-status-progressive', async (event, projectId: number) => {
    try {
      // Get project details
      const project = databaseService.getProject(projectId);
      if (!project) {
        return {
          success: false,
          error: 'Project not found'
        };
      }

      const ctx = sessionManager.getProjectContextByProjectId(projectId);
      if (!ctx) {
        return {
          success: false,
          error: 'Failed to get project context'
        };
      }

      // Ensure the project path exists and is a git repository
      const fsPath = ctx.pathResolver.toFileSystem(project.path);
      if (!fs.existsSync(fsPath)) {
        return {
          success: false,
          error: 'Project path does not exist'
        };
      }

      const gitDir = ctx.pathResolver.toFileSystem(project.path + '/.git');
      if (!fs.existsSync(gitDir)) {
        return {
          success: false,
          error: 'Project is not a git repository'
        };
      }

      // Get the main branch name dynamically
      const mainBranch = await worktreeManager.getProjectMainBranch(project.path, ctx.commandRunner);

      // Send initial data immediately
      const initialData: Partial<ProjectDashboardData> = {
        projectId: project.id,
        projectName: project.name,
        projectPath: project.path,
        mainBranch,
        sessionBranches: [],
        lastRefreshed: formatForDatabase()
      };

      // Send initial update
      event.sender.send('dashboard:update', { projectId, data: initialData, isPartial: true });

      // Remote status loading fetches each remote once. Main-branch counts must
      // use the resulting tracking refs, not race that fetch.
      const remotesPromise = getRemoteStatuses(ctx, project.path, mainBranch);
      const mainBranchPromise = remotesPromise.then(() => getMainBranchStatusAsync(ctx, project.path, mainBranch));

      // Get all sessions for this project
      const sessions = databaseService.getAllSessions(projectId);
      const activeSessions = sessions.filter(session => !session.archived);

      // Process sessions in parallel with progressive updates
      const sessionPromises = activeSessions.map(async (session) => {
        try {
          const sessionCtx = sessionManager.getProjectContext(session.id);
          if (!sessionCtx) {
            console.warn(`Failed to get context for session ${session.id}`);
            return null;
          }
          const branchInfo = await getSessionBranchInfoAsync(
            sessionCtx,
            session,
            project.path,
            mainBranch
          );
          if (branchInfo) {
            // Send individual session update
            event.sender.send('dashboard:session-update', {
              projectId,
              session: branchInfo
            });
          }
          return branchInfo;
        } catch (error) {
          console.error(`Failed to get branch info for session ${session.id}:`, error);
          return null;
        }
      });

      // Wait for main branch status and remotes
      const [mainBranchStatus, remotes] = await Promise.all([
        mainBranchPromise,
        remotesPromise
      ]);

      // Send main branch and remotes update
      event.sender.send('dashboard:update', { 
        projectId, 
        data: { 
          mainBranchStatus,
          remotes: remotes.length > 0 ? remotes : undefined
        }, 
        isPartial: true 
      });

      // Wait for all sessions to complete
      const sessionBranches = (await Promise.all(sessionPromises)).filter(result => result !== null);

      // Send final complete data
      const dashboardData: ProjectDashboardData = {
        projectId: project.id,
        projectName: project.name,
        projectPath: project.path,
        mainBranch,
        mainBranchStatus,
        remotes: remotes.length > 0 ? remotes : undefined,
        sessionBranches,
        lastRefreshed: formatForDatabase()
      };

      return {
        success: true,
        data: dashboardData
      };
    } catch (error) {
      console.error('Error getting project dashboard status:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to get project status'
      };
    }
  });

  ipcMain.handle('dashboard:get-project-status', async (_event, projectId: number) => {
    try {
      // Get project details
      const project = databaseService.getProject(projectId);
      if (!project) {
        return {
          success: false,
          error: 'Project not found'
        };
      }

      const ctx = sessionManager.getProjectContextByProjectId(projectId);
      if (!ctx) {
        return {
          success: false,
          error: 'Failed to get project context'
        };
      }

      // Ensure the project path exists and is a git repository
      const fsPath = ctx.pathResolver.toFileSystem(project.path);
      if (!fs.existsSync(fsPath)) {
        return {
          success: false,
          error: 'Project path does not exist'
        };
      }

      const gitDir = ctx.pathResolver.toFileSystem(project.path + '/.git');
      if (!fs.existsSync(gitDir)) {
        return {
          success: false,
          error: 'Project is not a git repository'
        };
      }

      // Fetch latest changes from remote (async to prevent blocking)
      try {
        await ctx.commandRunner.execAsync('git fetch origin', project.path, { timeout: 15000 });
      } catch (error) {
        console.warn('Failed to fetch from origin:', error);
        // Continue anyway - we can still show local status
      }

      // Get the main branch name dynamically
      const mainBranch = await worktreeManager.getProjectMainBranch(project.path, ctx.commandRunner);

      // Get main branch status (async)
      const mainBranchStatus = await getMainBranchStatusAsync(ctx, project.path, mainBranch);

      // Get remote statuses (async)
      const remotes = await getRemoteStatuses(ctx, project.path, mainBranch);

      // Get all sessions for this project
      const sessions = databaseService.getAllSessions(projectId);
      const sessionBranches: SessionBranchInfo[] = [];

      // Process sessions in batches to prevent overwhelming git
      const BATCH_SIZE = 5;
      for (let i = 0; i < sessions.length; i += BATCH_SIZE) {
        const batch = sessions.slice(i, i + BATCH_SIZE);
        const batchPromises = batch
          .filter(session => !session.archived) // Skip archived sessions
          .map(async (session) => {
            try {
              const sessionCtx = sessionManager.getProjectContext(session.id);
              if (!sessionCtx) {
                console.warn(`Failed to get context for session ${session.id}`);
                return null;
              }
              return await getSessionBranchInfoAsync(
                sessionCtx,
                session,
                project.path,
                mainBranch
              );
            } catch (error) {
              console.error(`Failed to get branch info for session ${session.id}:`, error);
              return null;
            }
          });

        const batchResults = await Promise.all(batchPromises);
        sessionBranches.push(...batchResults.filter(result => result !== null));
      }

      const dashboardData: ProjectDashboardData = {
        projectId: project.id,
        projectName: project.name,
        projectPath: project.path,
        mainBranch,
        mainBranchStatus,
        remotes: remotes.length > 0 ? remotes : undefined,
        sessionBranches,
        lastRefreshed: formatForDatabase()
      };

      return {
        success: true,
        data: dashboardData
      };
    } catch (error) {
      console.error('Error getting project dashboard status:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to get project status'
      };
    }
  });
}

async function getRemoteStatuses(
  ctx: { commandRunner: CommandRunner },
  projectPath: string,
  mainBranch: string
): Promise<RemoteStatus[]> {
  try {
    // Get all remotes
    const remotesResult = await ctx.commandRunner.execAsync('git remote -v', projectPath, { timeout: 5000 });
    const remoteLines = remotesResult.stdout.trim().split('\n');

    // Parse unique remotes
    const remotesMap = new Map<string, string>();
    for (const line of remoteLines) {
      const [name, url] = line.split('\t');
      if (name && url && url.includes('(fetch)')) {
        remotesMap.set(name, url.replace(' (fetch)', ''));
      }
    }

    const remoteStatuses: RemoteStatus[] = [];

    // Fetch from all remotes
    for (const [remoteName, remoteUrl] of remotesMap) {
      try {
        await ctx.commandRunner.execAsync(`git fetch ${remoteName}`, projectPath, { timeout: 10000 });
      } catch (error) {
        console.warn(`Failed to fetch from ${remoteName}:`, error);
      }

      // Check if remote branch exists
      try {
        await ctx.commandRunner.execAsync(`git rev-parse --verify ${remoteName}/${mainBranch}`, projectPath, { timeout: 2000 });

        // Get ahead/behind status
        const result = await ctx.commandRunner.execAsync(
          `git rev-list --left-right --count ${mainBranch}...${remoteName}/${mainBranch}`,
          projectPath,
          { timeout: 5000 }
        );
        const [ahead, behind] = result.stdout.trim().split('\t').map((n: string) => parseInt(n, 10));

        let status: RemoteStatus['status'];
        if (ahead === 0 && behind === 0) {
          status = 'up-to-date';
        } else if (ahead > 0 && behind === 0) {
          status = 'ahead';
        } else if (ahead === 0 && behind > 0) {
          status = 'behind';
        } else {
          status = 'diverged';
        }

        // Detect if this is upstream or a fork
        const isUpstream = remoteName === 'upstream' || remoteUrl.includes('/upstream/');
        const isFork = !isUpstream && remoteName === 'origin' && remotesMap.has('upstream');

        remoteStatuses.push({
          name: remoteName,
          url: remoteUrl,
          branch: mainBranch,
          status,
          aheadCount: ahead,
          behindCount: behind,
          isUpstream,
          isFork
        });
      } catch {
        // Remote branch doesn't exist
        console.warn(`Remote branch ${remoteName}/${mainBranch} not found`);
      }
    }

    // Sort remotes: upstream first, then origin, then others
    remoteStatuses.sort((a, b) => {
      if (a.isUpstream) return -1;
      if (b.isUpstream) return 1;
      if (a.name === 'origin') return -1;
      if (b.name === 'origin') return 1;
      return a.name.localeCompare(b.name);
    });

    return remoteStatuses;
  } catch (error) {
    console.error('Error getting remote statuses:', error);
    return [];
  }
}

async function getMainBranchStatusAsync(
  ctx: { commandRunner: CommandRunner },
  projectPath: string,
  mainBranch: string
): Promise<MainBranchStatus> {
  try {
    // Check if we have a remote tracking branch
    const remoteBranch = `origin/${mainBranch}`;

    // Check if remote branch exists
    try {
      await ctx.commandRunner.execAsync(`git rev-parse --verify ${remoteBranch}`, projectPath, { timeout: 5000 });
    } catch {
      // No remote branch
      return {
        status: 'up-to-date',
        lastFetched: formatForDatabase()
      };
    }

    // Get commit counts
    const result = await ctx.commandRunner.execAsync(
      `git rev-list --left-right --count ${mainBranch}...${remoteBranch}`,
      projectPath,
      { timeout: 5000 }
    );
    const aheadBehind = result.stdout.trim();

    const [ahead, behind] = aheadBehind.split('\t').map((n: string) => parseInt(n, 10));

    let status: MainBranchStatus['status'];
    if (ahead === 0 && behind === 0) {
      status = 'up-to-date';
    } else if (ahead > 0 && behind === 0) {
      status = 'ahead';
    } else if (ahead === 0 && behind > 0) {
      status = 'behind';
    } else {
      status = 'diverged';
    }

    return {
      status,
      aheadCount: ahead || undefined,
      behindCount: behind || undefined,
      lastFetched: formatForDatabase()
    };
  } catch (error) {
    console.error('Error getting main branch status:', error);
    return {
      status: 'up-to-date',
      lastFetched: formatForDatabase()
    };
  }
}

async function getSessionBranchInfoAsync(
  ctx: { commandRunner: CommandRunner; pathResolver: PathResolver },
  session: { id: string; name: string; worktree_path: string; base_commit?: string; base_branch?: string },
  projectPath: string,
  mainBranch: string
): Promise<SessionBranchInfo | null> {
  try {
    // Check if worktree still exists
    const worktreeFsPath = ctx.pathResolver.toFileSystem(session.worktree_path);
    if (!fs.existsSync(worktreeFsPath)) {
      return null;
    }

    // Get the branch name from the worktree
    const branchResult = await ctx.commandRunner.execAsync('git branch --show-current', session.worktree_path, { timeout: 5000 });
    const branchName = branchResult.stdout.trim();

    if (!branchName) {
      return null;
    }

    // Get the base commit this branch was created from
    // This is stored in the session metadata or we can infer it
    let baseCommit: string;
    if (session.base_commit) {
      baseCommit = session.base_commit;
    } else {
      // Try to find the merge-base with main
      try {
        const mergeBaseResult = await ctx.commandRunner.execAsync(
          `git merge-base ${branchName} ${mainBranch}`,
          session.worktree_path,
          { timeout: 5000 }
        );
        baseCommit = mergeBaseResult.stdout.trim();
      } catch {
        baseCommit = 'unknown';
      }
    }
    const baseBranch = session.base_branch || mainBranch;

    // Check if base branch has moved (session is stale)
    let isStale = false;
    let staleSince: string | undefined;

    if (baseCommit && baseCommit !== 'unknown') {
      try {
        const currentBaseResult = await ctx.commandRunner.execAsync(
          `git rev-parse ${baseBranch}`,
          projectPath,
          { timeout: 5000 }
        );
        const currentBaseCommit = currentBaseResult.stdout.trim();

        isStale = currentBaseCommit !== baseCommit;

        if (isStale) {
          // Try to get the timestamp when the base branch moved
          const commitDateResult = await ctx.commandRunner.execAsync(
            `git log -1 --format=%cd --date=iso-strict ${currentBaseCommit}`,
            projectPath,
            { timeout: 5000 }
          );
          staleSince = commitDateResult.stdout.trim();
        }
      } catch {
        // Ignore errors
      }
    }

    // Check for uncommitted changes (async)
    const hasUncommittedChanges = await checkUncommittedChangesAsync(ctx, session.worktree_path);

    // Get commits ahead/behind
    let commitsAhead = 0;
    let commitsBehind = 0;

    try {
      const aheadBehindResult = await ctx.commandRunner.execAsync(
        `git rev-list --left-right --count ${branchName}...${baseBranch}`,
        session.worktree_path,
        { timeout: 5000 }
      );
      const aheadBehind = aheadBehindResult.stdout.trim();

      const [ahead, behind] = aheadBehind.split('\t').map((n: string) => parseInt(n, 10));
      commitsAhead = ahead;
      commitsBehind = behind;
    } catch {
      // Ignore errors
    }

    // Check for associated pull request (async)
    let pullRequest: SessionBranchInfo['pullRequest'];
    try {
      const prResult = await ctx.commandRunner.execAsync(
        `gh pr list --head ${branchName} --state all --json number,title,state,url --limit 1`,
        projectPath,
        { timeout: 10000 }
      );
      const prOutput = prResult.stdout.trim();

      if (prOutput) {
        const prs = decodeBoundary(JSON.parse(prOutput), boundary.array(boundary.object({
          number: boundary.number,
          title: boundary.string,
          state: boundary.enumeration('OPEN', 'CLOSED', 'MERGED'),
          url: boundary.string,
        })));
        if (prs.length > 0) {
          const pr = prs[0];
          pullRequest = {
            number: pr.number,
            title: pr.title,
            state: pr.state === 'OPEN' ? 'open' : pr.state === 'CLOSED' ? 'closed' : 'merged',
            url: pr.url
          };
        }
      }
    } catch {
      // gh command might not be available or configured
    }

    return {
      sessionId: session.id,
      sessionName: session.name,
      branchName,
      worktreePath: session.worktree_path,
      baseCommit,
      baseBranch,
      isStale,
      staleSince,
      hasUncommittedChanges,
      pullRequest,
      commitsAhead,
      commitsBehind
    };
  } catch (error) {
    console.error(`Error getting branch info for session ${session.id}:`, error);
    return null;
  }
}

async function checkUncommittedChangesAsync(
  ctx: { commandRunner: CommandRunner },
  worktreePath: string
): Promise<boolean> {
  try {
    const result = await ctx.commandRunner.execAsync('git status --porcelain', worktreePath, { timeout: 5000 });
    return result.stdout.trim().length > 0;
  } catch {
    return false;
  }
}
