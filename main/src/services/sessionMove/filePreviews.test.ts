import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { arrivingPreview } from './filePreviews';
import { buildPathMap } from './pathMap';
import type { MoveTab } from './manifest';

const tab = (currentUrl: string, type = 'browser'): MoveTab => ({
  id: 't', type, title: 'page.html', metadata: {}, state: { currentUrl }, working: false, interrupted: false, running: false,
});

describe('arrivingPreview', () => {
  let root: string;
  let worktree: string;
  const map = () => buildPathMap({ sourceHome: '/a', targetHome: path.join(root, 'home'), entries: [{ from: '/a/worktrees/p1', to: worktree }] });

  beforeEach(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pane-file-previews-')));
    worktree = path.join(root, 'worktrees', 'p1');
    fs.mkdirSync(worktree, { recursive: true });
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it('leaves tabs that are not file previews to the usual path', async () => {
    expect(await arrivingPreview(tab('https://example.invalid/'), map(), [worktree], 'A')).toBeNull();
    expect(await arrivingPreview(tab('file:///a/worktrees/p1/x', 'terminal'), map(), [worktree], 'A')).toBeNull();
  });

  it('never carries a moved file that links outside what moved', async () => {
    fs.writeFileSync(path.join(root, 'secret.html'), 'x');
    fs.symlinkSync(path.join(root, 'secret.html'), path.join(worktree, 'page.html'));
    expect(await arrivingPreview(tab('file:///a/worktrees/p1/page.html'), map(), [worktree], 'A')).toEqual({
      kind: 'notCarried', note: 'page.html (/a/worktrees/p1/page.html): not carried, the file links outside the Session\'s worktrees and folder',
    });
  });

  it('never carries the moved folder itself, only a file in it', async () => {
    expect(await arrivingPreview(tab('file:///a/worktrees/p1'), map(), [worktree], 'A')).toMatchObject({ kind: 'notCarried' });
  });
});
