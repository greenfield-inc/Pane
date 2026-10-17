import { execFileSync } from 'child_process';
import { describe, expect, it } from 'vitest';
import { claudeResumeBase } from './agentIdentity';
import { withSessionFolderAccess } from './sessionFolderAccess';

const claude = { title: 'Claude Code', command: 'claude --dangerously-skip-permissions', agent: 'claude' as const };
const folder = "/Users/me/.pane/sessions/it's-1";

describe('Session folder access', () => {
  it.skipIf(process.platform === 'win32')('gives the built-in Claude template one --settings value that reads but does not edit the folder', () => {
    const { command } = withSessionFolderAccess(claude, folder, 'darwin');
    // The words a POSIX shell passes to the program.
    const tokens = execFileSync('/bin/sh', ['-c', `words() { for word; do printf '%s\\0' "$word"; done; }; words ${command}`], { encoding: 'utf8' })
      .split('\0').slice(0, -1);

    expect(tokens.slice(0, 3)).toEqual(['claude', '--dangerously-skip-permissions', '--settings']);
    expect(JSON.parse(tokens[3] ?? '')).toEqual({
      permissions: {
        additionalDirectories: [folder],
        deny: [`Edit(/${folder}/**)`],
      },
    });
    expect(tokens).toHaveLength(4);
    // Resume drops the launch prompt and keeps the flag: --settings is an operand claudeResumeBase knows.
    expect(claudeResumeBase(`${command} 'Read and follow brief.md'`)).toBe(command);
  });

  it('leaves Codex, wrappers, custom commands and Windows launches unchanged', () => {
    const codex = { title: 'Codex', command: 'codex --yolo', agent: 'codex' as const };
    const wrapped = { ...claude, command: 'agent-farm run claude', launchMode: 'wrapped' as const };
    const custom = { ...claude, command: 'claude --model opus' };

    for (const tool of [codex, wrapped, custom]) expect(withSessionFolderAccess(tool, folder, 'darwin')).toBe(tool);
    expect(withSessionFolderAccess(claude, folder, 'win32')).toBe(claude);
  });
});
