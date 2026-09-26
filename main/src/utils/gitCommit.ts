import type { AppConfig } from '../types/config';
import { getGitAttributionEnv } from './attribution';
import type { CommandRunner } from './commandRunner';
import type { ExecFileResult } from './commandExecutor';

/** Pass commit text as one argument, including real newlines, on native and WSL Git. */
export function commitGitMessage(
  commandRunner: CommandRunner,
  cwd: string,
  message: string,
  config: AppConfig | null | undefined,
  options: { timeout?: number; allowEmpty?: boolean } = {},
): Promise<ExecFileResult> {
  const fullMessage = config?.enableCommitFooter === false
    ? message
    : `${message}\n\nCo-Authored-By: Pane <runpane@users.noreply.github.com>`;
  return commandRunner.execFile('git', [
    'commit', '-m', fullMessage, ...(options.allowEmpty ? ['--allow-empty'] : []),
  ], cwd, { timeout: options.timeout, env: getGitAttributionEnv(config) });
}
