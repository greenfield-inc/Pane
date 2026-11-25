import net from 'net';
import type { PaneCommandRegistry, PaneCommandValue } from '../daemon/commandRegistry';
import { encodePaneDaemonFrame, PaneDaemonFrameDecoder } from '../daemon/socketFraming';
import { getPaneDaemonEndpoint } from '../daemon/socketPath';
import type { PaneLinkNavigation, PaneLinkTarget } from '../../../shared/types/paneLinks';
import { boundary, decodeBoundary } from '../../../shared/validation/boundaryDecoder';
import { parseRelayPairingLink } from '../../../shared/remoteClient/relay';
import type { RelayLinkOpenedEvent } from '../../../shared/types/relay';
import { getPaneEventSink } from '../core/runtime';
import { agentLabel, configuredAgentSchema, DEFAULT_AGENT_ID, type ConfiguredAgentId } from '../../../shared/agents';
import { sanitizePaneName } from '../../../shared/utils/paneName';

/**
 * pane:// deep links: `pane://open?pane=<id>[&panel=<id>]`, `pane://open?repo=<id>`, or
 * `pane://open?session=<id>`. Opening one navigates the app to what it names, and a panel link
 * opens that tab's oldest waiting question in Approvals, as Open in Pane does. It never answers a card or changes
 * other Pane state, and anything that doesn't parse exactly is rejected.
 *
 * `pane://new?repo=<id|name|owner/repo>&prompt=<text>[&agent=<id>]` starts work from anywhere (a chat
 * bot's button, a web page), so it never runs on its own: Pane names the repository and agent and
 * shows the whole prompt, and creates the Pane only when the person presses Start.
 *
 * `pane://pair#…` is another computer's one-time link (the relay landing page's "Open Pane"): it
 * opens the confirm page on `relay:link-opened`, and links nothing until the person confirms there.
 */
export const PANE_LINK_SCHEME = 'pane';
export const OPEN_PANE_LINK_CHANNEL = 'runpane:links:open';


const LINK_ID = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;
const REPO_ID = /^[1-9][0-9]{0,15}$/;
/** A saved repository's id, its name, or its origin remote as `owner/repo` (or `host/owner/repo`). */
const REPO_SELECTOR = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,99}(?:\/[A-Za-z0-9_][A-Za-z0-9._-]{0,99}){0,2}$/;
const ALLOWED_PARAMS = new Set(['pane', 'panel', 'repo', 'session']);
const START_PARAMS = new Set(['repo', 'prompt', 'agent']);
const MAX_LINK_LENGTH = 2048;
/** A start link carries a whole prompt, so it may be longer; the prompt itself is capped below. */
const MAX_START_LINK_LENGTH = 16_384;
export const MAX_LINK_PROMPT_LENGTH = 4_000;

/** A `pane://new` link: start an agent on a prompt in a new Pane, once the person confirms. */
export interface PaneStartLink {
  kind: 'new';
  repo: string;
  prompt: string;
  agent: ConfiguredAgentId;
}

/**
 * Control characters other than tab and newline, and bidirectional overrides, which could hide
 * part of the prompt in the confirmation.
 */
function hasUnsafeCharacters(text: string): boolean {
  return [...text].some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return (code < 32 && code !== 9 && code !== 10) || (code >= 127 && code < 160)
      || (code >= 0x202a && code <= 0x202e) || (code >= 0x2066 && code <= 0x2069);
  });
}

