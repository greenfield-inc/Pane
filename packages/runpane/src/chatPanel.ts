import fs from 'node:fs';
import path from 'node:path';
import { STATUS_BY_KIND, type AgentStatus } from './agentTasks';
import { boundary, decodeBoundary, type JsonObject } from './boundaryDecoder';
import { invokeDaemon, resolvePaneDirectory } from './daemonClient';
import { buildPaneLink } from './links';
import { type AgentReport, panelListResultSchema, panelScreenResultSchema, workspaceStateResultSchema } from './localControl';

/**
 * The `chatgpt` toolset: Pane's agents as native UI in ChatGPT. Agent tool results render as
 * inline Pane cards, and a panel beside the chat lists the agents that chat started. It follows
 * MCP Apps (`ui://` resource, `_meta.ui`) and OpenAI's extensions (`_meta["openai/ui"]`
 * entrypoints), written by hand: they are a few `_meta` keys.
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
export const INLINE_CARD_TOOLS = new Set(['agents_start', 'agents_status', 'agents_send', 'panels_create']);
export const inlineCardMeta: JsonObject = { ui: { resourceUri: PANEL_URI } };
/** Tools whose agent joins the chat's list: a new Pane or tab, terminal or chat. */
export const STARTS_AGENT = new Set(['agents_start', 'panels_create']);

/** The server instructions ChatGPT gets: the tools it has, and what it leaves to the person in Pane. */
export const CHATGPT_INSTRUCTIONS = [
  'Pane runs coding agents on this computer, each in a Pane: 1 feature = 1 worktree = 1 branch = 1 Pane. Later agents on the same work (review, fixes, QA) are tabs in that Pane.',
  '- `agents_start` starts an agent on a task: in a new Pane for new work, or as a tab with `pane: <id>`. `panels_create` with `chat: true` opens Claude or Codex as a chat tab instead of a terminal. `agents_status` checks on an agent and `agents_send` sends it a message. Their results show as Pane cards, and `agents_panel` lists every agent this chat started.',
  '- What waits on the person: `autopilot_waiting` lists every approval and question waiting in Pane, on every machine (it needs Autopilot on; `autopilot_status` says whether it is). `inbox` lists a Session\'s reports and blocked agents; find Sessions with `sessions_list` and see one with `sessions_overview`.',
  '- Approvals are read-only here. The person answers them in Pane or on their phone. Never answer a permission or trust prompt: `agents_send` refuses while an agent shows a prompt, so tell the person to open it in Pane.',
  '- Discover before you change anything: repos from `repos_list`, Panes from `panes_list` or `workspace_state`.',
  '- Tools with a `yes` input change state. Pass `yes: true` only when the person asked for that change in this chat. `panes_archive` refuses when work would be lost; show the person what it flagged, and pass `force` only after they agree. `panes_restore` undoes an archive.',
  '- `links_create` returns a pane:// link that opens a Pane, tab or Session in Pane.',
  '- Before guessing how Pane works, call `docs_search`, then `docs_read` on a path it returns.',
].join('\n');

/** ChatGPT's limits on tools whose contract text is written for agents that have every tool. */
export const CHATGPT_TOOL_NOTES = new Map([
  ['agents_send', 'In ChatGPT: sends a message only. It refuses while the agent shows a prompt or menu (status blocked), such as a permission or trust prompt; the person answers that in Pane.'],
  ['panels_create', 'In ChatGPT: use it to open a chat tab (`chat: true` with `agent` claude or codex) or an Agent Farm profile. For a terminal agent, use `agents_start` with `pane`. The new tab joins this chat\'s agents.'],
  ['autopilot_waiting', 'In ChatGPT: read-only. Answering, closing and rewriting items are Autopilot\'s own commands; the person answers in Pane or on their phone.'],
  ['inbox', 'In ChatGPT: read-only. Pass `session`; clearing items is the Session orchestrator\'s job.'],
  ['panes_archive', 'In ChatGPT: pass `force` only after the person agrees to lose what the safety check flagged.'],
]);

/**
 * The only stored state: which agents each chat started, as Pane and panel ids in start order.
 * The panel id tells apart agents started as tabs in one Pane. Pane has no record of the ChatGPT
 * chat behind an agent, so this can't be derived. Everything else on a card (name, repo, status,
 * screen, report, PR, diff) is read from Pane on each refresh.
 */
type ChatAgent = { paneId: string; panelId: string };
type Store = Record<string, ChatAgent[]>;

/** The agent (panel id) each chat's panel shows, set by agents_panel_focus. View state, so memory only. */
const focusByChat = new Map<string, string>();

