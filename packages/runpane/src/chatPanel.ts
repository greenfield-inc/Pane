import fs from 'node:fs';
import path from 'node:path';
import { STATUS_BY_KIND, type AgentStatus } from './agentTasks';
import { boundary, decodeBoundary, type JsonObject } from './boundaryDecoder';
import { invokeDaemon, resolvePaneDirectory } from './daemonClient';
import { buildPaneLink } from './links';
import { panelListResultSchema, panelScreenResultSchema, workspaceStateResultSchema } from './localControl';

/**
 * The `chatgpt` toolset: Pane's agents as native UI in ChatGPT. Agent tool results render as
 * inline Pane cards, and a panel beside the chat lists the agents that chat started. It follows
 * MCP Apps (`ui://` resource, `_meta.ui`) and OpenAI's extensions (`_meta["openai/ui"]`
 * entrypoints), written by hand because `@openai/mcp-extensions` targets SDK v1.
 */
export const CHAT_TOOLSET = 'chatgpt';

const PANEL_URI = 'ui://pane/panel.html';
const PANEL_MIME = 'text/html;profile=mcp-app';
// ChatGPT sends an anonymized chat id with each tool call. Hosts without one share this key.
const CHAT_META_KEY = 'openai/session';
const NO_CHAT = 'local';
const MAX_AGENTS_PER_CHAT = 12;
const SCREEN_LINES = 6;
const PANE_OFFLINE = 'Pane isn\'t running. Open the Pane app on this computer.';

const ICON_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.33" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3.5" width="14" height="13" rx="2"/><path d="M10 3.5v13M10 10h7"/></svg>';

/** Core tools whose results render as an inline Pane card when the panel toolset is on. */
export const INLINE_CARD_TOOLS = new Set(['agents_start', 'agents_status', 'agents_send']);
export const inlineCardMeta: JsonObject = { ui: { resourceUri: PANEL_URI } };

/**
 * The only stored state: which Panes each chat started, as Pane ids in start order. Pane has no
 * record of the ChatGPT chat behind a Pane, so this can't be derived. Everything else on a card
 * (name, repo, agent panel, status, screen, PR, diff) is read from Pane on each refresh.
 */
type Store = Record<string, string[]>;

/** The Pane each chat's panel shows, set by agents_panel_focus. View state, so memory only. */
const focusByChat = new Map<string, string>();

interface AgentCard {
  paneId: string;
  panelId: string;
  name: string;
  status: AgentStatus | 'gone';
  screen: string[];
  link: string;
  repo?: string;
  diff?: { adds: number; dels: number };
  pr?: { number: number; draft: boolean; title?: string; state?: string; url?: string };
}

type ToolResult = { content: { type: 'text'; text: string }[]; structuredContent?: JsonObject; isError?: boolean };
type RunCli = (argv: string[]) => Promise<{ code: number; stdout: string; stderr: string }>;

// agents_start output, possibly from a failed start that still created a Pane.
const startedSchema = boundary.object({ paneId: boundary.optional(boundary.string) });
const chatMetaSchema = boundary.object({ [CHAT_META_KEY]: boundary.optional(boundary.string) });
const paneListSchema = boundary.object({
  panes: boundary.array(boundary.object({ id: boundary.string, name: boundary.string, repoName: boundary.optional(boundary.string) })),
});
const optionalNumber = boundary.optional(boundary.number);
const gitStatusSchema = boundary.object({
  data: boundary.optional(boundary.object({
    gitStatus: boundary.optional(boundary.object({
      additions: optionalNumber,
      deletions: optionalNumber,
      commitAdditions: optionalNumber,
      commitDeletions: optionalNumber,
      prNumber: optionalNumber,
      prTitle: boundary.optional(boundary.string),
      prState: boundary.optional(boundary.string),
      prIsDraft: boundary.optional(boundary.boolean),
      prUrl: boundary.optional(boundary.string),
    })),
  })),
});
const statusInputSchema = boundary.object({ chat: boundary.string });
const focusInputSchema = boundary.object({ pane: boundary.nonEmptyString });
const cardInputSchema = boundary.object({ paneId: boundary.nonEmptyString, panelId: boundary.optional(boundary.nonEmptyString) });
const openInputSchema = boundary.object({ paneId: boundary.nonEmptyString, panelId: boundary.optional(boundary.nonEmptyString) });
const storeSchema = boundary.object({ chats: boundary.jsonObject });

