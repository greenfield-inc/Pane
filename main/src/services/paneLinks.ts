import net from 'net';
import type { PaneCommandRegistry, PaneCommandValue } from '../daemon/commandRegistry';
import { encodePaneDaemonFrame, PaneDaemonFrameDecoder } from '../daemon/socketFraming';
import { getPaneDaemonEndpoint } from '../daemon/socketPath';
import type { PaneLinkNavigation, PaneLinkTarget } from '../../../shared/types/paneLinks';
import { boundary, decodeBoundary } from '../../../shared/validation/boundaryDecoder';

/**
 * pane:// deep links: `pane://open?pane=<id>[&panel=<id>]`, `pane://open?repo=<id>`, or
 * `pane://open?session=<id>`. Opening one navigates the app to what it names; it never
 * changes Pane state, and anything that doesn't parse exactly is rejected.
 */
export const PANE_LINK_SCHEME = 'pane';
export const OPEN_PANE_LINK_CHANNEL = 'runpane:links:open';


const LINK_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const REPO_ID = /^[1-9][0-9]{0,15}$/;
const ALLOWED_PARAMS = new Set(['pane', 'panel', 'repo', 'session']);
const MAX_LINK_LENGTH = 2048;

function parsePaneLink(link: string): PaneLinkTarget {
  if (link.length > MAX_LINK_LENGTH) throw new Error('Pane link is too long');
  let url: URL;
  try {
    url = new URL(link);
  } catch {
    throw new Error('Not a valid pane:// link');
  }
  if (url.protocol !== `${PANE_LINK_SCHEME}:` || url.hostname !== 'open' || !['', '/'].includes(url.pathname)
    || url.username || url.password || url.port || url.hash) {
    throw new Error('Pane links look like pane://open?pane=<id>');
  }
  const params = new Map<string, string>();
  for (const [key, value] of url.searchParams) {
    if (!ALLOWED_PARAMS.has(key)) throw new Error(`Unknown pane link parameter: ${key}`);
    if (params.has(key)) throw new Error(`Repeated pane link parameter: ${key}`);
    params.set(key, value);
  }
  const targets = ['pane', 'repo', 'session'].filter((key) => params.has(key));
  if (targets.length !== 1) throw new Error('A pane link names exactly one of pane, repo, or session');
  const panelId = params.get('panel');
  if (panelId !== undefined && !params.has('pane')) throw new Error('A panel link also names its pane');

  const id = (key: string, pattern: RegExp): string => {
    const value = params.get(key) ?? '';
    if (!pattern.test(value)) throw new Error(`Invalid ${key} id in pane link`);
    return value;
  };
  if (params.has('repo')) return { kind: 'repo', repoId: Number(id('repo', REPO_ID)) };
  if (params.has('session')) return { kind: 'session', sessionId: id('session', LINK_ID) };
  const target: PaneLinkTarget = { kind: 'pane', paneId: id('pane', LINK_ID) };
  if (panelId !== undefined) target.panelId = id('panel', LINK_ID);
  return target;
}

export function findPaneLinkArg(argv: readonly string[]): string | undefined {
  return argv.find((arg) => arg.startsWith(`${PANE_LINK_SCHEME}://`));
}

interface PaneLinkOpener {
  /** Shows the window and asks the renderer to navigate to a repository or Session. */
  navigate: (target: PaneLinkNavigation) => void;
  repoExists: (repoId: number) => boolean;
}

/** Registers `runpane:links:open`, the one path every pane:// link (OS or CLI) goes through. */
export function registerPaneLinkHandler(commandRegistry: PaneCommandRegistry, opener: PaneLinkOpener): void {
  commandRegistry.register(OPEN_PANE_LINK_CHANNEL, async (link: PaneCommandValue) => {
    try {
      const target = parsePaneLink(decodeBoundary(link, boundary.string));
      if (target.kind === 'pane') {
        // The same code path as `runpane panes focus`: validates the pane and panel, raises the window.
        await commandRegistry.invoke('runpane:panes:focus', [{ paneId: target.paneId, panelId: target.panelId, source: 'user' }]);
      } else {
        if (target.kind === 'repo' && !opener.repoExists(target.repoId)) {
          throw new Error(`No Pane repo found with id ${target.repoId}. Run \`runpane repos list\` to see saved repos.`);
        }
        opener.navigate(target);
      }
      return { success: true, data: { opened: target } };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  });
}

/**
 * On Windows and Linux the OS starts a new Pane process for a pane:// link. Hand the link to
 * the Pane already running for this data directory, over its daemon socket, so the new
 * process can exit. Returns false when no Pane is listening.
 */
export function forwardPaneLinkToRunningPane(link: string, appDirectory: string, timeoutMs = 3_000): Promise<boolean> {
  return new Promise((resolve) => {
    const endpoint = getPaneDaemonEndpoint(appDirectory);
    const socket = net.createConnection(endpoint.path);
    const decoder = new PaneDaemonFrameDecoder();
    const done = (forwarded: boolean) => {
      clearTimeout(timer);
      socket.destroy();
      resolve(forwarded);
    };
    const timer = setTimeout(() => done(false), timeoutMs);
    socket.once('error', () => done(false));
    socket.once('connect', () => {
      socket.write(encodePaneDaemonFrame({ type: 'request', id: 1, channel: OPEN_PANE_LINK_CHANNEL, args: [link] }));
    });
    socket.on('data', (chunk) => {
      if (decoder.push(chunk).some((frame) => frame.type === 'response' && frame.id === 1)) done(true);
    });
  });
}
