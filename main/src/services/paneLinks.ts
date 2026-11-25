import net from 'net';
import type { PaneCommandRegistry, PaneCommandValue } from '../daemon/commandRegistry';
import { encodePaneDaemonFrame, PaneDaemonFrameDecoder } from '../daemon/socketFraming';
import { getPaneDaemonEndpoint } from '../daemon/socketPath';
import type { PaneLinkNavigation, PaneLinkTarget } from '../../../shared/types/paneLinks';
import { boundary, decodeBoundary } from '../../../shared/validation/boundaryDecoder';
import { parseRelayPairingLink } from '../../../shared/remoteClient/relay';
import type { RelayLinkOpenedEvent } from '../../../shared/types/relay';
import { getPaneEventSink } from '../core/runtime';
import { ORCHESTRATION_SESSION_INTERNAL_ID_PREFIX } from '../../../shared/types/orchestrationSession';
import { agentLabel, CONFIGURED_AGENT_IDS, configuredAgentSchema, type ConfiguredAgentId } from '../../../shared/agents';
import { sanitizePaneName } from '../../../shared/utils/paneName';
import { MAX_START_LINK_LENGTH, normalizeLinkPrompt } from '../../../shared/startLinks';
import type { StartLinkAgentOption, StartLinkAnswer, StartLinkRequest, StartLinkTarget } from '../../../shared/types/startLinks';

/**
 * pane:// deep links: `pane://open?pane=<id>[&panel=<id>]`, `pane://open?repo=<id>`, or
 * `pane://open?session=<id>`. Opening one navigates the app to what it names, and a panel link
 * opens that tab's oldest waiting question in Approvals, as Open in Pane does. It never answers a card or changes
 * other Pane state, and anything that doesn't parse exactly is rejected.
 *
 * `pane://new?prompt=<text>[&agent=<id>][&repo=<id|name|owner/repo> | &session=<id|name>]` starts
 * work from anywhere (a docs page's button, a chat bot), so it never runs on its own: Pane shows the
 * prompt, the agent and where it runs, and starts only when the person presses Start. With no repo
 * or session it starts a new Session; with a Session it sends the prompt to that Session's agent.
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
const START_PARAMS = new Set(['repo', 'session', 'prompt', 'agent']);
/** A Session's id or its name: printable, one line. */
const SESSION_SELECTOR = /^[^\p{C}\p{Zl}\p{Zp}]{1,100}$/u;
const MAX_LINK_LENGTH = 2048;

/** A `pane://new` link: start an agent on a prompt, once the person confirms. */
export interface PaneStartLink {
  kind: 'new';
  prompt: string;
  /** The agent the link names, or null to use the person's default. */
  agent: ConfiguredAgentId | null;
  repo?: string;
  session?: string;
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
    throw new Error('Pane links look like pane://open?pane=<id> or pane://new?prompt=<text>');
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
  const repo = params.get('repo');
  const session = params.get('session');
  if (repo !== undefined && session !== undefined) throw new Error('A pane://new link names a repo or a session, not both');
  if (repo !== undefined && !REPO_SELECTOR.test(repo)) {
    throw new Error('A pane://new link names its repository as repo=<id>, repo=<name> or repo=<owner/repo>');
  }
  if (session !== undefined && (!SESSION_SELECTOR.test(session) || session.trim() !== session)) {
    throw new Error('A pane://new link names its Session as session=<id> or session=<name>');
  }
  if (!params.has('prompt')) throw new Error('A pane://new link needs a prompt=<text>');
  const normalized = normalizeLinkPrompt(params.get('prompt') ?? '');
  if ('problem' in normalized) throw new Error(`Pane won't send this link's prompt. ${normalized.problem}`);
  const agentId = params.get('agent');
  let agent: ConfiguredAgentId | null = null;
  if (agentId !== undefined) {
    try {
      agent = decodeBoundary(agentId, configuredAgentSchema);
    } catch {
      throw new Error(`Unknown agent in pane link: ${agentId}. Use one of ${CONFIGURED_AGENT_IDS.join(', ')}, or leave agent out for the person's default.`);
    }
  }
  const link: PaneStartLink = { kind: 'new', prompt: normalized.prompt, agent };
  if (repo !== undefined) link.repo = repo;
  if (session !== undefined) link.session = session;
  return link;
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
  const name = sanitizePaneName(prompt.split('\n')[0].split(/\s+/).slice(0, 6).join(' ')).slice(0, 48).trim();
  // The worktree and branch are named from ASCII letters and digits; a name without any gives none.
  return /[A-Za-z0-9]/.test(name) ? name : 'Linked task';
}

