import { afterEach, describe, expect, it } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { pathToFileURL } from 'url';
import type { ToolPanel } from '../../../shared/types/panels';
import { assertHostBrowserFileNavigation, readBrowserPanelFile } from './browserPanelFiles';
import { PaneCommandRegistry } from '../daemon/commandRegistry';

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

describe('browser panel file reads', () => {
  it('does not let remote commands create or retarget a file preview grant', async () => {
    const registry = new PaneCommandRegistry();
    registry.register('panels:test-navigation', (next: string, previous?: string) => {
      assertHostBrowserFileNavigation('browser',
        { isActive: true, hasBeenViewed: true, customState: { currentUrl: next } },
        { isActive: true, hasBeenViewed: true, customState: { currentUrl: previous } });
      return true;
    });
    const original = 'file:///host/bundle/index.html';
    await expect(registry.invokeRemote('panels:test-navigation', [original])).rejects.toThrow('on the host');
    await expect(registry.invokeRemote('panels:test-navigation', ['file:///private/key', original])).rejects.toThrow('on the host');
    await expect(registry.invokeRemote('panels:test-navigation', [original, original])).resolves.toBe(true);
    await expect(registry.invoke('panels:test-navigation', [original])).resolves.toBe(true);
  });
  it.each(['file:', 'FILE:', ' \tFiLe:'])('serves HTML and relative assets for the %j scheme', async (scheme) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pane-browser-'));
    directories.push(root);
    await fs.writeFile(path.join(root, 'index.html'), '<link rel="stylesheet" href="theme.css"><h1>Host page</h1>');
    await fs.writeFile(path.join(root, 'theme.css'), 'h1 { color: green }');
    const url = pathToFileURL(path.join(root, 'index.html')).href.replace('file:', scheme);
    const panel: ToolPanel = {
      id: 'preview', sessionId: 'pane', type: 'browser', title: 'index.html',
      state: { isActive: true, hasBeenViewed: true, customState: { currentUrl: url } },
      metadata: { createdAt: '', lastActiveAt: '', position: 0 },
    };
    const html = await readBrowserPanelFile(panel, url);
    expect(Buffer.from(html.data, 'base64').toString()).toContain('<h1>Host page</h1>');
    expect(html.contentType).toBe('text/html; charset=utf-8');
    const css = await readBrowserPanelFile(panel, new URL('theme.css', url).href);
    expect(Buffer.from(css.data, 'base64').toString()).toBe('h1 { color: green }');
    expect(css.contentType).toBe('text/css; charset=utf-8');
  });

  it('rejects unopened panels, directories, traversal and symlinks escaping the bundle', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pane-browser-'));
    directories.push(root);
    const bundle = path.join(root, 'bundle');
    await fs.mkdir(bundle);
    await fs.mkdir(path.join(root, 'private'));
    await fs.writeFile(path.join(bundle, 'index.html'), 'Opened');
    await fs.writeFile(path.join(root, 'private', 'secret.txt'), 'Private');
    await fs.symlink(path.join(root, 'private'), path.join(bundle, 'escape'), 'junction');
    const url = pathToFileURL(path.join(bundle, 'index.html')).href;
    const panel: ToolPanel = {
      id: 'preview', sessionId: 'pane', type: 'browser', title: 'index.html',
      state: { isActive: true, hasBeenViewed: true, customState: { currentUrl: url } },
      metadata: { createdAt: '', lastActiveAt: '', position: 0 },
    };
    await expect(readBrowserPanelFile(undefined, url)).rejects.toThrow('No host file');
    await expect(readBrowserPanelFile({ ...panel, type: 'editor' }, url)).rejects.toThrow('No host file');
    for (const relative of ['../private/secret.txt', '%2e%2e/private/secret.txt', 'escape/secret.txt', './']) {
      await expect(readBrowserPanelFile(panel, new URL(relative, url).href)).rejects.toThrow('outside');
    }
    await expect(readBrowserPanelFile(panel, 'https://example.com/')).rejects.toThrow();
    const large = await fs.open(path.join(bundle, 'large.bin'), 'w');
    await large.truncate(16 * 1024 * 1024 + 1);
    await large.close();
    await expect(readBrowserPanelFile(panel, new URL('large.bin', url).href)).rejects.toThrow('16 MiB');
  });
});
