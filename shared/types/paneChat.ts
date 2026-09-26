import { cliAgentSchema, type CliAgentType } from './cli-agent';
import type { ToolPanel } from './panels';
import { decodeBoundary } from '../validation/boundaryDecoder';
import type { JsonValue } from '../validation/boundaryDecoder';

export type PaneChatAgent = CliAgentType;

export const DEFAULT_PANE_CHAT_AGENT: PaneChatAgent = 'claude';
export const PANE_CHAT_SESSION_ID = '__pane_chat_session__';
export const PANE_CHAT_PANEL_ID = '__pane_chat_terminal__';
export const PANE_CHAT_CODEX_PANEL_ID = '__pane_chat_terminal_codex__';
export const PANE_CHAT_CURSOR_PANEL_ID = '__pane_chat_terminal_cursor__';

const PANE_CHAT_PANEL_IDS = {
  claude: PANE_CHAT_PANEL_ID,
  codex: PANE_CHAT_CODEX_PANEL_ID,
  cursor: PANE_CHAT_CURSOR_PANEL_ID,
} satisfies Record<PaneChatAgent, string>;

export interface PaneChatState<TSession = unknown> {
  session: TSession;
  panel: ToolPanel;
  agent: PaneChatAgent;
  cwd: string;
  guidePath: string;
  started: boolean;
}

export function normalizePaneChatAgent(value: JsonValue | undefined): PaneChatAgent {
  try {
    return decodeBoundary(value, cliAgentSchema);
  } catch {
    return DEFAULT_PANE_CHAT_AGENT;
  }
}

export function getPaneChatPanelId(agent: PaneChatAgent): string {
  return PANE_CHAT_PANEL_IDS[agent];
}
