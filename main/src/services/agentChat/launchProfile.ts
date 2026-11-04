import { tokenizeShellCommand } from '../agents/agentIdentity';

export interface CodexChatProfile { executable: string; configArgs: string[]; configProfile?: string; embedded?: boolean; remote?: string; authTokenEnv?: string }

/** Keep arbitrary -c values in the provider's own parser. Explicit native CLI
 * switches map to native configuration keys, never ACP permission presets. */
export function codexChatProfile(command: string, platform: NodeJS.Platform = process.platform): CodexChatProfile | undefined {
  const tokens = tokenizeShellCommand(command, platform);
  const executable = platform === 'win32' ? /(?:^|[\\/])codex(?:\.exe|\.cmd|\.bat)?$/i : /(?:^|\/)codex$/;
  if (!tokens?.length || !executable.test(tokens[0])) return;
  const result: CodexChatProfile = { executable: tokens[0], configArgs: [] };
  const set = (key: string, value: string) => result.configArgs.push('--config', `${key}=${JSON.stringify(value)}`);
  for (let index = 1; index < tokens.length; index++) {
    const token = tokens[index];
    if (token === '--no-daemon') { result.embedded = true; continue; }
    if (token === '--no-alt-screen') continue;
    if (token === '--yolo' || token === '--dangerously-bypass-approvals-and-sandbox') { set('approval_policy', 'never'); set('sandbox_mode', 'danger-full-access'); continue; }
    if (token === '--full-auto') { set('approval_policy', 'on-request'); set('sandbox_mode', 'workspace-write'); continue; }
    const value = tokens[++index];
    if (!value || value.startsWith('-')) return;
    if (token === '-c' || token === '--config') result.configArgs.push('--config', value);
    else if (token === '-m' || token === '--model') set('model', value);
    else if (token === '-p' || token === '--profile') result.configProfile = value;
    else if (token === '-s' || token === '--sandbox') set('sandbox_mode', value);
    else if (token === '-a' || token === '--ask-for-approval') set('approval_policy', value);
    else if (token === '--enable' || token === '--disable') result.configArgs.push('--config', `features.${value}=${token === '--enable'}`);
    else if (token === '--remote') result.remote = value;
    else if (token === '--remote-auth-token-env') result.authTokenEnv = value;
    else return;
  }
  return result;
}

export interface ClaudeChatProfile {
  executable: string;
  model?: string;
  effort?: string;
  permissionMode?: string;
  additionalDirectories?: string[];
  strictMcpConfig: boolean;
}

/** Only options whose semantics have a verified ACP mapping are eligible.
 * Unknown flags, wrappers and shell programs retain their native behavior. */
export function claudeChatProfile(command: string, platform: NodeJS.Platform = process.platform): ClaudeChatProfile | undefined {
  const tokens = tokenizeShellCommand(command, platform);
  const executablePattern = platform === 'win32' ? /(?:^|[\\/])claude(?:\.exe|\.cmd|\.bat)?$/i : /(?:^|\/)claude$/;
  if (!tokens?.length || !executablePattern.test(tokens[0])) return;
  const result: ClaudeChatProfile = { executable: tokens[0], strictMcpConfig: false };
  for (let index = 1; index < tokens.length; index++) {
    const token = tokens[index];
    if (token === '--dangerously-skip-permissions') result.permissionMode = 'bypassPermissions';
    else if (token === '--strict-mcp-config') result.strictMcpConfig = true;
    else if (['--model', '--effort', '--permission-mode', '--add-dir'].includes(token)) {
      const value = tokens[++index];
      if (!value || value.startsWith('-')) return;
      if (token === '--add-dir') (result.additionalDirectories ??= []).push(value);
      if (token === '--model') result.model = value;
      if (token === '--effort') result.effort = value;
      if (token === '--permission-mode') result.permissionMode = value;
    } else return;
  }
  return result;
}
