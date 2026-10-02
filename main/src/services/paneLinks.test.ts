import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { PaneCommandRegistry, type PaneCommandValue } from '../daemon/commandRegistry';
import { PaneDaemonServer } from '../daemon/server';
import type { PaneLinkNavigation } from '../../../shared/types/paneLinks';
import { forwardPaneLinkToRunningPane, OPEN_PANE_LINK_CHANNEL, registerPaneLinkHandler } from './paneLinks';

function setup() {
  const registry = new PaneCommandRegistry();
  const focused: PaneCommandValue[] = [];
  const navigated: PaneLinkNavigation[] = [];
  registry.register('runpane:panes:focus', (request: PaneCommandValue) => {
    focused.push(request);
    return { ok: true };
  });
  registerPaneLinkHandler(registry, {
    repoExists: (repoId) => repoId === 7,
    navigate: (target) => { navigated.push(target); },
  });
  const open = (link: PaneCommandValue) => registry.invoke(OPEN_PANE_LINK_CHANNEL, [link]);
  return { focused, navigated, open };
}

describe('pane:// links', () => {
  it('opens a pane and panel through the panes focus path', async () => {
    const { focused, navigated, open } = setup();

    const result = await open('pane://open?pane=pane-1&panel=panel_2');

    expect(result).toEqual({ success: true, data: { opened: { kind: 'pane', paneId: 'pane-1', panelId: 'panel_2' } } });
    expect(focused).toEqual([{ paneId: 'pane-1', panelId: 'panel_2', source: 'user' }]);
    expect(navigated).toEqual([]);
  });

  it('navigates to a saved repository or a Session', async () => {
    const { navigated, open } = setup();

    await open('pane://open?repo=7');
    await open('pane://open/?session=sess-abc');

    expect(navigated).toEqual([{ kind: 'repo', repoId: 7 }, { kind: 'session', sessionId: 'sess-abc' }]);
  });

  it.each([
    ['another scheme', 'https://open?pane=pane-1'],
    ['another action', 'pane://delete?pane=pane-1'],
    ['a path', 'pane://open/panes?pane=pane-1'],
    ['an unknown parameter', 'pane://open?pane=pane-1&archive=true'],
    ['a repeated parameter', 'pane://open?pane=a&pane=b'],
    ['two targets', 'pane://open?pane=a&repo=7'],
    ['a panel without its pane', 'pane://open?panel=p'],
    ['an id with a path separator', 'pane://open?pane=..%2Fsecrets'],
    ['a non-numeric repo', 'pane://open?repo=Pane'],
    ['credentials', 'pane://user:pw@open?pane=a'],
    ['a fragment', 'pane://open?pane=a#x'],
    ['not a string', 42],
  ])('rejects %s without touching Pane', async (_case, link) => {
    const { focused, navigated, open } = setup();

    const result = await open(link);

    expect(result).toMatchObject({ success: false });
    expect(focused).toEqual([]);
    expect(navigated).toEqual([]);
  });

  it('tells the user how to find a repository that does not exist', async () => {
    const { open } = setup();

    const result = await open('pane://open?repo=8');

    expect(result).toEqual({ success: false, error: expect.stringContaining('runpane repos list') });
  });

  it('hands a link to the Pane already running for the data directory', async () => {
    const appDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'pane-links-'));
    const { focused, open } = setup();
    const registry = new PaneCommandRegistry();
    registry.register(OPEN_PANE_LINK_CHANNEL, (link: PaneCommandValue) => open(link));
    const server = new PaneDaemonServer(registry, appDirectory);
    await server.start();
    try {
      expect(await forwardPaneLinkToRunningPane('pane://open?pane=pane-9', appDirectory)).toBe(true);
      expect(focused).toEqual([{ paneId: 'pane-9', panelId: undefined, source: 'user' }]);
    } finally {
      await server.stop();
      fs.rmSync(appDirectory, { recursive: true, force: true });
    }
  });

  it('reports that no Pane is running when nothing listens', async () => {
    const appDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'pane-links-'));
    try {
      expect(await forwardPaneLinkToRunningPane('pane://open?pane=pane-9', appDirectory, 1_000)).toBe(false);
    } finally {
      fs.rmSync(appDirectory, { recursive: true, force: true });
    }
  });
});