interface AgentCard {
  paneId: string;
  panelId: string;
  name: string;
  status: AgentStatus | 'gone';
  screen: string[];
  link: string;
  repo?: string;
  /** A chat tab (ACP, no terminal): its screen is the conversation. */
  chat?: boolean;
  report?: Pick<AgentReport, 'state' | 'summary' | 'question'>;
  diff?: { adds: number; dels: number };
  pr?: { number: number; draft: boolean; title?: string; state?: string; url?: string };
}

type ToolResult = { content: { type: 'text'; text: string }[]; structuredContent?: JsonObject; isError?: boolean };

// agents_start output, possibly from a failed start that still created a Pane.
const startedSchema = boundary.object({ paneId: boundary.optional(boundary.string), panelId: boundary.optional(boundary.string) });
const chatAgentSchema = boundary.object({ paneId: boundary.string, panelId: boundary.string });
const focusedSchema = boundary.object({ paneId: boundary.string });
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
      properties: { pane: { type: 'string', description: 'The agent\'s panel id, Pane id or name, from agents_start or agents_panel.' } },
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
        // With both modes listed and no preference, ChatGPT opens fullscreen; agent cards belong inline.
        'openai/ui': { preferredDisplayMode: 'inline', availableDisplayModes: ['inline', 'fullscreen'] },
      },
    }],
  };
}

/** The chat a tool call came from, read from the request's `_meta`. */
export function chatIdOf(meta: JsonObject): string {
  return decodeBoundary(meta, chatMetaSchema)[CHAT_META_KEY] || NO_CHAT;
}

/** Remembers the agent that `agents_start` started from this chat, in a new Pane or as a tab. */
export function recordStartedAgent(chat: string, output: JsonObject): void {
  const { paneId, panelId } = decodeBoundary(output, startedSchema);
  if (!paneId || !panelId) return;
  const store = readStore();
  store[chat] = [...(store[chat] ?? []).filter((agent) => agent.panelId !== panelId), { paneId, panelId }].slice(-MAX_AGENTS_PER_CHAT);
  writeStore(store);
}

export async function callChatPanelTool(name: string, input: JsonObject, chat: string): Promise<ToolResult> {
  if (name === 'agents_panel') return panelResult(chat);
  if (name === 'agents_panel_status') return panelResult(decodeBoundary(input, statusInputSchema).chat);
  if (name === 'agents_panel_focus') return focusResult(chat, decodeBoundary(input, focusInputSchema).pane);
  if (name === 'agents_card') return cardResult(decodeBoundary(input, cardInputSchema));
  const { paneId, panelId } = decodeBoundary(input, openInputSchema);
  try {
    // A click in the panel is the user's own request, like `runpane panes focus --source user`.
    await invokeDaemon('runpane:panes:focus', [{ paneId, panelId, source: 'user' }], focusedSchema);
    return { content: [{ type: 'text', text: 'Opened in Pane.' }], structuredContent: { ok: true, paneId } };
  } catch (error) {
    return { content: [{ type: 'text', text: error instanceof Error ? error.message : 'Pane did not open the agent.' }], isError: true };
  }
}

const sendTargetSchema = boundary.object({ pane: boundary.optional(boundary.string), panel: boundary.optional(boundary.string) });

/**
 * ChatGPT never answers a permission, trust or question prompt. Pane types a message into a
 * prompt that has no composer as keys, which answers it, so agents_send is refused while its
 * target shows one. When Pane can't be read, the send goes ahead and fails there.
 */
export async function refusePromptAnswer(input: JsonObject): Promise<ToolResult | undefined> {
  const { pane, panel } = decodeBoundary(input, sendTargetSchema);
  const [state, list] = await Promise.all([
    invokeDaemon('runpane:workspace:state', [{}], workspaceStateResultSchema).catch(() => undefined),
    !panel && pane ? invokeDaemon('runpane:panels:list', [{ paneId: pane }], panelListResultSchema).catch(() => undefined) : undefined,
  ]);
  // The same tab agents_send picks: the panel given, else the Pane's agent tab, else its first tab.
  const panelId = panel ?? (list?.panels.find((candidate) => candidate.isCliPanel || candidate.agentType) ?? list?.panels[0])?.panelId;
  const entry = state?.entries.find((candidate) => candidate.panelId === panelId);
  if (!panelId || entry?.kind !== 'agent.blocked') return undefined;
  const text = 'The agent is showing a prompt in its terminal, such as a permission or trust prompt, so nothing was sent: '
    + 'a message would answer it. Open the agent in Pane and answer it there, then send the message again.';
  // agents_send's own result shape, so its output schema holds.
  return { content: [{ type: 'text', text }], structuredContent: { ok: false, paneId: entry.paneId, panelId, delivered: false, blocked: text }, isError: true };
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
  // An id or exact name wins; otherwise every word the user said must appear in one agent's name.
  const words = pane.toLowerCase().split(/[\s_-]+/).filter(Boolean);
  const byWords = agents.filter((entry) => words.every((word) => entry.name.toLowerCase().split(/[\s_-]+/).includes(word)));
  const agent = agents.find((entry) => entry.panelId === pane || entry.paneId === pane || entry.name === pane) ?? (byWords.length === 1 ? byWords[0] : undefined);
  if (!agent) {
    const names = agents.map((entry) => entry.name).join(', ') || 'none yet';
    const why = byWords.length > 1 ? `More than one agent matches ${pane}` : `This chat didn't start an agent called ${pane}`;
    return { content: [{ type: 'text', text: `${why}. Agents this chat started: ${names}.` }], isError: true };
  }
  focusByChat.set(chat, agent.panelId);
  return cardResultOf(agent, offline);
}

