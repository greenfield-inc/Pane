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
    // SAFETY: The browser panel type discriminator establishes BrowserPanelState.
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

/** The one analytics event: how the person met the prompt, and nothing about the server. */
export type TrackLivePreview = (action: 'shown' | 'opened' | 'not_now') => void;

const trackWithPostHog: TrackLivePreview = action => capture('live_preview_prompt', { action });

/** Counts the prompt as shown, once per Pane and port per run. */
export function recordLivePreviewShown(paneId: string, port: number, track: TrackLivePreview = trackWithPostHog): void {
  const key = pairKey(paneId, port);
  if (shown.has(key)) return;
  shown.add(key);
  track('shown');
}

/** "Not now": no prompt in any Pane of this project until Pane restarts. */
export function muteLivePreview(projectId: number, track: TrackLivePreview = trackWithPostHog): void {
  mutedProjects.add(projectId);
  track('not_now');
}

export type OpenLivePreviewOutcome = { kind: 'opened' } | { kind: 'failed'; message: string };

/** The `runpane panels open` request that puts a Browser tab in the split beside the agent. */
interface PreviewOpenRequest {
  paneId: string;
  url: string;
  title: string;
  placement: 'split';
  source: 'user';
}

export type OpenPreviewTab = (request: PreviewOpenRequest) => Promise<void>;

const openWithRunpane: OpenPreviewTab = async request => {
  await window.electronAPI.invoke('runpane:panels:open', request);
};

/** "Open preview": a Browser tab on the port, in the split beside the agent (or the tab already showing it). */
export async function openLivePreview(
  paneId: string,
  port: number,
  { openTab = openWithRunpane, track = trackWithPostHog }: { openTab?: OpenPreviewTab; track?: TrackLivePreview } = {},
): Promise<OpenLivePreviewOutcome> {
  track('opened');
  try {
    await openTab({
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
