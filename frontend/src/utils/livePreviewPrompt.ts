import type { ListeningPortsSnapshot } from '../../../shared/types/listeningPorts';
import type { BrowserPanelState, ToolPanel } from '../../../shared/types/panels';
import { loopbackPortOf } from '../../../shared/utils/browserUrl';
import { capture } from '../services/posthog';
import { ipcErrorMessage } from './ipcErrorMessage';

/**
 * What the live preview prompt remembers until Pane restarts: projects muted with "Not now", and
 * each Pane and port already answered or already counted as shown.
 */
const mutedProjects = new Set<number>();
const answered = new Set<string>();
const shown = new Set<string>();

const pairKey = (paneId: string, port: number) => `${paneId}:${port}`;

export interface LivePreviewPromptInput {
  paneId: string;
  projectId: number;
  ports: ListeningPortsSnapshot | null;
  panels: readonly ToolPanel[];
  viewingRemoteHost: boolean;
}

/**
 * The port the Pane on screen should offer a preview of: the lowest web port its own terminals
 * opened that no tab of the Pane shows yet. Null when there is none, or the prompt is muted.
 */
export function livePreviewPortFor({ paneId, projectId, ports, panels, viewingRemoteHost }: LivePreviewPromptInput): number | null {
  if (!ports || viewingRemoteHost || mutedProjects.has(projectId)) return null;
  const shownPorts = new Set(panels.flatMap(panel => {
    if (panel.type !== 'browser') return [];
    const url = (panel.state.customState as BrowserPanelState | undefined)?.currentUrl;
    const port = url ? loopbackPortOf(url) : null;
    return port === null ? [] : [port];
  }));
  const candidates = ports.ports
    .filter(port => port.group === 'pane-terminal' && port.sessionId === paneId && port.kind === 'web')
    .map(port => port.port)
    .filter(port => !shownPorts.has(port) && !answered.has(pairKey(paneId, port)));
  return candidates.length ? Math.min(...candidates) : null;
}

/** Counts the prompt as shown, once per Pane and port per run. */
export function recordLivePreviewShown(paneId: string, port: number): void {
  const key = pairKey(paneId, port);
  if (shown.has(key)) return;
  shown.add(key);
  capture('live_preview_prompt', { action: 'shown' });
}

/** "Not now": no prompt in any Pane of this project until Pane restarts. */
export function muteLivePreview(projectId: number): void {
  mutedProjects.add(projectId);
  capture('live_preview_prompt', { action: 'not_now' });
}

export type OpenLivePreviewOutcome = { kind: 'opened' } | { kind: 'failed'; message: string };

type Invoke = (channel: string, request: unknown) => Promise<unknown>;

/** "Open preview": a Browser tab on the port, in the split beside the agent (or the tab already showing it). */
export async function openLivePreview(
  paneId: string,
  port: number,
  invoke: Invoke = (channel, request) => window.electronAPI.invoke(channel, request),
): Promise<OpenLivePreviewOutcome> {
  capture('live_preview_prompt', { action: 'opened' });
  try {
    await invoke('runpane:panels:open', {
      paneId,
      url: `http://localhost:${port}/`,
      title: `Preview · :${port}`,
      placement: 'split',
      source: 'user',
    });
    answered.add(pairKey(paneId, port));
    return { kind: 'opened' };
  } catch (error) {
    return { kind: 'failed', message: ipcErrorMessage(error, `Pane couldn't open a tab for :${port}.`) };
  }
}
