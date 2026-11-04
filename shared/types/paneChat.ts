import type { ToolPanel } from './panels';
import { boundary, decodeBoundary } from '../validation/boundaryDecoder';
import type { JsonValue } from '../validation/boundaryDecoder';

export type PaneChatAgent = 'claude' | 'codex' | 'cursor';

export const PANE_CHAT_AGENT_LABELS = {
  claude: 'Claude',
  codex: 'Codex',
  cursor: 'Cursor',
} satisfies Record<PaneChatAgent, string>;

export const DEFAULT_PANE_CHAT_AGENT: PaneChatAgent = 'claude';
export const PANE_CHAT_SESSION_ID = '__pane_chat_session__';
export const PANE_CHAT_PANEL_ID = '__pane_chat_terminal__';
export const PANE_CHAT_CODEX_PANEL_ID = '__pane_chat_terminal_codex__';
export const PANE_CHAT_CURSOR_PANEL_ID = '__pane_chat_terminal_cursor__';
/**
 * How every one-time first prompt Pane gives a Session agent begins. Session
 * launches drop any saved first prompt, except an unsent one that begins with this.
 */
export const PANE_ONE_TIME_PROMPT_OPENING = 'Pane sent this once';
/** How the Onboarding Session's one-time first prompt begins. */
export const PANE_CHAT_MIGRATE_OFFER_OPENING = `${PANE_ONE_TIME_PROMPT_OPENING}, the first time the Onboarding Session started with this Pane data folder:`;
/** What the person answered on the first-run screen; main turns it into the Onboarding Session's first prompt. */
export const ONBOARDING_HANDOFF_PREFERENCE = 'onboarding_handoff';
/** `migrate`: Yes to bringing agent sessions in. `project`: Not now, or nothing found, so they open a project. */
export type OnboardingHandoff = 'migrate' | 'project';
/** The default Session's name on a new data folder; existing installs keep "Pane Chat". */
export const ONBOARDING_SESSION_NAME = 'Onboarding';

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
    return decodeBoundary(value, boundary.enumeration('claude', 'codex', 'cursor'));
  } catch {
    return DEFAULT_PANE_CHAT_AGENT;
  }
}

export function getPaneChatPanelId(agent: PaneChatAgent): string {
  return PANE_CHAT_PANEL_IDS[agent];
}
