import fs from 'node:fs';
import path from 'node:path';
import { boundary, decodeBoundary, type JsonObject } from './boundaryDecoder';
import { resolvePaneDirectory } from './daemonClient';

/**
 * The `chatgpt` toolset: a panel beside a ChatGPT chat that lists the agents that chat started.
 * It follows MCP Apps (`ui://` resource, `_meta.ui`) and OpenAI's extensions (`_meta["openai/ui"]`
 * entrypoints), written by hand because `@openai/mcp-extensions` targets SDK v1.
 */
export const CHAT_TOOLSET = 'chatgpt';

const PANEL_URI = 'ui://pane/panel.html';
const PANEL_MIME = 'text/html;profile=mcp-app';
// ChatGPT sends an anonymized chat id with each tool call. Hosts without one share this key.
const CHAT_META_KEY = 'openai/session';
const NO_CHAT = 'local';
const MAX_AGENTS_PER_CHAT = 12;
const SCREEN_LINES = 12;

const ICON_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.33" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3.5" width="14" height="13" rx="2"/><path d="M10 3.5v13M10 10h7"/></svg>';

type AgentStatus = 'working' | 'ready' | 'blocked' | 'idle' | 'exited' | 'unknown' | 'gone';

interface ChatAgent {
  paneId: string;
  panelId: string;
  name?: string;
  paneDir?: string;
}

interface PanelAgent {
  paneId: string;
  panelId: string;
  name: string;
  status: AgentStatus;
  lastLine: string;
  link: string;
}

type RunCli = (argv: string[]) => Promise<{ code: number; stdout: string; stderr: string }>;
type ToolResult = { content: { type: 'text'; text: string }[]; structuredContent?: JsonObject; isError?: boolean };

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
const statusSchema = boundary.object({
  paneName: boundary.optional(boundary.string),
  status: boundary.enumeration('working', 'ready', 'blocked', 'idle', 'exited', 'unknown'),
  screen: boundary.string,
  link: boundary.string,
});
const paneListSchema = boundary.object({ panes: boundary.array(boundary.object({ id: boundary.string })) });
const statusInputSchema = boundary.object({ chat: boundary.string });
const openInputSchema = boundary.object({ paneId: boundary.nonEmptyString, panelId: boundary.optional(boundary.nonEmptyString) });

const readOnly = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const appOnly = { ui: { resourceUri: PANEL_URI, visibility: ['app'] } };

interface PanelTool {
  name: string;
  title: string;
  description: string;
  inputSchema: { type: 'object'; properties: Record<string, { type: 'string' }>; required?: string[]; additionalProperties: false };
  annotations: { title: string; readOnlyHint: boolean; destructiveHint: boolean; idempotentHint: boolean; openWorldHint: boolean };
  icons?: { src: string; mimeType: string; sizes: string[] }[];
  _meta: JsonObject;
}

