import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { registerAppImageLinkHandler } from './linuxLinkHandler';

describe('registerAppImageLinkHandler', () => {
  const homes: string[] = [];
  afterEach(() => {
    for (const home of homes.splice(0)) fs.rmSync(home, { recursive: true, force: true });
  });
  function tempHome(): string {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pane-link-handler-'));
    homes.push(home);
    return home;
  }

  it('installs a pane:// handler that launches the AppImage file and makes it the default', () => {
    const home = tempHome();
    const run = vi.fn();
    registerAppImageLinkHandler({ platform: 'linux', env: { APPIMAGE: '/home/sam/Apps/Pane $1.AppImage' }, home, run });

    const entry = fs.readFileSync(path.join(home, '.local/share/applications/com.dcouple.pane-links.desktop'), 'utf8');
    expect(entry).toContain('Exec="/home/sam/Apps/Pane \\$1.AppImage" %U\n');
    expect(entry).toContain('MimeType=x-scheme-handler/pane;\n');
    expect(entry).toContain('NoDisplay=true\n');
    expect(run).toHaveBeenCalledWith('xdg-mime', ['default', 'com.dcouple.pane-links.desktop', 'x-scheme-handler/pane']);
  });

  it('does nothing outside an AppImage, where the installed package registers pane://, or for a path GIO cannot launch', () => {
    const home = tempHome();
    const run = vi.fn();
    registerAppImageLinkHandler({ platform: 'linux', env: {}, home, run });
    registerAppImageLinkHandler({ platform: 'darwin', env: { APPIMAGE: '/x.AppImage' }, home, run });
    // GIO would look for the escaped name on disk and ignore the handler.
    registerAppImageLinkHandler({ platform: 'linux', env: { APPIMAGE: '/home/sam/100%.AppImage' }, home, run });
    expect(fs.existsSync(path.join(home, '.local'))).toBe(false);
    expect(run).not.toHaveBeenCalled();
  });
});
