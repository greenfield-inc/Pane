import { describe, expect, it } from 'vitest';
import {
  CLI_AGENT_TYPES,
  isCliAgentType,
  isShellProcessName,
  isVersionedExecutableName,
  resolveAgentTypeFromCommand,
  resolveAgentTypeFromExecutablePath,
  resolveAgentTypeFromProcessName,
} from './agentIdentity';

type CommandClassificationCase = {
  name: string;
  command: string | undefined;
  expected: 'claude' | 'codex' | 'cursor' | 'opencode' | undefined;
  platformHint?: NodeJS.Platform;
};

const COMMAND_CLASSIFICATION_CASES: CommandClassificationCase[] = [
  { name: 'direct Claude command', command: 'claude --dangerously-skip-permissions', expected: 'claude' },
  { name: 'direct Codex command', command: 'codex --yolo', expected: 'codex' },
  { name: 'direct Cursor command', command: 'cursor-agent --force --trust', expected: 'cursor' },
  { name: 'direct OpenCode command', command: 'opencode --auto', expected: 'opencode' },
  { name: 'quoted OpenCode command', command: "'opencode' --auto", expected: 'opencode' },
  {
    name: 'path-qualified OpenCode command',
    command: '/usr/local/bin/opencode --auto',
    expected: 'opencode',
  },
  {
    name: 'POSIX single-quoted path with spaces',
    command: "'/opt/OpenAI tools/codex' --yolo",
    expected: 'codex',
  },
  {
    name: 'POSIX double-quoted path with spaces',
    command: '"/Applications/Cursor Agent.app/Contents/bin/cursor-agent" --force',
    expected: 'cursor',
  },
  {
    name: 'POSIX backslash-escaped space',
    command: String.raw`/opt/Cursor\ Agent/cursor-agent --force`,
    platformHint: 'darwin',
    expected: 'cursor',
  },
  {
    name: 'quoted environment assignment value',
    command: 'FOO="bar baz" cursor-agent --force',
    expected: 'cursor',
  },
  {
    name: 'Windows drive path',
    command: String.raw`C:\Tools\cursor-agent --force`,
    expected: 'cursor',
  },
  {
    name: 'quoted Windows drive path with spaces',
    command: String.raw`"C:\Program Files\Cursor\cursor-agent" --force`,
    expected: 'cursor',
  },
  {
    name: 'quoted Windows executable with a spaced trailing argument',
    command: String.raw`"C:\Program Files\Cursor\cursor-agent" --prompt "review this change"`,
    platformHint: 'win32',
    expected: 'cursor',
  },
  {
    name: 'Windows UNC path',
    command: String.raw`\\server\share\cursor-agent --force`,
    expected: 'cursor',
  },
  {
    name: 'Windows platform hint preserves relative backslash path',
    command: String.raw`Tools\cursor-agent --force`,
    platformHint: 'win32',
    expected: 'cursor',
  },
  { name: 'env short unset option', command: 'env -u FOO cursor-agent --force', expected: 'cursor' },
  { name: 'env attached short unset option', command: 'env -uFOO cursor-agent --force', expected: 'cursor' },
  { name: 'env long unset option', command: 'env --unset FOO cursor-agent --force', expected: 'cursor' },
  { name: 'env attached long unset option', command: 'env --unset=FOO cursor-agent --force', expected: 'cursor' },
  { name: 'env short chdir option', command: 'env -C /tmp cursor-agent --force', expected: 'cursor' },
  { name: 'env attached short chdir option', command: 'env -C/tmp cursor-agent --force', expected: 'cursor' },
  { name: 'env long chdir option', command: 'env --chdir /tmp cursor-agent --force', expected: 'cursor' },
  { name: 'env attached long chdir option', command: 'env --chdir=/tmp cursor-agent --force', expected: 'cursor' },
  { name: 'env alternate path option', command: 'env -P /usr/bin cursor-agent --force', expected: 'cursor' },
  { name: 'env attached alternate path option', command: 'env -P/usr/bin cursor-agent --force', expected: 'cursor' },
  { name: 'env split-string option', command: "env -S 'cursor-agent --force'", expected: 'cursor' },
  { name: 'env attached split-string option', command: "env -S'cursor-agent --force'", expected: 'cursor' },
  {
    name: 'env long split-string option',
    command: "env --split-string 'cursor-agent --force'",
    expected: 'cursor',
  },
  {
    name: 'env attached long split-string option',
    command: "env --split-string='cursor-agent --force'",
    expected: 'cursor',
  },
  { name: 'env ignore-environment flag', command: 'env -i cursor-agent --force', expected: 'cursor' },
  {
    name: 'env long ignore-environment flag',
    command: 'env --ignore-environment cursor-agent --force',
    expected: 'cursor',
  },
  {
    name: 'env assignment followed by command wrapper',
    command: 'env FOO=bar command cursor-agent --force',
    expected: 'cursor',
  },
  {
    name: 'nested wrappers and environment assignment',
    command: 'env -i FOO="bar baz" command exec nohup nice time cursor-agent --force',
    expected: 'cursor',
  },
  {
    name: 'mixed-quote POSIX executable',
    command: `'/opt/Cursor Agent'/"cursor-agent" --force`,
    expected: 'cursor',
  },
  { name: 'nice adjustment wrapper', command: 'nice -n 10 cursor-agent --force', expected: 'cursor' },
  { name: 'sudo preserve-environment wrapper', command: 'sudo -E cursor-agent', expected: 'cursor' },
  { name: 'sudo user wrapper', command: 'sudo -u pane cursor-agent', expected: 'cursor' },
  { name: 'time portable-output wrapper', command: 'time -p cursor-agent', expected: 'cursor' },
  { name: 'Bash login command string', command: "bash -lc 'cursor-agent --force'", expected: 'cursor' },
  {
    name: 'Windows cmd command string',
    command: 'cmd /c cursor-agent',
    platformHint: 'win32',
    expected: 'cursor',
  },
  {
    name: 'PowerShell call operator',
    command: '& cursor-agent',
    platformHint: 'win32',
    expected: 'cursor',
  },
  { name: 'agent-like directory name', command: '/tmp/claude-501/x.sh', expected: undefined },
  { name: 'Claude executable substring', command: 'claude-code-something', expected: undefined },
  { name: 'Cursor executable substring', command: 'mycursor-agent', expected: undefined },
  { name: 'OpenCode executable substring', command: 'my-opencode-wrapper', expected: undefined },
  { name: 'agent name in an argument', command: 'echo cursor-agent', expected: undefined },
  { name: 'shell option without command mode', command: 'bash --norc cursor-agent', expected: undefined },
  { name: 'unterminated single quote', command: "'cursor-agent", expected: undefined },
  { name: 'unterminated double quote', command: '"cursor-agent', expected: undefined },
  { name: 'trailing backslash escape', command: 'cursor-agent --force\\', expected: undefined },
  {
    name: 'unterminated quote inside shell command string',
    command: `bash -c "cursor-agent '"`,
    expected: undefined,
  },
  { name: 'empty command', command: '', expected: undefined },
  { name: 'missing command', command: undefined, expected: undefined },
];

