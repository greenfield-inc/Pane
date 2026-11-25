import type { ConfiguredAgentId } from '../agents';

/** Where a start link's prompt runs. */
export type StartLinkTarget =
  | { kind: 'new-session' }
  | { kind: 'repo'; repoId: number; repoName: string; /** `host/owner/repo` of its origin, or null. */ identity: string | null }
  | { kind: 'session'; sessionId: string; sessionName: string; /** The Session's own agent; a link's agent does not change it. */ agent: ConfiguredAgentId };

export interface StartLinkAgentOption {
  id: ConfiguredAgentId;
  label: string;
  installed: boolean;
}

/**
 * `pane:start-link-request`: main asks the main window to confirm a `pane://new` link. Nothing
 * starts until the person presses Start there; main accepts one answer, for this `requestId`.
 */
export interface StartLinkRequest {
  requestId: string;
  /** The prompt exactly as the agent will get it. */
  prompt: string;
  /** Every configured agent, installed ones first. */
  agents: StartLinkAgentOption[];
  /** The agent preselected: the link's, else the person's default if installed, else the first installed. */
  agent: ConfiguredAgentId;
  /** The agent the link named, or null when it named none. */
  linkAgent: ConfiguredAgentId | null;
  /** Where it can run; the link's own target first. */
  targets: StartLinkTarget[];
}

/** `pane:start-link-answer`: the person's answer. Anything not matching the request counts as Cancel. */
export interface StartLinkAnswer {
  requestId: string;
  start: boolean;
  agent?: ConfiguredAgentId;
  /** Index into the request's `targets`. */
  target?: number;
}

export const START_LINK_REQUEST_CHANNEL = 'pane:start-link-request';
export const START_LINK_ANSWER_CHANNEL = 'pane:start-link-answer';
/** The request waiting for an answer, or null; the dialog asks on mount so none is missed. */
export const START_LINK_PENDING_CHANNEL = 'pane:start-link-pending';