/** A Session name from the first words of the prompt's first line; a Session has no branch, so any letters do. */
function startLinkSessionName(prompt: string): string {
  return prompt.split('\n')[0].split(/\s+/).slice(0, 6).join(' ').slice(0, 48).trim() || 'Linked task';
}

const linkedSessionSchema = boundary.object({
  session: boundary.object({
    id: boundary.string,
    name: boundary.string,
    agent: configuredAgentSchema,
    archived: boundary.optional(boundary.boolean),
    panelIds: boundary.record(boundary.string),
  }),
});

/** The Session a start link names, by id or by name. */
async function findLinkedSession(commandRegistry: PaneCommandRegistry, selector: string) {
  const query = selector.startsWith(ORCHESTRATION_SESSION_INTERNAL_ID_PREFIX) ? { sessionId: selector } : { name: selector };
  let session;
  try {
    ({ session } = decodeBoundary(await commandRegistry.invoke('runpane:sessions:get', [query]), linkedSessionSchema));
  } catch {
    throw new Error(`No Session matches "${selector}". Use a Session's name or id from \`runpane sessions list\`, or leave session out to start a new Session.`);
  }
  if (session.archived) throw new Error(`Session "${session.name}" is archived. Restore it in Pane, then open the link again.`);
  const panelId = session.panelIds[session.agent];
  if (!panelId) throw new Error(`Session "${session.name}" has no ${agentLabel(session.agent)} tab to send the prompt to.`);
  return { ...session, panelId };
}

/**
 * The agent preselected in the dialog: the link's if installed, else the person's default if
 * installed, else the first installed agent. With none installed, the link's or the default.
 */
function preselectedAgent(linkAgent: ConfiguredAgentId | null, defaultAgent: ConfiguredAgentId, installed: readonly ConfiguredAgentId[]): ConfiguredAgentId {
  for (const candidate of [linkAgent, defaultAgent]) {
    if (candidate && installed.includes(candidate)) return candidate;
  }
  return installed[0] ?? linkAgent ?? defaultAgent;
}