export const chatPanelTools: PanelTool[] = [
  {
    name: 'agents_panel',
    title: 'Chat agents',
    description: 'Show the Pane agents this chat started, with their live status, in a panel where the user can message them or open them in Pane. Takes no arguments.',
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
    name: 'agents_panel_status',
    title: 'Refresh chat agents',
    description: 'Refresh the agents panel. The panel passes the chat id from its first result.',
    inputSchema: { type: 'object', properties: { chat: { type: 'string' } }, required: ['chat'], additionalProperties: false },
    annotations: { title: 'Refresh chat agents', ...readOnly },
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
        ui: { domain: 'https://runpane.com', prefersBorder: false, csp: { connectDomains: [], resourceDomains: [] } },
        'openai/ui': { preferredDisplayMode: 'fullscreen', availableDisplayModes: ['inline', 'fullscreen'] },
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
  const chats = readChats();
  const kept = (chats[chat] ?? []).filter((entry) => entry.paneId !== paneId);
  chats[chat] = [...kept, agent].slice(-MAX_AGENTS_PER_CHAT);
  const file = chatsFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify({ chats }, null, 2)}\n`);
}

export async function callChatPanelTool(name: string, input: JsonObject, chat: string, run: RunCli): Promise<ToolResult> {
  if (name === 'agents_panel') return panelResult(chat, run);
  if (name === 'agents_panel_status') return panelResult(decodeBoundary(input, statusInputSchema).chat, run);
  const { paneId, panelId } = decodeBoundary(input, openInputSchema);
  const paneDir = Object.values(readChats()).flat().find((agent) => agent.paneId === paneId)?.paneDir;
  const argv = ['panes', 'focus', `--pane=${paneId}`, ...(panelId ? [`--panel=${panelId}`] : []), '--source=user', '--yes', '--json'];
  const { code, stdout, stderr } = await run(paneDir ? [...argv, `--pane-dir=${paneDir}`] : argv);
  const text = stdout.trim() || stderr.trim();
  return code === 0
    ? { content: [{ type: 'text', text: 'Opened in Pane.' }], structuredContent: { ok: true, paneId } }
    : { content: [{ type: 'text', text: text || 'Pane did not open the agent.' }], isError: true };
}

async function panelResult(chat: string, run: RunCli): Promise<ToolResult> {
  const started = readChats()[chat] ?? [];
  const paneDirs = [...new Set(started.map((agent) => agent.paneDir))];
  const openPanes = new Map(await Promise.all(paneDirs.map(async (paneDir) => [paneDir, await readOpenPaneIds(paneDir, run)] as const)));
  const agents = await Promise.all(started.map((agent) => (
    openPanes.get(agent.paneDir)?.has(agent.paneId) === false ? goneAgent(agent) : readAgent(agent, run)
  )));
  const summary = agents.length === 0
    ? 'This chat has not started any Pane agents yet.'
    : agents.map((agent) => `${agent.name}: ${agent.status}`).join('\n');
  return { content: [{ type: 'text', text: summary }], structuredContent: { chat, agents: agents.map((agent) => ({ ...agent })) } };
}

/** The ids of the Panes Pane still has open; archived Panes drop out. Undefined when Pane can't say. */
async function readOpenPaneIds(paneDir: string | undefined, run: RunCli): Promise<Set<string> | undefined> {
  const argv = ['panes', 'list', '--json'];
  const { code, stdout } = await run(paneDir ? [...argv, `--pane-dir=${paneDir}`] : argv);
  if (code !== 0) return undefined;
  try {
    return new Set(decodeBoundary(JSON.parse(stdout), paneListSchema).panes.map((pane) => pane.id));
  } catch {
    return undefined;
  }
}

function goneAgent(agent: ChatAgent): PanelAgent {
  return {
    paneId: agent.paneId,
    panelId: agent.panelId,
    name: agent.name ?? agent.paneId,
    status: 'gone',
    lastLine: '',
    link: `pane://open?pane=${encodeURIComponent(agent.paneId)}&panel=${encodeURIComponent(agent.panelId)}`,
  };
}

async function readAgent(agent: ChatAgent, run: RunCli): Promise<PanelAgent> {
  const argv = ['agents', 'status', `--panel=${agent.panelId}`, `--limit=${SCREEN_LINES}`, '--json'];
  const { code, stdout } = await run(agent.paneDir ? [...argv, `--pane-dir=${agent.paneDir}`] : argv);
  const fallback = goneAgent(agent);
  if (code !== 0) return fallback;
  try {
    const status = decodeBoundary(JSON.parse(stdout), statusSchema);
    const lastLine = status.screen.split('\n').map((line) => line.trim()).filter(Boolean).at(-1) ?? '';
    return { ...fallback, name: status.paneName ?? fallback.name, status: status.status, lastLine, link: status.link };
  } catch {
    return fallback;
  }
}

function chatsFile(): string {
  return path.join(resolvePaneDirectory(), 'chatgpt', 'chats.json');
}

function readChats(): Record<string, ChatAgent[]> {
  let raw: string;
  try {
    raw = fs.readFileSync(chatsFile(), 'utf8');
  } catch {
    return {};
  }
  try {
    const { chats } = decodeBoundary(JSON.parse(raw), boundary.object({ chats: boundary.jsonObject }));
    return Object.fromEntries(Object.entries(chats).map(([chat, agents]) => [chat, decodeBoundary(agents, boundary.array(chatAgentSchema))]));
  } catch {
    return {};
  }
}
