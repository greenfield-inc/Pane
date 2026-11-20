import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { arrivingPreview, type MovedRoot } from './filePreviews';
import type { MoveTab } from './manifest';

const tab = (currentUrl: string, type = 'browser'): MoveTab => ({
  id: 't', type, title: 'page.html', metadata: {}, state: { currentUrl }, working: false, interrupted: false, running: false,
});

describe('arrivingPreview', () => {
  let root: string;
  let worktree: string;
  const roots = (files: string[]): MovedRoot[] => [{ from: '/a/worktrees/p1', to: worktree, files: new Set(files) }];

  beforeEach(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pane-file-previews-')));
    worktree = path.join(root, 'worktrees', 'p1');
    fs.mkdirSync(worktree, { recursive: true });
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it('leaves tabs that are not file previews to the usual path', async () => {
    expect(await arrivingPreview(tab('https://example.invalid/'), roots([]), 'A')).toBeNull();
    expect(await arrivingPreview(tab('file:///a/worktrees/p1/x', 'terminal'), roots(['x']), 'A')).toBeNull();
  });

  it('never carries a moved file that links outside what moved', async () => {
    fs.writeFileSync(path.join(root, 'secret.html'), 'x');
    fs.symlinkSync(path.join(root, 'secret.html'), path.join(worktree, 'page.html'));
    expect(await arrivingPreview(tab('file:///a/worktrees/p1/page.html'), roots(['page.html']), 'A')).toEqual({
      kind: 'notCarried', note: 'page.html (/a/worktrees/p1/page.html): not carried, the file links outside the Session\'s worktrees and folder',
    });
  });

  it('never carries a file that is here but did not come with the move', async () => {
    fs.writeFileSync(path.join(worktree, 'page.html'), 'made here');
    expect(await arrivingPreview(tab('file:///a/worktrees/p1/page.html'), roots([]), 'A')).toMatchObject({ kind: 'notCarried' });
  });

  it('never carries the placed folder itself, only a file in it', async () => {
    expect(await arrivingPreview(tab('file:///a/worktrees/p1'), roots(['']), 'A')).toMatchObject({ kind: 'notCarried' });
  });
});
