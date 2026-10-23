import path from 'path';
import { quoteShellWord } from '../agents/shellWord';

/** Construct settings from the current journal path on every acquisition. */
export function nativeChatHookSettings(journalFile: string, platform: NodeJS.Platform = process.platform) {
  // Hooks use their declared provider shell, independent of the tab's shell.
  const shell = platform === 'win32' ? 'powershell' : 'bash';
  const invocation = [process.execPath, path.join(__dirname, 'hookWriter.js'), journalFile].map(value => quoteShellWord(value, shell)).join(' ');
  const command = shell === 'powershell' ? `$env:ELECTRON_RUN_AS_NODE='1'; & ${invocation}` : `ELECTRON_RUN_AS_NODE=1 ${invocation}`;
  return { hooks: Object.fromEntries(['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PermissionRequest', 'Stop', 'SessionEnd'].map(name => [name, [{ hooks: [{ type: 'command', command, shell, timeout: 5 }] }]])) };
}