describe('CLI_AGENT_TYPES', () => {
  it('lists the supported agents', () => {
    expect([...CLI_AGENT_TYPES].sort()).toEqual(['claude', 'codex', 'cursor', 'opencode']);
  });
});

describe('isCliAgentType', () => {
  it('accepts known agents and rejects everything else', () => {
    expect(isCliAgentType('claude')).toBe(true);
    expect(isCliAgentType('codex')).toBe(true);
    expect(isCliAgentType('cursor')).toBe(true);
    expect(isCliAgentType('opencode')).toBe(true);
    expect(isCliAgentType('aider')).toBe(false);
    expect(isCliAgentType(undefined)).toBe(false);
    expect(isCliAgentType(null)).toBe(false);
    expect(isCliAgentType(42)).toBe(false);
  });
});

describe('resolveAgentTypeFromCommand', () => {
  it.each(COMMAND_CLASSIFICATION_CASES)('$name', ({ command, platformHint, expected }) => {
    expect(resolveAgentTypeFromCommand(command, platformHint)).toBe(expected);
  });
});

describe('foreground process identity', () => {
  it.each([
    ['claude', 'claude'],
    ['codex', 'codex'],
    ['cursor-agent', 'cursor'],
    ['opencode', 'opencode'],
    ['/usr/local/bin/opencode', 'opencode'],
    ['/usr/local/bin/codex', 'codex'],
    ['codex.exe', 'codex'],
    ['node', undefined],
    ['agent-farm', undefined],
    ['my-opencode-wrapper', undefined],
    ['2.1.283', undefined],
    [undefined, undefined],
  ] as const)('maps process %s to %s', (name, expected) => {
    expect(resolveAgentTypeFromProcessName(name)).toBe(expected);
  });

  it('recognises interactive and login shells, not programs', () => {
    expect(isShellProcessName('zsh')).toBe(true);
    expect(isShellProcessName('-zsh')).toBe(true);
    expect(isShellProcessName('/bin/bash')).toBe(true);
    expect(isShellProcessName('pwsh.exe')).toBe(true);
    expect(isShellProcessName('node')).toBe(false);
    expect(isShellProcessName('claude')).toBe(false);
    expect(isShellProcessName(undefined)).toBe(false);
  });

  it('resolves Claude Code\'s versioned native binary only from its path', () => {
    expect(isVersionedExecutableName('2.1.283')).toBe(true);
    expect(isVersionedExecutableName('1.0.0-beta.2')).toBe(true);
    expect(isVersionedExecutableName('claude')).toBe(false);
    expect(resolveAgentTypeFromExecutablePath('/Users/me/.local/share/claude/versions/2.1.283')).toBe('claude');
    expect(resolveAgentTypeFromExecutablePath('/opt/homebrew/Caskroom/codex/0.157.1/bin/codex')).toBe('codex');
    expect(resolveAgentTypeFromExecutablePath('/Users/me/tools/versions/2.1.283')).toBeUndefined();
    expect(resolveAgentTypeFromExecutablePath(undefined)).toBeUndefined();
  });
});
