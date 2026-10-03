import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { buildAgentShellCommand } from './agentShellCommand';

describe('agent shell invocation', () => {
  it.runIf(process.platform !== 'win32')('preserves arbitrary prompt argv through a real noninteractive POSIX shell', () => {
    const prompt = 'Quotes \' " \\ and $(echo injected); `echo injected`\nremain prompt text';
    const command = buildAgentShellCommand({
      executable: process.execPath,
      args: ['-e', 'process.stdout.write(JSON.stringify(process.argv.slice(1)))', prompt],
    });
    const output = execFileSync('sh', ['-c', command], { encoding: 'utf8' });
    expect(JSON.parse(output)).toEqual([prompt]);
  });

  it('uses PowerShell literal invocation for executable paths and prompt arguments', () => {
    const command = buildAgentShellCommand({ executable: 'C:\\Users\\My Name\\claude.exe', args: ["don't expand $HOME; whoami"] }, true);
    expect(command).toBe("$ErrorActionPreference = 'Stop'; & 'C:\\Users\\My Name\\claude.exe' 'don''t expand $HOME; whoami'; exit $LASTEXITCODE");
  });
});
