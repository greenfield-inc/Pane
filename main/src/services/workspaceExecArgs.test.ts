import { describe, expect, it } from 'vitest';
import { parseRunpaneArgs, wantsJsonOutput } from '../../../packages/runpane/src/commands';
describe('runpane workspace exec arguments', () => {
  it('takes everything after -- as the command', () => {
    expect(parseRunpaneArgs(['workspace', 'box', 'exec', '--cwd', '~/repo', '--json', '--', 'runpane', 'version', '--json']))
      .toMatchObject({ workspaceMachine: 'box', cwd: '~/repo', json: true, execCommand: ['runpane', 'version', '--json'] });
  });
  // PowerShell drops `--` before a .ps1 shim (npm's runpane.ps1) sees it.
  it('takes the command from its first word when -- is missing', () => {
    expect(parseRunpaneArgs(['workspace', 'box', 'exec', '--cwd', '~/repo', 'runpane', 'update', '--json']))
      .toMatchObject({ workspaceMachine: 'box', cwd: '~/repo', json: false, execCommand: ['runpane', 'update', '--json'] });
    expect(parseRunpaneArgs(['workspace', 'box', 'exec', '--cwd=~/repo', 'ls', '-la'])).toMatchObject({ cwd: '~/repo', execCommand: ['ls', '-la'] });
  });
  it('prints its own errors as JSON only when --json is runpane\'s, not the command\'s', () => {
    expect(wantsJsonOutput(['workspace', 'box', 'exec', '--cwd', '/missing', 'echo', '--json'])).toBe(false);
    expect(wantsJsonOutput(['workspace', 'box', 'exec', '--json', 'echo', 'hi'])).toBe(true);
    expect(wantsJsonOutput(['workspace', 'box', 'exec', '--', 'echo', '--json'])).toBe(false);
    // An unparseable line still honors a --json before any --.
    expect(wantsJsonOutput(['no-such-command', '--json'])).toBe(true);
  });
});