async function cardResult(agent: { paneId: string; panelId?: string }): Promise<ToolResult> {
  const { agents: [card], offline } = await readAgents([agent]);
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
  const { repo, report, diff, pr, ...required } = card;
  const json: JsonObject = { ...required };
  if (repo) json.repo = repo;
  if (report) json.report = { ...report };
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
 * Each agent's card data, read from the Pane daemon. `offline` means Pane didn't answer, including
 * when the chat has no agents yet.
 */
async function readAgents(started: { paneId: string; panelId?: string }[]): Promise<{ agents: AgentCard[]; offline: boolean }> {
  const [panes, state] = await Promise.all([
    invokeDaemon('runpane:panes:list', [{}], paneListSchema).catch(() => undefined),
    invokeDaemon('runpane:workspace:state', [{}], workspaceStateResultSchema).catch(() => undefined),
  ]);
  const workspace = { panes: panes && new Map(panes.panes.map((pane) => [pane.id, pane])), entries: state?.entries ?? [] };
  const offline = !panes && !state;
  // The first agent in a Pane goes by the Pane's name; a later tab adds its title, numbered if titles repeat.
  const agents = await Promise.all(started.map((agent, index) => (
    readAgent(agent, workspace, started.findIndex((other) => other.paneId === agent.paneId) !== index)
  )));
  const seen = new Map<string, number>();
  for (const agent of agents) {
    const count = (seen.get(agent.name) ?? 0) + 1;
    seen.set(agent.name, count);
    if (count > 1) agent.name = `${agent.name} ${count}`;
  }
  return { agents, offline };
}

type Workspace = { panes?: Map<string, { name: string; repoName?: string }>; entries: { kind: string; panelId?: string; paneId: string }[] };

async function readAgent({ paneId, panelId: knownPanelId }: { paneId: string; panelId?: string }, workspace: Workspace, laterTab: boolean): Promise<AgentCard> {
  const pane = workspace.panes?.get(paneId);
  const card: AgentCard = { paneId, panelId: knownPanelId ?? '', name: pane?.name ?? paneId, status: 'unknown', screen: [], link: buildPaneLink({ kind: 'pane', id: paneId }) };
  // Archived Panes drop out of the list. Without a list, a failed read is a transient unknown.
  if (workspace.panes && !pane) return { ...card, status: 'gone' };
  if (pane?.repoName) card.repo = pane.repoName;
  const panels = (await invokeDaemon('runpane:panels:list', [{ paneId }], panelListResultSchema).catch(() => undefined))?.panels;
  // The agent's terminal: the panel it started in, else the Pane's CLI agent tab, else its first terminal.
  const panel = knownPanelId
    ? panels?.find((candidate) => candidate.panelId === knownPanelId)
    : panels?.find((candidate) => candidate.isCliPanel || candidate.agentType) ?? panels?.find((candidate) => candidate.type === 'terminal');
  // A closed tab is gone, like an archived Pane.
  if (panels && knownPanelId && !panel) return { ...card, status: 'gone' };
  const panelId = panel?.panelId ?? knownPanelId;
  if (panelId) {
    card.panelId = panelId;
    card.link = buildPaneLink({ kind: 'pane', id: paneId, panelId });
  }
  if (laterTab && panel?.title) card.name = `${card.name} · ${panel.title}`;
  if (panel?.type === 'chat') card.chat = true;
  if (panel?.report) {
    const { state, summary, question } = panel.report;
    card.report = { state };
    if (summary) card.report.summary = summary;
    if (question) card.report.question = question;
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
    return Object.fromEntries(Object.entries(chats).map(([chat, agents]) => [chat, decodeBoundary(agents, boundary.array(chatAgentSchema))]));
  } catch {
    return {};
  }
}

function writeStore(chats: Store): void {
  const file = storeFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify({ chats }, null, 2)}\n`);
}
