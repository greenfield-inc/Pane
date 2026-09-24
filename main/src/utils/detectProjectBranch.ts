import { parseWSLPath } from './wslUtils';
import { CommandRunner } from './commandRunner';
import { expandUserRepoPath } from './pathResolver';

export async function detectProjectBranch(
  repoPath: string,
  getProjectMainBranch: (projectPath: string, commandRunner: CommandRunner) => Promise<string>,
): Promise<{ success: true; data: string } | { success: false; error: string }> {
  try {
    const requestedPath = expandUserRepoPath(repoPath);
    const wslInfo = parseWSLPath(requestedPath);
    const tempProject = {
      path: wslInfo ? wslInfo.linuxPath : requestedPath,
      wsl_enabled: !!wslInfo,
      wsl_distribution: wslInfo?.distro ?? null,
    };
    const commandRunner = new CommandRunner(tempProject);
    const branch = await getProjectMainBranch(tempProject.path, commandRunner);
    return { success: true, data: branch };
  } catch (error) {
    console.log('[Main] Could not detect branch:', error);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Could not detect branch',
    };
  }
}
