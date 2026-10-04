import { describe, expect, it, vi } from 'vitest';
import type { CommandRunner } from './commandRunner';
import type { ExecFileResult } from './commandExecutor';
import { describeGitFailure, readGitIdentity, writeGitIdentity } from './gitIdentity';

const IDENTITY_STDERR = [
  'Author identity unknown',
  '',
  '*** Please tell me who you are.',
  '',
  'Run',
  '',
  '  git config --global user.email "you@example.com"',
  '  git config --global user.name "Your Name"',
  '',
  "to set your account's default identity.",
  'Omit --global to set the identity only in this repository.',
  '',
  'fatal: empty ident name (for <khaza@devbox.localdomain>) not allowed',
].join('\n');

function execFailure(stderr: string): Error & { stderr: string; code: number } {
  const error = new Error(
    `Command failed: wsl.exe -d Ubuntu -- bash -c cd '/home/me/repo' && 'git' 'commit' '-m' 'Title'\n${stderr}`,
  );
  return Object.assign(error, { stderr, code: 128 });
}

function gitRunner(outputs: Record<string, ExecFileResult>) {
  const execFile = vi.fn<CommandRunner['execFile']>(async (_file, args) => {
    const result = outputs[args.join(' ')];
    if (!result) throw new Error(`Unexpected git ${args.join(' ')}`);
    return result;
  });
  return { runner: { execFile }, execFile };
}

const ok = (stdout: string): ExecFileResult => ({ stdout, stderr: '', exitCode: 0 });
const exit = (exitCode: number): ExecFileResult => ({ stdout: '', stderr: '', exitCode });

describe('readGitIdentity', () => {
  it('reports a missing identity when git cannot build an author ident', async () => {
    const { runner } = gitRunner({
      'var GIT_AUTHOR_IDENT': exit(128),
      'config user.name': exit(1),
      'config user.email': ok('me@example.com\n'),
    });

    await expect(readGitIdentity(runner, '/repo')).resolves.toEqual({
      configured: false,
      name: '',
      email: 'me@example.com',
    });
  });

  it('reports a configured identity', async () => {
    const { runner } = gitRunner({
      'var GIT_AUTHOR_IDENT': ok('Me <me@example.com> 1700000000 +0000\n'),
      'config user.name': ok('Me\n'),
      'config user.email': ok('me@example.com\n'),
    });

    await expect(readGitIdentity(runner, '/repo')).resolves.toEqual({
      configured: true,
      name: 'Me',
      email: 'me@example.com',
    });
  });
});

describe('writeGitIdentity', () => {
  it('writes trimmed values globally or to the repository', async () => {
    const { runner, execFile } = gitRunner({
      'config --global user.name Me': ok(''),
      'config --global user.email me@example.com': ok(''),
      'config --local user.name Me': ok(''),
      'config --local user.email me@example.com': ok(''),
    });

    await writeGitIdentity(runner, '/repo', { name: ' Me ', email: ' me@example.com ', scope: 'global' });
    await writeGitIdentity(runner, '/repo', { name: 'Me', email: 'me@example.com', scope: 'local' });

    expect(execFile.mock.calls.map(([, args]) => args.join(' '))).toEqual([
      'config --global user.name Me',
      'config --global user.email me@example.com',
      'config --local user.name Me',
      'config --local user.email me@example.com',
    ]);
  });

  it('rejects an empty name or an email without @', async () => {
    const { runner, execFile } = gitRunner({});

    await expect(writeGitIdentity(runner, '/repo', { name: ' ', email: 'me@example.com', scope: 'global' }))
      .rejects.toThrow('name');
    await expect(writeGitIdentity(runner, '/repo', { name: 'Me', email: 'nope', scope: 'global' }))
      .rejects.toThrow('email');
    expect(execFile).not.toHaveBeenCalled();
  });
});

describe('describeGitFailure', () => {
  it('summarizes a missing identity without the command line', () => {
    const failure = describeGitFailure(execFailure(IDENTITY_STDERR));

    expect(failure.identityMissing).toBe(true);
    expect(failure.message).toBe('empty ident name (for <khaza@devbox.localdomain>) not allowed');
    expect(failure.message).not.toContain('wsl.exe');
    expect(failure.details).toContain('wsl.exe');
    expect(failure.details).toContain('Author identity unknown');
  });

  it('uses the last fatal or error line for other failures', () => {
    const failure = describeGitFailure(execFailure('hint: something\nerror: pathspec did not match\nfatal: unable to commit'));

    expect(failure).toMatchObject({ identityMissing: false, message: 'unable to commit' });
  });

  it('falls back to the error message when git wrote no stderr', () => {
    expect(describeGitFailure(new Error('spawn wsl.exe ENOENT'))).toEqual({
      identityMissing: false,
      message: 'spawn wsl.exe ENOENT',
      details: 'spawn wsl.exe ENOENT',
    });
  });
});