/** What the person chose, if it is one of the choices offered; anything else counts as Cancel. */
function acceptedAnswer(request: Omit<StartLinkRequest, 'requestId'>, answer: Omit<StartLinkAnswer, 'requestId'>): { agent: ConfiguredAgentId; target: StartLinkTarget } | null {
  if (!answer.start || answer.target === undefined || !Number.isInteger(answer.target)) return null;
  const target = request.targets[answer.target];
  if (!target) return null;
  if (target.kind === 'session') return { agent: target.agent, target };
  const offered = request.agents.find((option) => option.id === answer.agent);
  if (!offered || !(offered.installed || offered.id === request.agent)) return null;
  return { agent: offered.id, target };
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
  /** The agents whose CLI is installed on this computer. */
  installedAgents: () => Promise<ConfiguredAgentId[]>;
  /** The person's default agent ("Your default" in Settings). */
  defaultAgent: () => ConfiguredAgentId;
  /** Asks the person in Pane's window; resolves with their answer, which counts only when it matches the request. */
  confirmStart: (request: Omit<StartLinkRequest, 'requestId'>) => Promise<Omit<StartLinkAnswer, 'requestId'>>;
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
  // One start question at a time, so a page can't stack dialogs for a stray click on Start.
  let asking = false;
  commandRegistry.register(OPEN_PANE_LINK_CHANNEL, async (link: PaneCommandValue) => {
    try {
      const text = decodeBoundary(link, boundary.string);
      if (isPanePairLink(text)) {
        (opener.openPairLink ?? sendPairLinkOpened)(text);
        return { success: true, data: { opened: { kind: 'pair' } } };
      }
      const target = parsePaneLink(text);
      if (target.kind === 'new') {
        if (asking) throw new Error('Pane is already asking about another start link. Answer that one, then open this link again.');
        const request = await startLinkRequest(commandRegistry, opener, target);
        asking = true;
        // The CLI's request returns now; the work starts only if the person presses Start.
        void startFromLink(commandRegistry, opener, request).finally(() => { asking = false; });
        const linked = request.targets[0];
        return { success: true, data: { opened: {
          kind: 'new',
          target: linked.kind,
          ...(linked.kind === 'repo' ? { repoId: linked.repoId } : linked.kind === 'session' ? { sessionId: linked.sessionId } : {}),
          // A Session's own agent gets the prompt, whatever the link named.
          agent: linked.kind === 'session' ? linked.agent : request.agent,
          confirming: true,
        } } };
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

/** The question for the person: where the link can run, which agents are installed, and the prompt. */
async function startLinkRequest(commandRegistry: PaneCommandRegistry, opener: PaneLinkOpener, link: PaneStartLink): Promise<Omit<StartLinkRequest, 'requestId'>> {
  const targets: StartLinkTarget[] = [];
  if (link.repo !== undefined) {
    const repo = findLinkedRepo(await opener.listRepos(), link.repo);
    targets.push({ kind: 'repo', repoId: repo.id, repoName: repo.name, identity: repo.identity });
  } else if (link.session !== undefined) {
    const session = await findLinkedSession(commandRegistry, link.session);
    targets.push({ kind: 'session', sessionId: session.id, sessionName: session.name, agent: session.agent });
  }
  // A new Session is always on offer: it needs no repository.
  targets.push({ kind: 'new-session' });
  const installed = await opener.installedAgents();
  const agents: StartLinkAgentOption[] = [...CONFIGURED_AGENT_IDS]
    .sort((a, b) => Number(installed.includes(b)) - Number(installed.includes(a)))
    .map((id) => ({ id, label: agentLabel(id), installed: installed.includes(id) }));
  return { prompt: link.prompt, agents, agent: preselectedAgent(link.agent, opener.defaultAgent(), installed), linkAgent: link.agent, targets };
}

async function startFromLink(commandRegistry: PaneCommandRegistry, opener: PaneLinkOpener, request: Omit<StartLinkRequest, 'requestId'>): Promise<void> {
  let where = 'a new Session';
  try {
    const choice = acceptedAnswer(request, await opener.confirmStart(request));
    if (!choice) return;
    const { agent, target } = choice;
    if (target.kind === 'repo') {
      where = target.repoName;
      const created = await commandRegistry.invoke('runpane:panes:create', [{
        repo: { id: target.repoId },
        panes: [{ name: startLinkPaneName(request.prompt), tool: { agent, initialInput: request.prompt } }],
        focus: true,
        source: 'user',
      }]);
      const failure = decodeBoundary(created, boundary.object({
        items: boundary.array(boundary.object({ error: boundary.optional(boundary.object({ message: boundary.string })) })),
      })).items.find((item) => item.error)?.error;
      if (failure) opener.showError(`Pane could not start the linked task in ${where}: ${failure.message}`);
    } else if (target.kind === 'session') {
      where = `Session "${target.sessionName}"`;
      const session = await findLinkedSession(commandRegistry, target.sessionId);
      await sendToSession(commandRegistry, opener, { sessionId: session.id, panelId: session.panelId }, request.prompt, where);
    } else {
      const created = await createLinkedSession(commandRegistry, startLinkSessionName(request.prompt), agent);
      where = 'the new Session';
      await sendToSession(commandRegistry, opener, created, request.prompt, where);
    }
  } catch (error) {
    opener.showError(`Pane could not start the linked task in ${where}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** Opens the Session on its agent tab, waits for the agent, and submits the prompt there. */
async function sendToSession(commandRegistry: PaneCommandRegistry, opener: PaneLinkOpener, session: { sessionId: string; panelId: string }, prompt: string, where: string): Promise<void> {
  opener.navigate({ kind: 'session', sessionId: session.sessionId, panelId: session.panelId });
  await commandRegistry.invoke('runpane:panels:resume', [{ panelId: session.panelId, waitReady: true }]);
  const submitted = decodeBoundary(
    await commandRegistry.invoke('runpane:panels:submit', [{ panelId: session.panelId, input: prompt, source: 'user', expectReport: false }]),
    boundary.object({ ok: boundary.boolean }),
  );
  if (!submitted.ok) opener.showError(`Pane could not confirm that ${where} got the prompt. Open the Session to check whether it arrived.`);
}

/** A new Session with the agent; a taken name gets a number, as loops do. The prompt is submitted once its agent is ready. */
async function createLinkedSession(commandRegistry: PaneCommandRegistry, name: string, agent: ConfiguredAgentId): Promise<{ sessionId: string; panelId: string }> {
  for (let attempt = 1; ; attempt += 1) {
    const candidate = attempt === 1 ? name : `${name} ${attempt}`;
    try {
      const created = decodeBoundary(
        await commandRegistry.invoke('runpane:sessions:create', [{ name: candidate, agent, launchCommand: '' }]),
        boundary.object({ session: boundary.object({ id: boundary.string }), panelId: boundary.string }),
      );
      return { sessionId: created.session.id, panelId: created.panelId };
    } catch (error) {
      if (attempt >= 9 || !/already exists/i.test(error instanceof Error ? error.message : String(error))) throw error;
    }
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
