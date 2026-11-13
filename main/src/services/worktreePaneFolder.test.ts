import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import { describe, expect, it } from 'vitest';
import { PANE_SCRATCH_FOLDER } from '../../../shared/constants/paneFolders';
import { PaneError } from '../../../shared/paneError';
import { folderUsage, worktreePaneFolder } from './worktreePaneFolder';

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' });

describe('Pane scratch folder', () => {
  it('stays out of git status and reports every byte in it, without following links', async () => {
    const repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pane-scratch-')));
    git(repo, 'init', '-q');
    const folder = await worktreePaneFolder(repo, PANE_SCRATCH_FOLDER, candidate => new PaneError('TEST', candidate, 'none'));
    expect(folder?.directory).toBe(path.join(repo, '.pane', 'scratch'));

    const clone = path.join(folder!.directory, 'clone', 'node_modules', 'pkg');
    fs.mkdirSync(clone, { recursive: true });
    fs.writeFileSync(path.join(folder!.directory, 'report.md'), 'x'.repeat(1000));
    fs.writeFileSync(path.join(clone, 'index.js'), 'y'.repeat(24));
    fs.symlinkSync(path.join(repo, '.git'), path.join(folder!.directory, 'link'));

    expect(git(repo, 'status', '--porcelain', '--untracked-files=all')).toBe('');
    const usage = await folderUsage(folder!.directory);
    expect(usage?.path).toBe(folder!.directory);
    // 1000 + 24 file bytes, plus the link itself (its target path's length).
    expect(usage?.bytes).toBe(1024 + path.join(repo, '.git').length);
    fs.rmSync(repo, { recursive: true, force: true });
  });
});
