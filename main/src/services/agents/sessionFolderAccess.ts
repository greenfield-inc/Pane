import { RUNPANE_CONTRACT } from '../../../../shared/types/generatedRunpaneContract';
import type { RunpaneResolvedTool } from '../../../../shared/types/runpaneOrchestration';

/**
 * Claude Code settings that make a Session folder readable but not editable.
 * `additionalDirectories` makes it a working directory, so reads pass
 * `permissions.blockReadsOutsideWorkingDirectories` (an `allow` rule alone does
 * not); the `Edit` deny rule takes back the write access a working directory
 * gets (Claude Code applies `Edit` rules to every file-editing tool and ignores
 * `Write` path rules).
 * A single `--settings` value, unlike the variadic `--add-dir`, cannot swallow a
 * launch prompt argument and keeps `claudeResumeBase` able to parse the command.
 */
function claudeSessionFolderSettings(folder: string): string {
  const rulePath = `/${folder.replace(/\/+$/u, '')}/**`;
  return JSON.stringify({
    permissions: {
      additionalDirectories: [folder],
      deny: [`Edit(${rulePath})`],
    },
  });
}

/**
 * The tool with read access to its Pane's Session folder, when Pane can grant it
 * through the agent's own flags. Only Claude Code's built-in template on macOS
 * and Linux gets a flag: Codex's built-in template runs without a sandbox, and
 * every Codex sandbox mode reads the whole disk (its `--add-dir` grants writes).
 * Wrapper and custom commands own their flags; they get only `PANE_SESSION_DIR`.
 */
export function withSessionFolderAccess(
  tool: RunpaneResolvedTool,
  folder: string,
  platform: NodeJS.Platform = process.platform,
): RunpaneResolvedTool {
  if (platform === 'win32' || tool.agent !== 'claude' || tool.launchMode || tool.command !== RUNPANE_CONTRACT.agentTemplates.claude.command) {
    return tool;
  }
  const quoted = `'${claudeSessionFolderSettings(folder).replace(/'/gu, `'\\''`)}'`;
  return { ...tool, command: `${tool.command} --settings ${quoted}` };
}
