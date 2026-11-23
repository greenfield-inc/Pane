import { execFileSync } from 'child_process';
import { mkdtemp, rm } from 'fs/promises';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cloneRepoOf } from './paneCloudRepo';

let dir: string;
const git = (...args: string[]) => execFileSync('git', ['-C', dir, ...args], { stdio: 'ignore' });

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'pane-cloud-repo-'));
  git('init', '--quiet', '--initial-branch=main');
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('the repo a new cloud Session clones', () => {
  it('is the project\'s origin over https, on the branch it has checked out', async () => {
    git('remote', 'add', 'origin', 'git@github.com:greenfield-inc/Pane.git');
    git('checkout', '--quiet', '-b', 'docs/v3-migration');
    expect(await cloneRepoOf(dir)).toEqual({ url: 'https://github.com/greenfield-inc/Pane', branch: 'docs/v3-migration' });
  });

  it('is none for a project with no origin, or a local one', async () => {
    expect(await cloneRepoOf(dir)).toBeNull();
    git('remote', 'add', 'origin', '/srv/git/site.git');
    expect(await cloneRepoOf(dir)).toBeNull();
  });
});