export function parsePaneLink(link: string): PaneLinkTarget | PaneStartLink {
  if (link.length > MAX_START_LINK_LENGTH) throw new Error('Pane link is too long');
  let url: URL;
  try {
    url = new URL(link);
  } catch {
    throw new Error('Not a valid pane:// link');
  }
  const action = url.hostname;
  if (url.protocol !== `${PANE_LINK_SCHEME}:` || !['open', 'new'].includes(action) || !['', '/'].includes(url.pathname)
    || url.username || url.password || url.port || url.hash) {
    throw new Error('Pane links look like pane://open?pane=<id> or pane://new?repo=<repo>&prompt=<text>');
  }
  if (action === 'open' && link.length > MAX_LINK_LENGTH) throw new Error('Pane link is too long');
  const params = new Map<string, string>();
  for (const [key, value] of url.searchParams) {
    if (!(action === 'new' ? START_PARAMS : ALLOWED_PARAMS).has(key)) throw new Error(`Unknown pane link parameter: ${key}`);
    if (params.has(key)) throw new Error(`Repeated pane link parameter: ${key}`);
    params.set(key, value);
  }
  if (action === 'new') return parseStartLink(params);
  const targets = ['pane', 'repo', 'session'].filter((key) => params.has(key));
  if (targets.length !== 1) throw new Error('A pane://open link names exactly one of pane, repo, or session, as in pane://open?pane=<id>');
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

function parseStartLink(params: Map<string, string>): PaneStartLink {
  const repo = params.get('repo') ?? '';
  if (!REPO_SELECTOR.test(repo)) {
    throw new Error('A pane://new link names its repository as repo=<id>, repo=<name> or repo=<owner/repo>');
  }
  const prompt = (params.get('prompt') ?? '').trim();
  if (!prompt) throw new Error('A pane://new link needs a prompt=<text>');
  if ([...prompt].length > MAX_LINK_PROMPT_LENGTH) throw new Error(`The link's prompt is longer than ${MAX_LINK_PROMPT_LENGTH} characters`);
  if (hasUnsafeCharacters(prompt)) throw new Error("The link's prompt holds control or text-direction characters, which Pane does not send to an agent");
  const agentId = params.get('agent');
  let agent: ConfiguredAgentId = DEFAULT_AGENT_ID;
  if (agentId !== undefined) {
    try {
      agent = decodeBoundary(agentId, configuredAgentSchema);
    } catch {
      throw new Error(`Unknown agent in pane link: ${agentId}`);
    }
  }
  return { kind: 'new', repo, prompt, agent };
}

interface LinkedRepo {
  id: number;
  name: string;
  /** `host/owner/repo` from the origin remote, lower-cased; null without one. */
  identity: string | null;
}

/**
 * The saved repository a start link names: by numeric id, then by saved name, then by origin
 * remote (`owner/repo` matches `github.com/owner/repo`). Throws, saying what to do, when none or
 * several match.
 */
export function findLinkedRepo(repos: readonly LinkedRepo[], selector: string): LinkedRepo {
  const byId = /^\d+$/.test(selector) ? repos.find((repo) => repo.id === Number(selector)) : undefined;
  if (byId) return byId;
  const wanted = selector.toLowerCase();
  const byName = repos.filter((repo) => repo.name.toLowerCase() === wanted);
  const matches = byName.length > 0 || !wanted.includes('/')
    ? byName
    : repos.filter((repo) => repo.identity === wanted || Boolean(repo.identity?.endsWith(`/${wanted}`)));
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) {
    throw new Error(`Several saved repositories match "${selector}" (${matches.map((repo) => `${repo.name} #${repo.id}`).join(', ')}). Use the numeric id from \`runpane repos list\` in the link.`);
  }
  throw new Error(`No saved repository matches "${selector}". Add it to Pane (Add Repository, or \`runpane repos add --path <path>\`), then open the link again.`);
}

/** A Pane name from the first words of the prompt's first line. */
function startLinkPaneName(prompt: string): string {
  return sanitizePaneName(prompt.split('\n')[0].split(/\s+/).slice(0, 6).join(' ')).slice(0, 48).trim() || 'Linked task';
}

/** A `pane://pair#…` one-time link, which the renderer's confirm page redeems. */
export function isPanePairLink(link: string): boolean {
  return link.length <= MAX_LINK_LENGTH && link.startsWith(`${PANE_LINK_SCHEME}://pair`) && parseRelayPairingLink(link) !== null;
}

export function findPaneLinkArg(argv: readonly string[]): string | undefined {
  return argv.find((arg) => arg.startsWith(`${PANE_LINK_SCHEME}://`));
}

interface PaneLinkOpener {
  /** Shows the window and asks the renderer to navigate to a repository or Session. */
  navigate: (target: PaneLinkNavigation) => void;
  repoExists: (repoId: number) => boolean;
  /** Saved repositories with their origin identities, for `pane://new` links. */
  listRepos: () => Promise<LinkedRepo[]>;
  /** Shows the repository, agent and whole prompt with Start and Cancel; true only on Start. */
  confirmStart: (request: { repoName: string; agentLabel: string; prompt: string }) => Promise<boolean>;
  /** Tells the person a link could not do what it asked, in Pane. */
  showError: (message: string) => void;
  /** Opens Approvals on the tab's oldest waiting question, as Open in Pane does; does nothing when none waits. */
  showWaitingCard: (paneId: string, panelId: string) => void | Promise<void>;
  /** Shows the window and the confirm page for a `pane://pair#…` link; by default it only tells the renderer. */
  openPairLink?: (link: string) => void;
}

/** Tells the renderer a one-time link arrived, so it opens the confirm page. */
function sendPairLinkOpened(link: string): void {
  const event: RelayLinkOpenedEvent = { link };
  getPaneEventSink().send('relay:link-opened', event);
}

/** Registers `runpane:links:open`, the one path every pane:// link (OS or CLI) goes through. */
export function registerPaneLinkHandler(commandRegistry: PaneCommandRegistry, opener: PaneLinkOpener): void {
  commandRegistry.register(OPEN_PANE_LINK_CHANNEL, async (link: PaneCommandValue) => {
    try {
      const text = decodeBoundary(link, boundary.string);
      if (isPanePairLink(text)) {
        (opener.openPairLink ?? sendPairLinkOpened)(text);
        return { success: true, data: { opened: { kind: 'pair' } } };
      }
      const target = parsePaneLink(text);
      if (target.kind === 'new') {
        const repo = findLinkedRepo(await opener.listRepos(), target.repo);
        // The CLI's request returns now; the Pane is created only if the person presses Start.
        void startFromLink(commandRegistry, opener, repo, target);
        return { success: true, data: { opened: { kind: 'new', repoId: repo.id, agent: target.agent, confirming: true } } };
      }
      if (target.kind === 'pane') {
        // The same code path as `runpane panes focus`: validates the pane and panel, raises the window.
        await commandRegistry.invoke('runpane:panes:focus', [{ paneId: target.paneId, panelId: target.panelId, source: 'user' }]);
        if (target.panelId) await opener.showWaitingCard(target.paneId, target.panelId);
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

async function startFromLink(commandRegistry: PaneCommandRegistry, opener: PaneLinkOpener, repo: LinkedRepo, link: PaneStartLink): Promise<void> {
  try {
    if (!await opener.confirmStart({ repoName: repo.name, agentLabel: agentLabel(link.agent), prompt: link.prompt })) return;
    const created = await commandRegistry.invoke('runpane:panes:create', [{
      repo: { id: repo.id },
      panes: [{ name: startLinkPaneName(link.prompt), tool: { agent: link.agent, initialInput: link.prompt } }],
      focus: true,
      source: 'user',
    }]);
    const failure = decodeBoundary(created, boundary.object({
      items: boundary.array(boundary.object({ error: boundary.optional(boundary.object({ message: boundary.string })) })),
    })).items.find((item) => item.error)?.error;
    if (failure) opener.showError(`Pane could not start the linked task in ${repo.name}: ${failure.message}`);
  } catch (error) {
    opener.showError(`Pane could not start the linked task in ${repo.name}: ${error instanceof Error ? error.message : String(error)}`);
  }
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
