import { describe, expect, it } from 'vitest';
import { parseRunpaneArgs } from '../../../packages/runpane/src/commands';
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
});
