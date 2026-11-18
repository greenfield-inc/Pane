import { mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { dirname, join, relative } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { afterEach, describe, expect, it } from 'vitest';
import type { ToolPanel } from '../../../../shared/types/panels';
import { readBrowserPanelFile } from '../../services/browserPanelFiles';
import { copyHostPage } from './hostPageCopy';

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

/** A host folder with these files, and a reader that reads it the way the host answers a remote desktop. */
async function hostPage(files: Record<string, string>, entry = 'site/index.html') {
  const root = await mkdtemp(join(tmpdir(), 'pane-host-'));
  directories.push(root);
  for (const [name, text] of Object.entries(files)) {
    await mkdir(dirname(join(root, name)), { recursive: true });
    await writeFile(join(root, name), text);
  }
  const pageUrl = pathToFileURL(join(root, entry)).href;
  const panel: ToolPanel = {
    id: 'preview', sessionId: 'pane', type: 'browser', title: 'index.html',
    state: { isActive: true, customState: { currentUrl: pageUrl } },
    metadata: { createdAt: '', lastActiveAt: '', position: 0 },
  };
  return { pageUrl, read: (url: string) => readBrowserPanelFile(panel, url) };
}

/** Every file in the copy's folder, by path relative to it, with its text. */
async function copiedFiles(pagePath: string): Promise<Record<string, string>> {
  const folder = dirname(pagePath);
  directories.push(folder);
  const files: Record<string, string> = {};
  for (const name of await readdir(folder, { recursive: true })) {
    const path = join(folder, name);
    if ((await stat(path)).isFile()) files[relative(folder, path).split('\\').join('/')] = await readFile(path, 'utf8');
  }
  return files;
}

describe('copyHostPage', () => {
  it('copies the page and the files it and its stylesheets load from its folder', async () => {
    const page = '<link rel="stylesheet" href="css/app.css?v=2"><img src=\'img/logo.png\'><img srcset="img/a.png 1x, img/b.png 2x">'
      + '<a href="#top">top</a><a href="https://runpane.com/">site</a><script src="/abs.js"></script><img src="../secret.txt">';
    const { pageUrl, read } = await hostPage({
      'site/index.html': page,
      'site/css/app.css': '@import "base.css"; body { background: url(../img/bg.png) }',
      'site/css/base.css': 'p { font-family: x }',
      'site/img/logo.png': 'logo',
      'site/img/a.png': 'a',
      'site/img/b.png': 'b',
      'site/img/bg.png': 'bg',
      'site/unused.txt': 'not referenced',
      'secret.txt': 'outside the page folder',
    });

    const copy = await copyHostPage(pageUrl, read);

    expect(copy.endsWith('index.html')).toBe(true);
    expect(await copiedFiles(copy)).toEqual({
      'index.html': page,
      'css/app.css': '@import "base.css"; body { background: url(../img/bg.png) }',
      'css/base.css': 'p { font-family: x }',
      'img/logo.png': 'logo',
      'img/a.png': 'a',
      'img/b.png': 'b',
      'img/bg.png': 'bg',
    });
  });

  it('opens the page when a file it names is missing on the host', async () => {
    const { pageUrl, read } = await hostPage({ 'site/index.html': '<img src="gone.png">' });

    expect(await copiedFiles(await copyHostPage(pageUrl, read))).toEqual({ 'index.html': '<img src="gone.png">' });
  });

  it.skipIf(process.platform === 'win32')('leaves out a link in the folder that leads outside it', async () => {
    const { pageUrl, read } = await hostPage({ 'site/index.html': '<img src="peek.png">', 'secret.txt': 'outside' });
    await symlink(join(dirname(fileURLToPath(pageUrl)), '..', 'secret.txt'), join(dirname(fileURLToPath(pageUrl)), 'peek.png'));

    expect(await copiedFiles(await copyHostPage(pageUrl, read))).toEqual({ 'index.html': '<img src="peek.png">' });
  });

  it('refuses a page that is not .html or .htm', async () => {
    const { pageUrl, read } = await hostPage({ 'site/run.command': 'echo hi' }, 'site/run.command');

    await expect(copyHostPage(pageUrl, read)).rejects.toMatchObject({ code: 'ERR_LOCAL_PAGE_BLOCKED' });
  });

  it('says the host could not give the page when it is gone', async () => {
    const { pageUrl, read } = await hostPage({ 'site/other.html': '' });

    await expect(copyHostPage(pageUrl, read)).rejects.toMatchObject({ code: 'ERR_LOCAL_PAGE_MISSING' });
  });
});
