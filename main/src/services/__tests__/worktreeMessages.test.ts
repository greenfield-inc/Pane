import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { WorktreeManager } from '../worktreeManager';
import { ConfigManager } from '../configManager';
import { CommandRunner } from '../../utils/commandRunner';

let repo: string;
let runner: CommandRunner;

beforeEach(async () => {
  for (const key of ['GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL']) {
    vi.stubEnv(key, undefined);
  }
  repo = await mkdtemp(join(tmpdir(), 'pane-git-messages-'));
  runner = new CommandRunner({ path: repo });
  await runner.execFile('git', ['init', '--initial-branch=main'], repo);
  await runner.execFile('git', ['config', 'user.name', 'Test User'], repo);
  await runner.execFile('git', ['config', 'user.email', 'test@example.com'], repo);
  await runner.execFile('git', ['config', 'commit.gpgsign', 'false'], repo);
  await writeFile(join(repo, 'example.txt'), 'first\n');
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(repo, { recursive: true, force: true });
});

describe('worktree Git messages', () => {
  it('preserves shell characters and multiline commit text with the default Pane footer', async () => {
    await new WorktreeManager().gitStageAllAndCommit(
      repo,
      'Fix `printf injected` and $(printf replaced) $HOME "quotes"\n\nKeep C:\\new\\file and apostrophe\'s text.',
      runner,
    );
    const { stdout } = await runner.execFile('git', ['log', '-1', '--format=%B'], repo);
    expect(stdout.trimEnd()).toBe(
      'Fix `printf injected` and $(printf replaced) $HOME "quotes"\n\nKeep C:\\new\\file and apostrophe\'s text.\n\nCo-Authored-By: Pane <runpane@users.noreply.github.com>',
    );
  });

  it('preserves shell characters in stash names', async () => {
    const manager = new WorktreeManager();
    await manager.gitStageAllAndCommit(repo, 'Initial content', runner);
    await writeFile(join(repo, 'example.txt'), 'changed\n');
    await manager.gitStash(repo, 'Save `printf injected` $(printf replaced) $HOME "quotes"', runner);
    const { stdout } = await runner.execFile('git', ['log', '-1', '--format=%B', 'refs/stash'], repo);
    expect(stdout.trimEnd()).toBe('On main: Save `printf injected` $(printf replaced) $HOME "quotes"');
  });

  it('omits the footer and Pane committer when those settings are disabled', async () => {
    const configManager = new ConfigManager();
    await configManager.updateConfig({ enableCommitFooter: false, gitAttributionEnabled: false });
    await new WorktreeManager(configManager).gitStageAllAndCommit(repo, 'User title\n\nUser body', runner);
    const { stdout } = await runner.execFile('git', ['log', '-1', '--format=%cn <%ce>%n%B'], repo);
    expect(stdout.trimEnd()).toBe('Test User <test@example.com>\nUser title\n\nUser body');
  });

  it('keeps the requested squash message when merging a feature worktree', async () => {
    const manager = new WorktreeManager();
    await manager.gitStageAllAndCommit(repo, 'Initial content', runner);
    const worktree = await mkdtemp(join(tmpdir(), 'pane-squash-messages-'));
    try {
      await runner.execFile('git', ['worktree', 'add', '-b', 'feature', worktree], repo);
      await writeFile(join(worktree, 'example.txt'), 'feature\n');
      await manager.gitStageAllAndCommit(worktree, 'Feature change', runner);
      await manager.squashAndMergeWorktreeToMain(
        repo, worktree, 'main', 'Squash `printf injected` $HOME\n\nRequested body', runner,
      );
      const { stdout } = await runner.execFile('git', ['log', '-1', '--format=%B', 'main'], repo);
      expect(stdout.trimEnd()).toBe(
        'Squash `printf injected` $HOME\n\nRequested body\n\nCo-Authored-By: Pane <runpane@users.noreply.github.com>',
      );
    } finally {
      await rm(worktree, { recursive: true, force: true });
    }
  });

});
