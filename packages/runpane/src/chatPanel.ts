import fs from 'node:fs';
import path from 'node:path';
import { STATUS_BY_KIND, type AgentStatus } from './agentTasks';
import { boundary, decodeBoundary, type JsonObject } from './boundaryDecoder';
import { invokeDaemon, resolvePaneDirectory } from './daemonClient';
import { buildPaneLink } from './links';
import { panelScreenResultSchema, workspaceStateResultSchema } from './localControl';

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
const PANE_OFFLINE = 'Pane isn\'t running. Open the Pane app, then refresh.';

const ICON_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.33" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3.5" width="14" height="13" rx="2"/><path d="M10 3.5v13M10 10h7"/></svg>';

/** Core tools whose results render as an inline Pane card when the panel toolset is on. */
export const INLINE_CARD_TOOLS = new Set(['agents_start', 'agents_status', 'agents_send']);
export const inlineCardMeta: JsonObject = { ui: { resourceUri: PANEL_URI } };

interface ChatAgent {
  paneId: string;
  panelId: string;
  name?: string;
  paneDir?: string;
}

interface Store {
  chats: Record<string, ChatAgent[]>;
  /** The Pane each chat's panel shows, set by agents_panel_focus. */
  focus: Record<string, string>;
}

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

const chatAgentSchema = boundary.object({
  paneId: boundary.string,
  panelId: boundary.string,
  name: boundary.optional(boundary.string),
  paneDir: boundary.optional(boundary.string),
});
// agents_start output, possibly from a failed start that still created a Pane.
const startedSchema = boundary.object({
  paneId: boundary.optional(boundary.string),
  panelId: boundary.optional(boundary.string),
  name: boundary.optional(boundary.string),
});
const startInputSchema = boundary.object({ paneDir: boundary.optional(boundary.string) });
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
const storeSchema = boundary.object({ chats: boundary.jsonObject, focus: boundary.optional(boundary.jsonObject) });

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

/** Remembers an agent that `agents_start` started from this chat, given the call's input and output. */
export function recordStartedAgent(chat: string, input: JsonObject, output: JsonObject): void {
  const { paneId, panelId, name } = decodeBoundary(output, startedSchema);
  if (!paneId || !panelId) return;
  const agent: ChatAgent = { paneId, panelId, name };
  const { paneDir } = decodeBoundary(input, startInputSchema);
  if (paneDir) agent.paneDir = paneDir;
  const store = readStore();
  const kept = (store.chats[chat] ?? []).filter((entry) => entry.paneId !== paneId);
  store.chats[chat] = [...kept, agent].slice(-MAX_AGENTS_PER_CHAT);
  writeStore(store);
}

export async function callChatPanelTool(name: string, input: JsonObject, chat: string, run: RunCli): Promise<ToolResult> {
  if (name === 'agents_panel') return panelResult(chat);
  if (name === 'agents_panel_status') return panelResult(decodeBoundary(input, statusInputSchema).chat);
  if (name === 'agents_panel_focus') return focusResult(chat, decodeBoundary(input, focusInputSchema).pane);
  if (name === 'agents_card') return cardResult(decodeBoundary(input, cardInputSchema));
  const { paneId, panelId } = decodeBoundary(input, openInputSchema);
  const paneDir = Object.values(readStore().chats).flat().find((agent) => agent.paneId === paneId)?.paneDir;
  const argv = ['panes', 'focus', `--pane=${paneId}`, ...(panelId ? [`--panel=${panelId}`] : []), '--source=user', '--yes', '--json'];
  const { code, stdout, stderr } = await run(paneDir ? [...argv, `--pane-dir=${paneDir}`] : argv);
  const text = stdout.trim() || stderr.trim();
  return code === 0
    ? { content: [{ type: 'text', text: 'Opened in Pane.' }], structuredContent: { ok: true, paneId } }
    : { content: [{ type: 'text', text: text || 'Pane did not open the agent.' }], isError: true };
}

async function panelResult(chat: string): Promise<ToolResult> {
  const store = readStore();
  const { agents, offline } = await readAgents(store.chats[chat] ?? []);
  const summary = agents.length === 0
    ? 'This chat has not started any Pane agents yet.'
    : agents.map(describe).join('\n');
  const structuredContent: JsonObject = { chat, agents: agents.map(toJson) };
  const focus = store.focus[chat];
  if (focus) structuredContent.focus = focus;
  if (offline) structuredContent.error = PANE_OFFLINE;
  return { content: [{ type: 'text', text: offline ? PANE_OFFLINE : summary }], structuredContent };
}

