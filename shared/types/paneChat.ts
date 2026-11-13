import type { ToolPanel } from './panels';
import { CONFIGURED_AGENT_IDS, DEFAULT_AGENT_ID, configuredAgent, configuredAgentSchema, type ConfiguredAgentId } from '../agents';
import { decodeOptionalBoundary } from '../validation/boundaryDecoder';
import type { JsonValue } from '../validation/boundaryDecoder';

/** An agent a Session or the Onboarding Session can run: any configured agent. */
export type PaneChatAgent = ConfiguredAgentId;

// SAFETY: built from every configured agent id, so it has exactly the PaneChatAgent keys.
const labels = Object.fromEntries(CONFIGURED_AGENT_IDS.map(id => [id, configuredAgent(id).label])) as Record<PaneChatAgent, string>;
export const PANE_CHAT_AGENT_LABELS: Readonly<Record<PaneChatAgent, string>> = labels;

export const DEFAULT_PANE_CHAT_AGENT: PaneChatAgent = DEFAULT_AGENT_ID;
export const PANE_CHAT_SESSION_ID = '__pane_chat_session__';
export const PANE_CHAT_PANEL_ID = '__pane_chat_terminal__';
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

export interface PaneChatState<TSession = unknown> {
  session: TSession;
  panel: ToolPanel;
  agent: PaneChatAgent;
  cwd: string;
  guidePath: string;
  started: boolean;
}

export function normalizePaneChatAgent(value: JsonValue | undefined): PaneChatAgent {
  return decodeOptionalBoundary(value, configuredAgentSchema) ?? DEFAULT_PANE_CHAT_AGENT;
}

/** The Onboarding Session's terminal for an agent: the default agent keeps the first id it ever had. */
export function getPaneChatPanelId(agent: PaneChatAgent): string {
  return agent === DEFAULT_PANE_CHAT_AGENT ? PANE_CHAT_PANEL_ID : `__pane_chat_terminal_${agent}__`;
}
