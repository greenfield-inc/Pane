import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { pathToFileURL } from 'url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { IpcMain } from 'electron';
import type { AppServices } from './types';
import { PaneCommandRegistry } from '../daemon/commandRegistry';
import { setPaneRuntime, type PaneRuntime } from '../core/runtime';
import { databaseService } from '../services/database';
import { registerFileHandlers } from './file';
import { registerPanelHandlers } from './panels';
import { panelManager } from '../services/panelManager';
import type { ToolPanel } from '../../../shared/types/panels';

function partial<Contract>(value: Partial<Contract>): Contract {
  // SAFETY: Each fixture supplies every member read by the tested code.
  return value as Contract;
}

// A remote desktop asks the host to open a worktree page; the host resolves the
// file and makes the file:// grant, while the client's own tab edits still cannot.
describe('panels:open-html-file', () => {
  const send = vi.fn();
  let directory: string;
  let registry: PaneCommandRegistry;
  let sessionId: string;

  beforeEach(async () => {
    directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'pane-html-preview-')));
    await fs.mkdir(path.join(directory, 'site'));
    await fs.writeFile(path.join(directory, 'site', 'index.html'), '<h1>Preview</h1>');
    await fs.writeFile(path.join(directory, 'notes.md'), '# Notes');
    sessionId = `__orchestration_session_html_${Math.random().toString(36).slice(2)}`;
    databaseService.createSession({
      id: sessionId, name: sessionId, initial_prompt: '', worktree_name: sessionId,
      worktree_path: directory, project_id: null, tool_type: 'none',
    });
    setPaneRuntime(partial<PaneRuntime>({ eventSink: { send } }));
    registry = new PaneCommandRegistry();
    // SAFETY: Only these Session fields and service methods are read by file handlers.
    const services = { sessionManager: {
      getSession: (id: string) => ({ id, isHidden: true, worktreePath: directory }),
      getProjectContext: () => undefined,
    } } as AppServices;
    const ipcMain = partial<IpcMain>({ handle: vi.fn() });
    registerFileHandlers(ipcMain, services, registry);
    registerPanelHandlers(ipcMain, services, registry);
  });

  afterEach(async () => {
    send.mockReset();
    await fs.rm(directory, { recursive: true, force: true });
  });

  it('refuses paths outside the worktree', async () => {
    const outside = path.join(path.dirname(directory), 'outside.html');
    for (const filePath of ['../outside.html', outside]) {
      await expect(registry.invokeRemote('panels:open-html-file', [{ sessionId, filePath }]))
        .resolves.toMatchObject({ success: false, error: expect.stringContaining('not a file in this Session') });
    }
    expect(send).not.toHaveBeenCalledWith('panel:created', expect.anything());
  });

  it('refuses files that are not HTML', async () => {
    await expect(registry.invokeRemote('panels:open-html-file', [{ sessionId, filePath: 'notes.md' }]))
      .resolves.toMatchObject({ success: false, error: expect.stringContaining('.html or .htm') });
    expect(send).not.toHaveBeenCalledWith('panel:created', expect.anything());
  });

  it('creates a new browser tab for the file when a remote desktop asks', async () => {
    const result = await registry.invokeRemote('panels:open-html-file', [{ sessionId, filePath: 'site/index.html' }]);
    const currentUrl = pathToFileURL(path.join(directory, 'site', 'index.html')).href;

    expect(result).toMatchObject({
      success: true,
      data: { sessionId, type: 'browser', title: 'index.html', state: { isActive: true, customState: { currentUrl } } },
    });
    // SAFETY: The assertion above established the success shape.
    const panel = (result as { data: { id: string; metadata: { openPlacement?: string } } }).data;
    expect(panel.metadata.openPlacement).toBeUndefined();
    expect(send).toHaveBeenCalledWith('panel:created', expect.objectContaining({ id: panel.id }));

  });

  it('returns the tab already showing the file instead of opening another', async () => {
    const first = await registry.invokeRemote('panels:open-html-file', [{ sessionId, filePath: 'site/index.html' }]);
    // SAFETY: A successful open returns the panel.
    const panelId = (first as { data: { id: string } }).data.id;
    send.mockClear();

    const again = await registry.invokeRemote('panels:open-html-file', [{ sessionId, filePath: 'site/index.html' }]);

    expect(again).toMatchObject({ success: true, data: { id: panelId } });
    expect(send).not.toHaveBeenCalledWith('panel:created', expect.anything());
  });

  it('opens a new tab when the earlier tab has navigated to another page', async () => {
    const first = await registry.invokeRemote('panels:open-html-file', [{ sessionId, filePath: 'site/index.html' }]);
    // SAFETY: A successful open returns the panel.
    const panel = (first as { data: ToolPanel }).data;
    await panelManager.updatePanel(panel.id, {
      state: { ...panel.state, customState: { currentUrl: 'http://localhost:3000/' } },
    });

    const again = await registry.invokeRemote('panels:open-html-file', [{ sessionId, filePath: 'site/index.html' }]);

    expect(again).toMatchObject({ success: true, data: { id: expect.not.stringMatching(panel.id) } });
    expect(panelManager.getPanel(panel.id)?.state.customState).toEqual({ currentUrl: 'http://localhost:3000/' });
  });

  it('still refuses a remote panels:create that points a tab at a file', async () => {
    const currentUrl = pathToFileURL(path.join(directory, 'site', 'index.html')).href;
    await expect(registry.invokeRemote('panels:create', [{
      sessionId, type: 'browser', title: 'index.html', initialState: { customState: { currentUrl } },
    }])).resolves.toMatchObject({ success: false, error: expect.stringContaining('on the host') });
  });
});
