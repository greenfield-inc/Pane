import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { forgetCopies, KEPT_COPY_MAX_BYTES, keepCopy, keptCopy } from './todoFileCopies';

describe('to-do file copies (T-21)', () => {
  let dir: string;
  let root: string;
  let worktree: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'todo-copies-'));
    root = path.join(dir, 'pane', 'todos', 'files');
    worktree = path.join(dir, 'worktree');
    fs.mkdirSync(worktree, { recursive: true });
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('keeps a copy that still reads after the original is deleted', () => {
    const file = path.join(worktree, 't1-findings.md');
    fs.writeFileSync(file, '# Findings\nroot cause');
    expect(keepCopy(root, 1, 7, file)).toBe('kept');
    fs.rmSync(worktree, { recursive: true });
    const copy = keptCopy(root, 1, 7, file);
    expect(copy).not.toBeNull();
    expect(fs.readFileSync(copy ?? '', 'utf8')).toBe('# Findings\nroot cause');
  });

  it('refreshes the copy only when the original changed', () => {
    const file = path.join(worktree, 'plan.md');
    fs.writeFileSync(file, 'v1');
    expect(keepCopy(root, 1, 3, file)).toBe('kept');
    expect(keepCopy(root, 1, 3, file)).toBe('current');
    fs.writeFileSync(file, 'version 2');
    fs.utimesSync(file, new Date(), new Date(Date.now() + 5_000));
    expect(keepCopy(root, 1, 3, file)).toBe('kept');
    expect(fs.readFileSync(keptCopy(root, 1, 3, file) ?? '', 'utf8')).toBe('version 2');
  });

  it('keeps no copy of a folder, a missing file or one over the size limit', () => {
    expect(keepCopy(root, 1, 1, worktree)).toBe('not-a-file');
    expect(keepCopy(root, 1, 2, path.join(worktree, 'gone.md'))).toBe('not-a-file');
    const big = path.join(worktree, 'big.bin');
    fs.writeFileSync(big, '');
    fs.truncateSync(big, KEPT_COPY_MAX_BYTES + 1);
    expect(keepCopy(root, 1, 4, big)).toBe('too-large');
    expect(keptCopy(root, 1, 4, big)).toBeNull();
  });

  it('forgets a pruned to-do\'s copies and no other', () => {
    const file = path.join(worktree, 'a.md');
    fs.writeFileSync(file, 'a');
    keepCopy(root, 1, 1, file);
    keepCopy(root, 2, 2, file);
    forgetCopies(root, [1]);
    expect(keptCopy(root, 1, 1, file)).toBeNull();
    expect(keptCopy(root, 2, 2, file)).not.toBeNull();
  });
});