const readOnly = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const appOnly = { ui: { resourceUri: PANEL_URI, visibility: ['app'] } };

interface PanelTool {
  name: string;
  title: string;
  description: string;
  inputSchema: { type: 'object'; properties: Record<string, { type: 'string'; description?: string }>; required?: string[]; additionalProperties: false };
  annotations: { title: string; readOnlyHint: boolean; destructiveHint: boolean; idempotentHint: boolean; openWorldHint: boolean };
  icons?: { src: string; mimeType: string; sizes: string[] }[];
  _meta: JsonObject;
}

export const chatPanelTools: PanelTool[] = [
  {
    name: 'agents_panel',
    title: 'Chat agents',
    description: 'Show the Pane agents this chat started, with live status, terminal output, and pull requests, in a panel where the user can message them or open them in Pane. Takes no arguments.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { title: 'Chat agents', ...readOnly },
    icons: [{ src: `data:image/svg+xml,${encodeURIComponent(ICON_SVG)}`, mimeType: 'image/svg+xml', sizes: ['any'] }],
    _meta: {
      ui: { resourceUri: PANEL_URI },
      'openai/ui': { entrypoints: [{ type: 'thread' }, { type: 'global' }] },
      'openai/iconStyle': 'monochrome',
    },
  },
  {
    name: 'agents_panel_focus',
    title: 'Show agent',
    description: 'Show one agent this chat started: its card here, and the same agent selected in the Chat agents panel. Use it when the user asks about a specific agent.',
    inputSchema: {
      type: 'object',
      properties: { pane: { type: 'string', description: 'The agent\'s Pane id or name, from agents_start or agents_panel.' } },
      required: ['pane'],
      additionalProperties: false,
    },
    annotations: { title: 'Show agent', ...readOnly },
    _meta: { ui: { resourceUri: PANEL_URI } },
  },
  {
    name: 'agents_panel_status',
    title: 'Refresh chat agents',
    description: 'Refresh the agents panel. The panel passes the chat id from its first result.',
    inputSchema: { type: 'object', properties: { chat: { type: 'string' } }, required: ['chat'], additionalProperties: false },
    annotations: { title: 'Refresh chat agents', ...readOnly },
    _meta: appOnly,
  },
  {
    name: 'agents_card',
    title: 'Refresh agent card',
    description: 'Read one agent for an inline card: status, terminal output, pull request, and diff size.',
    inputSchema: {
      type: 'object',
      properties: { paneId: { type: 'string' }, panelId: { type: 'string' } },
      required: ['paneId'],
      additionalProperties: false,
    },
    annotations: { title: 'Refresh agent card', ...readOnly },
    _meta: appOnly,
  },
  {
    name: 'agents_panel_open',
    title: 'Open in Pane',
    description: 'Bring Pane forward and select this agent\'s Pane. Runs when the user clicks Open in Pane.',
    inputSchema: {
      type: 'object',
      properties: { paneId: { type: 'string' }, panelId: { type: 'string' } },
      required: ['paneId'],
      additionalProperties: false,
    },
    annotations: { title: 'Open in Pane', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    _meta: appOnly,
  },
];

export const chatPanelResource = {
  uri: PANEL_URI,
  name: 'agents-panel',
  title: 'Chat agents',
  mimeType: PANEL_MIME,
};

/** The panel HTML, built by scripts/build-panel.js next to this file. */
export function readChatPanel(uri: string) {
  return {
    contents: [{
      uri,
      mimeType: PANEL_MIME,
      text: fs.readFileSync(path.join(__dirname, 'panel.html'), 'utf8'),
      _meta: {
        ui: { domain: 'https://runpane.com', prefersBorder: true, csp: { connectDomains: [], resourceDomains: [] } },
        'openai/ui': { availableDisplayModes: ['inline', 'fullscreen'] },
      },
    }],
  };
}

/** The chat a tool call came from, read from the request's `_meta`. */
export function chatIdOf(meta: JsonObject): string {
  return decodeBoundary(meta, chatMetaSchema)[CHAT_META_KEY] || NO_CHAT;
}

/** Remembers the Pane that `agents_start` started from this chat. */
export function recordStartedAgent(chat: string, output: JsonObject): void {
  const { paneId } = decodeBoundary(output, startedSchema);
  if (!paneId) return;
  const store = readStore();
  store[chat] = [...(store[chat] ?? []).filter((id) => id !== paneId), paneId].slice(-MAX_AGENTS_PER_CHAT);
  writeStore(store);
}

export async function callChatPanelTool(name: string, input: JsonObject, chat: string, run: RunCli): Promise<ToolResult> {
  if (name === 'agents_panel') return panelResult(chat);
  if (name === 'agents_panel_status') return panelResult(decodeBoundary(input, statusInputSchema).chat);
  if (name === 'agents_panel_focus') return focusResult(chat, decodeBoundary(input, focusInputSchema).pane);
  if (name === 'agents_card') return cardResult(decodeBoundary(input, cardInputSchema));
  const { paneId, panelId } = decodeBoundary(input, openInputSchema);
  const argv = ['panes', 'focus', `--pane=${paneId}`, ...(panelId ? [`--panel=${panelId}`] : []), '--source=user', '--yes', '--json'];
  const { code, stdout, stderr } = await run(argv);
  const text = stdout.trim() || stderr.trim();
  return code === 0
    ? { content: [{ type: 'text', text: 'Opened in Pane.' }], structuredContent: { ok: true, paneId } }
    : { content: [{ type: 'text', text: text || 'Pane did not open the agent.' }], isError: true };
}

async function panelResult(chat: string): Promise<ToolResult> {
  const { agents, offline } = await readAgents(readStore()[chat] ?? []);
  const summary = agents.length === 0
    ? 'This chat has not started any Pane agents yet.'
    : agents.map(describe).join('\n');
  const structuredContent: JsonObject = { chat, agents: agents.map(toJson) };
  const focus = focusByChat.get(chat);
  if (focus) structuredContent.focus = focus;
  if (offline) structuredContent.error = PANE_OFFLINE;
  return { content: [{ type: 'text', text: offline ? PANE_OFFLINE : summary }], structuredContent };
}

async function focusResult(chat: string, pane: string): Promise<ToolResult> {
  const { agents, offline } = await readAgents(readStore()[chat] ?? []);
  const agent = agents.find((entry) => entry.paneId === pane) ?? agents.find((entry) => entry.name === pane);
  if (!agent) {
    const names = agents.map((entry) => entry.name).join(', ') || 'none yet';
    return { content: [{ type: 'text', text: `This chat didn't start an agent called ${pane}. Agents this chat started: ${names}.` }], isError: true };
  }
  focusByChat.set(chat, agent.paneId);
  return cardResultOf(agent, offline);
}

async function cardResult({ paneId, panelId }: { paneId: string; panelId?: string }): Promise<ToolResult> {
  const { agents: [card], offline } = await readAgents([paneId], panelId);
  return cardResultOf(card, offline);
}

function cardResultOf(card: AgentCard, offline: boolean): ToolResult {
  const structuredContent: JsonObject = { agent: toJson(card) };
  if (offline) structuredContent.error = PANE_OFFLINE;
  return { content: [{ type: 'text', text: offline ? PANE_OFFLINE : describe(card) }], structuredContent };
}

function describe(agent: AgentCard): string {
  return `${agent.name}: ${agent.status}${agent.pr ? `, PR #${agent.pr.number}` : ''}`;
}

function toJson(card: AgentCard): JsonObject {
  const { repo, diff, pr, ...required } = card;
  const json: JsonObject = { ...required };
  if (repo) json.repo = repo;
  if (diff) json.diff = diff;
  if (pr) {
    const { title, state, url, ...rest } = pr;
    const prJson: JsonObject = { ...rest };
    if (title) prJson.title = title;
    if (state) prJson.state = state;
    if (url) prJson.url = url;
    json.pr = prJson;
  }
  return json;
}

/**
 * Each agent's card data, read from the Pane daemon in one pass per Pane data directory. `offline`
 * means no directory answered, including the default one checked when the chat has no agents yet.
 */
async function readAgents(paneIds: string[], panelId?: string): Promise<{ agents: AgentCard[]; offline: boolean }> {
  const [panes, state] = await Promise.all([
    invokeDaemon('runpane:panes:list', [{}], paneListSchema).catch(() => undefined),
    invokeDaemon('runpane:workspace:state', [{}], workspaceStateResultSchema).catch(() => undefined),
  ]);
  const workspace = { panes: panes && new Map(panes.panes.map((pane) => [pane.id, pane])), entries: state?.entries ?? [] };
  const offline = !panes && !state;
  return { agents: await Promise.all(paneIds.map((paneId) => readAgent(paneId, panelId, workspace))), offline };
}

type Workspace = { panes?: Map<string, { name: string; repoName?: string }>; entries: { kind: string; panelId?: string; paneId: string }[] };

/** The agent's terminal: its CLI agent panel, else the Pane's first terminal. */
async function agentPanelOf(paneId: string): Promise<string | undefined> {
  const list = await invokeDaemon('runpane:panels:list', [{ paneId }], panelListResultSchema).catch(() => undefined);
  const panels = list?.panels ?? [];
  return (panels.find((panel) => panel.isCliPanel || panel.agentType) ?? panels.find((panel) => panel.type === 'terminal'))?.panelId;
}

async function readAgent(paneId: string, knownPanelId: string | undefined, workspace: Workspace): Promise<AgentCard> {
  const pane = workspace.panes?.get(paneId);
  const card: AgentCard = { paneId, panelId: '', name: pane?.name ?? paneId, status: 'unknown', screen: [], link: buildPaneLink({ kind: 'pane', id: paneId }) };
  // Archived Panes drop out of the list. Without a list, a failed read is a transient unknown.
  if (workspace.panes && !pane) return { ...card, status: 'gone' };
  if (pane?.repoName) card.repo = pane.repoName;
  const panelId = knownPanelId ?? await agentPanelOf(paneId);
  if (panelId) {
    card.panelId = panelId;
    card.link = buildPaneLink({ kind: 'pane', id: paneId, panelId });
  }
  const entry = workspace.entries.find((candidate) => candidate.panelId === panelId);
  card.status = (entry && STATUS_BY_KIND.get(entry.kind)) ?? 'unknown';
  const [screen, git] = await Promise.all([
    panelId
      ? invokeDaemon('runpane:panels:screen', [{ panelId, limit: SCREEN_LINES * 3 }], panelScreenResultSchema).catch(() => undefined)
      : undefined,
    invokeDaemon('sessions:get-git-status', [paneId], gitStatusSchema).catch(() => undefined),
  ]);
  if (screen) card.screen = screen.text.split('\n').map((line) => line.trimEnd()).filter((line) => line.trim() !== '').slice(-SCREEN_LINES);
  const gs = git?.data?.gitStatus;
  if (gs) {
    const adds = (gs.additions ?? 0) + (gs.commitAdditions ?? 0);
    const dels = (gs.deletions ?? 0) + (gs.commitDeletions ?? 0);
    if (adds > 0 || dels > 0) card.diff = { adds, dels };
    if (gs.prNumber !== undefined) {
      card.pr = { number: gs.prNumber, draft: gs.prIsDraft === true, title: gs.prTitle, state: gs.prState?.toLowerCase(), url: gs.prUrl };
    }
  }
  return card;
}

function storeFile(): string {
  return path.join(resolvePaneDirectory(), 'chatgpt', 'chats.json');
}

function readStore(): Store {
  let raw: string;
  try {
    raw = fs.readFileSync(storeFile(), 'utf8');
  } catch {
    return {};
  }
  try {
    const { chats } = decodeBoundary(JSON.parse(raw), storeSchema);
    return Object.fromEntries(Object.entries(chats).map(([chat, paneIds]) => [chat, decodeBoundary(paneIds, boundary.array(boundary.string))]));
  } catch {
    return {};
  }
}

function writeStore(chats: Store): void {
  const file = storeFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify({ chats }, null, 2)}\n`);
}
