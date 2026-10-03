import type { PaneChatAgent } from './paneChat';

export type DefaultAgentLaunchResult =
  | {
    status: 'launched';
    agentType: PaneChatAgent;
    agentTitle: string;
    initialCommand: string;
    sessionId: string;
    panelId: string;
  }
  | {
    status: 'skipped';
    /** The automatic launch requires a disclosed agent id that exactly matches the resolved preset. */
    reason: 'no-default' | 'already-launched' | 'disclosure-mismatch';
  }
  | {
    status: 'failed';
    agentType: PaneChatAgent;
    agentTitle: string;
    initialCommand: string;
    reason: 'validation-failed' | 'launch-error';
    message: string;
  };
