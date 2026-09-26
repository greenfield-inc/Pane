import type { GitStatus, Session as SharedSession, SessionOutput as SharedSessionOutput } from '../../../shared/types/session';
export type { GitStatus, CreateSessionRequest, ClaudeJsonMessage, MessageContent } from '../../../shared/types/session';

export type Session = SharedSession<Date, unknown>;
export type SessionOutput = SharedSessionOutput<Date, unknown>;

export interface SessionUpdate {
  status?: Session['status'];
  statusMessage?: string;
  lastActivity?: Date;
  error?: string;
  run_started_at?: string | null;
  model?: string;
  gitStatus?: GitStatus;
  skip_continue_next?: boolean;
}
