import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, expect, it } from 'vitest';
import { registerStartupNotice } from './startup-notice';

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

it.each([true, false])('reports previous unclean shutdown %s on the first renderer request only', async unclean => {
  const directory = mkdtempSync(join(tmpdir(), 'pane-startup-'));
  directories.push(directory);
  const sentinel = join(directory, '.running');
  if (unclean) writeFileSync(sentinel, 'previous-process');
  let consume: (() => boolean) | undefined;
  registerStartupNotice({
    handle: (channel, listener) => {
      if (channel === 'app:consume-unclean-shutdown') {
        // SAFETY: This no-argument handler does not inspect the Electron event.
        consume = () => listener({} as Electron.IpcMainInvokeEvent);
      }
    },
  }, sentinel);

  // The first mounted renderer asks after the page has loaded. Reloads ask again.
  expect(consume?.()).toBe(unclean);
  expect(consume?.()).toBe(false);
});
