import os from 'os';
import path from 'path';
import { describe, expect, it, vi } from 'vitest';
import { detectProjectBranch } from './detectProjectBranch';

describe('detectProjectBranch', () => {
  it('returns success false instead of a fake main branch when detection fails', async () => {
    const getProjectMainBranch = vi.fn(async () => {
      throw new Error('Failed to get main branch for project at /missing: not a git repository');
    });

    const result = await detectProjectBranch('/missing', getProjectMainBranch);

    expect(result).toEqual({
      success: false,
      error: 'Failed to get main branch for project at /missing: not a git repository',
    });
    expect(result).not.toMatchObject({ data: 'main' });
  });

  it('expands a tilde path before asking git for the current branch', async () => {
    const getProjectMainBranch = vi.fn(async () => 'develop');
    const relativeHomePath = 'pane-detect-branch-tilde-test';

    const result = await detectProjectBranch(`~/${relativeHomePath}`, getProjectMainBranch);

    expect(result).toEqual({ success: true, data: 'develop' });
    expect(getProjectMainBranch).toHaveBeenCalledWith(
      path.resolve(os.homedir(), relativeHomePath),
      expect.anything(),
    );
  });

  it('keeps WSL UNC paths intact and detects against the linux path', async () => {
    const getProjectMainBranch = vi.fn(async () => 'main');

    const result = await detectProjectBranch(
      '\\\\wsl.localhost\\Ubuntu\\home\\user\\repo',
      getProjectMainBranch,
    );

    expect(result).toEqual({ success: true, data: 'main' });
    expect(getProjectMainBranch).toHaveBeenCalledWith('/home/user/repo', expect.anything());
  });
});