async function focusResult(chat: string, pane: string): Promise<ToolResult> {
  const store = readStore();
  const started = store.chats[chat] ?? [];
  const agent = started.find((entry) => entry.paneId === pane) ?? started.find((entry) => entry.name === pane);
  if (!agent) {
    const names = started.map((entry) => entry.name ?? entry.paneId).join(', ') || 'none yet';
    return { content: [{ type: 'text', text: `This chat didn't start an agent called ${pane}. Agents this chat started: ${names}.` }], isError: true };
  }
  store.focus[chat] = agent.paneId;
  writeStore(store);
  return cardOf(agent);
}

async function cardResult({ paneId, panelId }: { paneId: string; panelId?: string }): Promise<ToolResult> {
  const known = Object.values(readStore().chats).flat().find((agent) => agent.paneId === paneId);
  const agent = known ?? { paneId, panelId: panelId ?? '' };
  return cardOf({ ...agent, panelId: panelId ?? agent.panelId });
}

async function cardOf(agent: ChatAgent): Promise<ToolResult> {
  const { agents: [card], offline } = await readAgents([agent]);
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
async function readAgents(agents: ChatAgent[]): Promise<{ agents: AgentCard[]; offline: boolean }> {
  const paneDirs = agents.length === 0 ? [undefined] : [...new Set(agents.map((agent) => agent.paneDir))];
  const dirs = new Map(await Promise.all(paneDirs.map(async (paneDir) => [paneDir, await readPaneDir(paneDir)] as const)));
  const offline = [...dirs.values()].every((dir) => !dir.panes && dir.entries.length === 0);
  return { agents: await Promise.all(agents.map((agent) => readAgent(agent, dirs.get(agent.paneDir)))), offline };
}

async function readPaneDir(paneDir: string | undefined) {
  const [panes, state] = await Promise.all([
    invokeDaemon('runpane:panes:list', [{}], paneListSchema, { paneDir }).catch(() => undefined),
    invokeDaemon('runpane:workspace:state', [{}], workspaceStateResultSchema, { paneDir }).catch(() => undefined),
  ]);
  return { panes: panes && new Map(panes.panes.map((pane) => [pane.id, pane])), entries: state?.entries ?? [] };
}

async function readAgent(agent: ChatAgent, dir: Awaited<ReturnType<typeof readPaneDir>> | undefined): Promise<AgentCard> {
  const card: AgentCard = {
    paneId: agent.paneId,
    panelId: agent.panelId,
    name: agent.name ?? agent.paneId,
    status: 'unknown',
    screen: [],
    link: buildPaneLink({ kind: 'pane', id: agent.paneId, panelId: agent.panelId || undefined }),
  };
  const pane = dir?.panes?.get(agent.paneId);
  // Archived Panes drop out of the list. Without a list, a failed read is a transient unknown.
  if (dir?.panes && !pane) return { ...card, status: 'gone' };
  if (pane) card.name = pane.name;
  if (pane?.repoName) card.repo = pane.repoName;
  const entry = dir?.entries.find((candidate) => candidate.panelId === agent.panelId);
  card.status = (entry && STATUS_BY_KIND.get(entry.kind)) ?? 'unknown';
  const [screen, git] = await Promise.all([
    agent.panelId
      ? invokeDaemon('runpane:panels:screen', [{ panelId: agent.panelId, limit: SCREEN_LINES * 3 }], panelScreenResultSchema, { paneDir: agent.paneDir }).catch(() => undefined)
      : undefined,
    invokeDaemon('sessions:get-git-status', [agent.paneId], gitStatusSchema, { paneDir: agent.paneDir }).catch(() => undefined),
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
    return { chats: {}, focus: {} };
  }
  try {
    const store = decodeBoundary(JSON.parse(raw), storeSchema);
    return {
      chats: Object.fromEntries(Object.entries(store.chats).map(([chat, agents]) => [chat, decodeBoundary(agents, boundary.array(chatAgentSchema))])),
      focus: Object.fromEntries(Object.entries(store.focus ?? {}).map(([chat, pane]) => [chat, decodeBoundary(pane, boundary.string)])),
    };
  } catch {
    return { chats: {}, focus: {} };
  }
}

function writeStore(store: Store): void {
  const file = storeFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(store, null, 2)}\n`);
}
