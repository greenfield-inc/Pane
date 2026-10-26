import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ListeningPort, ListeningPortsSnapshot } from '../../../shared/types/listeningPorts';
import type { ToolPanel } from '../../../shared/types/panels';

const capture = vi.fn();
vi.mock('../services/posthog', () => ({ capture: (...args: unknown[]) => capture(...args) }));

const { livePreviewPortFor, muteLivePreview, openLivePreview, recordLivePreviewShown } = await import('./livePreviewPrompt');

// The prompt's memory lasts the whole run, so every test uses its own Pane and project ids.
let nextId = 0;
function freshPane() {
  nextId += 1;
  return { paneId: `pane-${nextId}`, projectId: nextId };
}

function panePort(paneId: string, port: number, overrides: Partial<ListeningPort> = {}): ListeningPort {
  return { port, pid: 100 + port, process: 'node', group: 'pane-terminal', kind: 'web', sessionId: paneId, ...overrides };
}

function snapshot(...ports: ListeningPort[]): ListeningPortsSnapshot {
  return { host: 'this-mac', ports };
}

function browserTab(paneId: string, currentUrl: string): ToolPanel {
  return {
    id: `browser-${currentUrl}`,
    sessionId: paneId,
    type: 'browser',
    title: 'Browser',
    state: { isActive: false, customState: { currentUrl } },
    metadata: { createdAt: '', lastActiveAt: '', position: 1 },
  };
}

beforeEach(() => capture.mockClear());

describe('which port the live preview prompt offers', () => {
  it("offers the Pane's own web server", () => {
    const { paneId, projectId } = freshPane();
    expect(livePreviewPortFor({ paneId, projectId, ports: snapshot(panePort(paneId, 5173)), panels: [], viewingRemoteHost: false })).toBe(5173);
  });

  it("offers nothing for another Pane's server, a non-web port, or a server started outside Pane", () => {
    const { paneId, projectId } = freshPane();
    const ports = snapshot(
      panePort('another-pane', 3000),
      panePort(paneId, 5174, { kind: 'tcp' }),
      panePort(paneId, 8080, { group: 'other', sessionId: undefined }),
    );
    expect(livePreviewPortFor({ paneId, projectId, ports, panels: [], viewingRemoteHost: false })).toBeNull();
  });

  it('offers nothing while a tab of the Pane already shows the port', () => {
    const { paneId, projectId } = freshPane();
    const panels = [browserTab(paneId, 'http://127.0.0.1:5173/settings')];
    expect(livePreviewPortFor({ paneId, projectId, ports: snapshot(panePort(paneId, 5173)), panels, viewingRemoteHost: false })).toBeNull();
  });

  it('offers the lowest port first', () => {
    const { paneId, projectId } = freshPane();
    const ports = snapshot(panePort(paneId, 5173), panePort(paneId, 3000));
    expect(livePreviewPortFor({ paneId, projectId, ports, panels: [], viewingRemoteHost: false })).toBe(3000);
  });

  it('offers nothing while the desktop views a remote host', () => {
    const { paneId, projectId } = freshPane();
    expect(livePreviewPortFor({ paneId, projectId, ports: snapshot(panePort(paneId, 5173)), panels: [], viewingRemoteHost: true })).toBeNull();
  });
});

describe('answering the live preview prompt', () => {
  it('"Not now" quiets every Pane of that project, and only that project', () => {
    const first = freshPane();
    const sibling = { paneId: `${first.paneId}-b`, projectId: first.projectId };
    const other = freshPane();

    muteLivePreview(first.projectId);

    expect(livePreviewPortFor({ ...sibling, ports: snapshot(panePort(sibling.paneId, 4000)), panels: [], viewingRemoteHost: false })).toBeNull();
    expect(livePreviewPortFor({ ...other, ports: snapshot(panePort(other.paneId, 4000)), panels: [], viewingRemoteHost: false })).toBe(4000);
    expect(capture).toHaveBeenCalledWith('live_preview_prompt', { action: 'not_now' });
  });

  it('"Open preview" opens a split tab on the port, then offers the next server', async () => {
    const { paneId, projectId } = freshPane();
    const invoke = vi.fn().mockResolvedValue({ ok: true });
    const ports = snapshot(panePort(paneId, 3000), panePort(paneId, 5173));

    await expect(openLivePreview(paneId, 3000, invoke)).resolves.toEqual({ kind: 'opened' });

    expect(invoke).toHaveBeenCalledWith('runpane:panels:open', {
      paneId,
      url: 'http://localhost:3000/',
      title: 'Preview · :3000',
      placement: 'split',
      source: 'user',
    });
    expect(capture).toHaveBeenCalledWith('live_preview_prompt', { action: 'opened' });
    expect(livePreviewPortFor({ paneId, projectId, ports, panels: [], viewingRemoteHost: false })).toBe(5173);
  });

  it("reports why the tab didn't open, without Electron's IPC wrapper, and keeps offering it", async () => {
    const { paneId, projectId } = freshPane();
    const invoke = vi.fn().mockRejectedValue(new Error("Error invoking remote method 'runpane:panels:open': Error: Pane pane-x is archived; panels cannot be opened in it"));

    await expect(openLivePreview(paneId, 5173, invoke)).resolves.toEqual({
      kind: 'failed',
      message: 'Pane pane-x is archived; panels cannot be opened in it',
    });
    expect(livePreviewPortFor({ paneId, projectId, ports: snapshot(panePort(paneId, 5173)), panels: [], viewingRemoteHost: false })).toBe(5173);
  });

  it('counts the prompt as shown once per Pane and port', () => {
    const { paneId } = freshPane();
    recordLivePreviewShown(paneId, 5173);
    recordLivePreviewShown(paneId, 5173);
    recordLivePreviewShown(paneId, 3000);
    expect(capture.mock.calls).toEqual([
      ['live_preview_prompt', { action: 'shown' }],
      ['live_preview_prompt', { action: 'shown' }],
    ]);
  });
});
